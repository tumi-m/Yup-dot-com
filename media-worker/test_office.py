"""
Tests for office.py (Word and Excel to PDF) and its route in worker.py.

    npm run test:office     (python3 -m unittest discover -s media-worker -p "test_*.py")

The checks on what a file really is need only Python. The conversions need
LibreOffice and its UNO bridge (soffice, and python3-uno for OFFICE_PYTHON,
default /usr/bin/python3) and are skipped without them; pdftotext and
pdffonts (poppler-utils) are used to read the PDFs where installed.

Every input is built here: minimal .docx, .xlsx and .odt packages, CSV and
RTF text, compound files shaped like encrypted Office files, and, with
LibreOffice, .doc and .xls copies and real password-protected files.
"""

import base64
import hashlib
import hmac
import http.client
import io
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import zipfile
from http.server import ThreadingHTTPServer

SECRET = "office-test-" + secrets.token_hex(8)
os.environ["MEDIA_WORKER_SECRET"] = SECRET

import office  # noqa: E402

try:
    import yt_dlp  # noqa: F401
except ImportError:
    # The worker imports yt-dlp for downloads; these tests never download.
    stub = types.ModuleType("yt_dlp")
    stub.utils = types.SimpleNamespace(DownloadError=type("DownloadError", (Exception,), {}))
    stub.version = types.SimpleNamespace(__version__="stub")
    stub.YoutubeDL = None
    sys.modules["yt_dlp"] = stub
import worker  # noqa: E402

HAVE_OFFICE = office.health()["ready"]
PDFTOTEXT = shutil.which("pdftotext")
PDFFONTS = shutil.which("pdffonts")
needs_office = unittest.skipUnless(HAVE_OFFICE, "LibreOffice with python3-uno isn't installed")

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
DOCM_MAIN = "application/vnd.ms-word.document.macroEnabled.main+xml"
SHEET_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def content_types(overrides: dict) -> str:
    parts = "".join(f'<Override PartName="{k}" ContentType="{v}"/>' for k, v in overrides.items())
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>' + parts + "</Types>"
    )


def rels(target: str, kind: str = REL_DOC) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="{kind}" Target="{target}"/></Relationships>'
    )


def docx(paragraphs=("Hello from a test document.",), main=WORD_MAIN, extra: dict | None = None, table=None) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    if table:
        border = "".join(f'<w:{s} w:val="single" w:sz="4"/>' for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
        rows = "".join(
            "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row) + "</w:tr>" for row in table
        )
        body += f"<w:tbl><w:tblPr><w:tblBorders>{border}</w:tblBorders></w:tblPr>{rows}</w:tbl><w:p/>"
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types({"/word/document.xml": main}))
        z.writestr("_rels/.rels", rels("word/document.xml"))
        z.writestr("word/document.xml", document)
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


def xlsx(sheets: dict) -> bytes:
    """{sheet name: rows}; strings inline, numbers as values."""
    names = list(sheets)
    over = {"/xl/workbook.xml": SHEET_MAIN}
    for i in range(len(names)):
        over[f"/xl/worksheets/sheet{i + 1}.xml"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + "".join(f'<sheet name="{n}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names))
        + "</sheets></workbook>"
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
            for i in range(len(names))
        )
        + "</Relationships>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types(over))
        z.writestr("_rels/.rels", rels("xl/workbook.xml"))
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        for i, n in enumerate(names):
            out = []
            for r, row in enumerate(sheets[n], start=1):
                cells = []
                for c, v in enumerate(row):
                    ref = f"{chr(65 + c % 26) if c < 26 else 'A' + chr(65 + c - 26)}{r}"
                    if isinstance(v, (int, float)):
                        cells.append(f'<c r="{ref}"><v>{v}</v></c>')
                    else:
                        cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>')
                out.append(f'<row r="{r}">{"".join(cells)}</row>')
            z.writestr(
                f"xl/worksheets/sheet{i + 1}.xml",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                + "".join(out)
                + "</sheetData></worksheet>",
            )
    return buf.getvalue()


ODF_NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink"'
)


def odf(mimetype: str, body: str, manifest_extra: str = "") -> bytes:
    content = f'<?xml version="1.0" encoding="UTF-8"?><office:document-content {ODF_NS} office:version="1.3"><office:body>{body}</office:body></office:document-content>'
    manifest = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
        f'<manifest:file-entry manifest:full-path="/" manifest:media-type="{mimetype}"/>'
        f'<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">{manifest_extra}</manifest:file-entry>'
        "</manifest:manifest>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), mimetype)
        z.writestr("META-INF/manifest.xml", manifest)
        z.writestr("content.xml", content)
    return buf.getvalue()


def odt(text: str = "Hello from an OpenDocument text.") -> bytes:
    return odf("application/vnd.oasis.opendocument.text", f"<office:text><text:p>{text}</text:p></office:text>")


def ods(rows) -> bytes:
    trs = "".join(
        "<table:table-row>"
        + "".join(
            f'<table:table-cell office:value-type="float" office:value="{v}"><text:p>{v}</text:p></table:table-cell>'
            if isinstance(v, (int, float))
            else f'<table:table-cell office:value-type="string"><text:p>{v}</text:p></table:table-cell>'
            for v in row
        )
        + "</table:table-row>"
        for row in rows
    )
    return odf("application/vnd.oasis.opendocument.spreadsheet", f'<office:spreadsheet><table:table table:name="One">{trs}</table:table></office:spreadsheet>')


RTF = rb"{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}\f0\fs24 Hello from {\b RTF}.\par Second line.\par}"
CSV = "Name,Code,Joined\nThandi Nkosi,007,03/04/2025\nPieter van Wyk,0123,2025-12-01\n".encode()


def cfb(streams: dict) -> bytes:
    """A minimal compound file (the container of .doc, .xls and encrypted
    .docx/.xlsx). Streams are padded to 4096 bytes, so all sit in regular
    sectors; directory entries are chained as right siblings."""
    ss, end, free = 512, 0xFFFFFFFE, 0xFFFFFFFF
    sectors, fat = [], []

    def chain(data: bytes) -> int:
        start = len(sectors)
        n = max(1, -(-len(data) // ss))
        for i in range(n):
            sectors.append(data[i * ss:(i + 1) * ss].ljust(ss, b"\0"))
            fat.append(start + i + 1 if i < n - 1 else end)
        return start

    def entry(name: str, kind: int, start: int, size: int, right: int, child: int) -> bytes:
        raw = name.encode("utf-16-le") + b"\0\0"
        return (raw.ljust(64, b"\0") + struct.pack("<HBB", len(raw), kind, 1)
                + struct.pack("<III", free, right, child) + b"\0" * 36 + struct.pack("<IQ", start, size))

    names = list(streams)
    entries = [entry("Root Entry", 5, end, 0, free, 1 if names else free)]
    for i, name in enumerate(names):
        data = streams[name].ljust(4096, b"\0")
        entries.append(entry(name, 2, chain(data), len(data), i + 2 if i + 1 < len(names) else free, free))
    dir_start = chain(b"".join(entries))
    n_fat = 1
    while n_fat * (ss // 4) < len(sectors) + n_fat:
        n_fat += 1
    fat_sectors = list(range(len(sectors), len(sectors) + n_fat))
    fat += [0xFFFFFFFD] * n_fat
    fat_bytes = struct.pack(f"<{len(fat)}I", *fat).ljust(n_fat * ss, b"\xff")
    header = (office.OLE_MAGIC + b"\0" * 16 + struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\0" * 6
              + struct.pack("<IIIIIIIII", 0, n_fat, dir_start, 0, 4096, end, 0, end, 0)
              + struct.pack("<109I", *(fat_sectors + [free] * (109 - n_fat))))
    return header + b"".join(sectors) + fat_bytes


def word97(flags: int) -> bytes:
    fib = struct.pack("<HHHHHH", 0xA5EC, 0xC1, 0, 0, 0, flags)
    return cfb({"WordDocument": fib, "1Table": b"\0" * 16})


def excel97(filepass: bool) -> bytes:
    records = struct.pack("<HH", 0x0809, 16) + b"\0" * 16
    if filepass:
        records += struct.pack("<HH", 0x002F, 6) + b"\x01\0\x01\0\x01\0"
    records += struct.pack("<HH", 0x000A, 0)
    return cfb({"Workbook": records})


def office_tool(args, profile_dir, timeout=120):
    """soffice on the command line, with a profile of its own."""
    return subprocess.run(
        [office.SOFFICE, f"-env:UserInstallation=file://{profile_dir}", "--headless", "--norestore", *args],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout,
    )


LOCK_SCRIPT = r"""
import os, subprocess, sys, time, uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException
def pv(k, v):
    p = PropertyValue(); p.Name, p.Value = k, v; return p
soffice, profile, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
pipe = "pwlock%d" % os.getpid()
proc = subprocess.Popen([soffice, "--headless", "--norestore", "-env:UserInstallation=file://" + profile, "--accept=pipe,name=%s;urp;" % pipe],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
local = uno.getComponentContext()
res = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
for _ in range(300):
    try:
        ctx = res.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe); break
    except NoConnectException:
        time.sleep(0.1)
desk = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
for i in range(0, len(pairs), 3):
    src, dst, flt = pairs[i:i + 3]
    doc = desk.loadComponentFromURL("file://" + src, "_blank", 0, (pv("Hidden", True),))
    doc.storeToURL("file://" + dst, (pv("FilterName", flt), pv("Password", "secret")))
    doc.close(True)
try:
    desk.terminate()
except Exception:
    pass
proc.wait(20)
"""


def sign(payload: dict, ttl: int = 120, key: bytes | None = None) -> str:
    """A token as the web app makes it (lib/media-server.ts signToken with the conversion key)."""
    body = dict(payload, e=int(time.time()) + ttl)
    raw = base64.urlsafe_b64encode(json.dumps(body).encode()).rstrip(b"=").decode()
    sig = hmac.new(key or office.TOKEN_KEY, raw.encode(), hashlib.sha256).digest()
    return f"{raw}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def grant(ext: str, size: int, **opts) -> dict:
    return {"k": "office", "x": ext, "z": size, "o": opts, "s": "ip:test", "c": secrets.token_urlsafe(12), "t": int(time.time())}


def soffice_processes(marker: str) -> list:
    """Processes whose command line names `marker` (a job directory)."""
    found = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read()
        except OSError:
            continue
        if marker.encode() in cmd and (b"soffice" in cmd or b"--uno" in cmd):
            found.append(int(pid))
    return found


INPUTS: dict = {}


def setUpModule():
    """Builds the inputs once, for every test class."""
    folder = tempfile.mkdtemp(prefix="pw-office-test-")
    os.chmod(folder, 0o755)
    files = {
        "docx": docx(
            ["Quarterly figures for the board.", "Second paragraph with café and naïve."],
            table=[("Region", "Units", "Revenue"), ("North", "120", "R 12,400"), ("South", "95", "R 9,870")],
        ),
        "xlsx": xlsx({"First": [("Name", "Units"), ("North", 120), ("South", 95)], "Second": [("Only on the second sheet",)]}),
        "odt": odt(),
        "ods": ods([("Name", "Units"), ("North", 120)]),
        "rtf": RTF,
        "csv": CSV,
        "long.docx": docx([f"Paragraph {i}: " + "the quick brown fox jumps over the lazy dog. " * 6 for i in range(2500)]),
    }
    paths = {}
    for ext, data in files.items():
        paths[ext] = os.path.join(folder, ext if "." in ext else f"sample.{ext}")
        with open(paths[ext], "wb") as f:
            f.write(data)
    if HAVE_OFFICE:
        profile = tempfile.mkdtemp(prefix="pw-office-profile-")
        try:
            office_tool(["--convert-to", "doc", "--outdir", folder, paths["docx"]], profile)
            office_tool(["--convert-to", "xls", "--outdir", folder, paths["xlsx"]], profile)
            paths["doc"] = os.path.join(folder, "sample.doc")
            paths["xls"] = os.path.join(folder, "sample.xls")
            pairs = []
            for src, ext, flt in (("docx", "docx", "MS Word 2007 XML"), ("xlsx", "xlsx", "Calc MS Excel 2007 XML"),
                                  ("docx", "doc", "MS Word 97"), ("odt", "odt", "writer8")):
                pairs += [paths[src], os.path.join(folder, f"locked.{ext}"), flt]
            subprocess.run([office.UNO_PYTHON, "-c", LOCK_SCRIPT, office.SOFFICE, profile, *pairs],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        finally:
            shutil.rmtree(profile, ignore_errors=True)
    INPUTS.update(dir=folder, files=files, paths=paths)


def tearDownModule():
    shutil.rmtree(INPUTS["dir"], ignore_errors=True)


class Files(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir, cls.files, cls.paths = INPUTS["dir"], INPUTS["files"], INPUTS["paths"]

    @classmethod
    def write(cls, name: str, data: bytes) -> str:
        path = os.path.join(cls.dir, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def refused(self, data_or_path, ext: str) -> office.Refused:
        path = data_or_path if isinstance(data_or_path, str) else self.write(f"case-{secrets.token_hex(4)}.{ext}", data_or_path)
        job = tempfile.mkdtemp(prefix="pw-office-case-")
        try:
            src = os.path.join(job, f"input.{ext}")
            shutil.copy(path, src)
            with self.assertRaises(office.Refused) as caught:
                office.inspect(src, ext)
            return caught.exception
        finally:
            shutil.rmtree(job, ignore_errors=True)


class Inspect(Files):
    def test_real_files_pass(self):
        for ext in ("docx", "xlsx", "odt", "ods", "rtf", "csv", "doc", "xls"):
            if ext not in self.paths:
                continue
            with self.subTest(ext=ext):
                office.inspect(self.paths[ext], ext)

    def test_wrong_extension(self):
        cases = [
            (self.files["docx"], "xlsx", "This is a Word file, not an Excel file. Use Word to PDF."),
            (self.files["xlsx"], "docx", "This is an Excel file, not a Word file. Use Excel to PDF."),
            (self.files["odt"], "docx", "This is a .odt file with a .docx name. Rename it to .odt and try again."),
            (self.files["docx"], "odt", "This is a .docx file with a .odt name. Rename it to .docx and try again."),
            (self.files["docx"], "doc", "This is a .docx file with a .doc name. Rename it to .docx and try again."),
            (self.files["odt"], "ods", "This is a Word file, not an Excel file. Use Word to PDF."),
            (RTF, "doc", "This is an RTF file with a .doc name. Rename it to .rtf and try again."),
            (b"%PDF-1.7\n%\xe2\xe3\n1 0 obj", "docx", "This is a PDF, not a real .docx file."),
            (b"\x89PNG\r\n\x1a\n" + b"\0" * 64, "csv", "This is a picture, not a real .csv file."),
            (CSV, "rtf", "This file isn't a real .rtf file. It may be another kind of file renamed."),
            (CSV, "xlsx", "This file isn't a real .xlsx file. It may be another kind of file renamed."),
            (word97(0), "xls", "This is a Word file, not an Excel file. Use Word to PDF."),
            (word97(0), "docx", "This is a .doc file with a .docx name. Rename it to .doc and try again."),
        ]
        for data, ext, message in cases:
            with self.subTest(ext=ext, message=message):
                e = self.refused(data, ext)
                self.assertEqual((e.code, e.message), ("mismatch", message))
        pptx = io.BytesIO()
        with zipfile.ZipFile(pptx, "w") as z:
            z.writestr("[Content_Types].xml", content_types({"/ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}))
        self.assertEqual(self.refused(pptx.getvalue(), "docx").message, "This is a PowerPoint file, not a Word file. Use PPTX to PDF.")
        plain = io.BytesIO()
        with zipfile.ZipFile(plain, "w") as z:
            z.writestr("notes.txt", "just a zip")
        self.assertEqual(self.refused(plain.getvalue(), "xlsx").message, "This is a zip archive, not a real .xlsx file.")

    def test_damaged(self):
        broken = self.files["docx"][: len(self.files["docx"]) // 2]
        self.assertEqual(self.refused(broken, "docx").code, "damaged")
        self.assertEqual(self.refused(office.OLE_MAGIC + b"\0" * 100, "doc").code, "damaged")

    def test_encrypted_compound_files(self):
        # How Office stores a password-protected .docx or .xlsx.
        locked = cfb({"EncryptionInfo": b"\x04\0\x04\0\x40\0\0\0", "EncryptedPackage": b"\x10\0\0\0\0\0\0\0"})
        for ext in ("docx", "xlsx"):
            self.assertEqual(self.refused(locked, ext).code, "encrypted")
        self.assertEqual(self.refused(word97(0x0100), "doc").code, "encrypted")
        self.assertEqual(self.refused(word97(0x8000), "doc").code, "encrypted")
        self.assertEqual(self.refused(excel97(True), "xls").code, "encrypted")
        office.inspect(self.write("plain.doc", word97(0)), "doc")
        office.inspect(self.write("plain.xls", excel97(False)), "xls")
        manifest = '<manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="x"/>'
        locked_odt = odf("application/vnd.oasis.opendocument.text", "<office:text/>", manifest)
        self.assertEqual(self.refused(locked_odt, "odt").code, "encrypted")

    @needs_office
    def test_encrypted_by_libreoffice(self):
        for ext in ("docx", "xlsx", "doc", "odt"):
            path = os.path.join(self.dir, f"locked.{ext}")
            with self.subTest(ext=ext):
                self.assertTrue(os.path.exists(path), "LibreOffice didn't save the locked copy")
                e = self.refused(path, ext)
                self.assertEqual(e.code, "encrypted")
                self.assertIn("password-protected", e.message)

    def test_macros(self):
        # A .docm renamed .docx: its main part says macro-enabled.
        docm = docx(main=DOCM_MAIN, extra={"word/vbaProject.bin": cfb({"VBA": b"Attribute"})})
        e = self.refused(docm, "docx")
        self.assertEqual((e.code, e.message), ("macros", "This is a macro-enabled file (.docm). Save it as .docx without macros and try again."))
        # Macros added to a plain .docx.
        self.assertEqual(self.refused(docx(extra={"word/vbaProject.bin": b"x"}), "docx").code, "macros")
        buf = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(self.files["xlsx"])) as src, zipfile.ZipFile(buf, "w") as out:
            for name in src.namelist():
                data = src.read(name)
                if name == "[Content_Types].xml":
                    data = data.replace(SHEET_MAIN.encode(), b"application/vnd.ms-excel.sheet.macroEnabled.main+xml")
                out.writestr(name, data)
        self.assertEqual(self.refused(buf.getvalue(), "xlsx").message, "This is a macro-enabled file (.xlsm). Save it as .xlsx without macros and try again.")

    def test_zip_bombs(self):
        saved = office.MAX_UNZIPPED, office.MAX_ENTRIES
        office.MAX_UNZIPPED, office.MAX_ENTRIES = 20 * office.MB, 200
        try:
            # Says how big it is.
            bomb = docx(extra={"word/media/zeros.bin": b"\0" * (30 * office.MB)})
            self.assertLess(len(bomb), 100_000)
            self.assertEqual(self.refused(bomb, "docx").code, "zip-bomb")
            # Says it's small, but isn't: both size fields rewritten to 100 bytes.
            liar = bytearray(docx(extra={"word/media/liar.bin": b"\0" * (30 * office.MB)}))
            name = b"word/media/liar.bin"
            for sig, size_at in ((b"PK\x03\x04", 22), (b"PK\x01\x02", 24)):
                pos = 0
                while True:
                    pos = liar.find(sig, pos)
                    if pos < 0:
                        break
                    name_at = pos + (30 if sig == b"PK\x03\x04" else 46)
                    if liar[name_at:name_at + len(name)] == name:
                        struct.pack_into("<I", liar, pos + size_at, 100)
                    pos += 4
            self.assertIn(self.refused(bytes(liar), "docx").code, ("zip-bomb", "damaged"))
            # Tucked inside: an embedded workbook that unpacks to 30 MB.
            inner = io.BytesIO()
            with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("xl/zeros.bin", b"\0" * (30 * office.MB))
            nested = docx(extra={"word/embeddings/Book1.xlsx": inner.getvalue()})
            self.assertEqual(self.refused(nested, "docx").code, "zip-bomb")
            # Thousands of parts.
            many = docx(extra={f"word/media/{i}.txt": "x" for i in range(300)})
            self.assertEqual(self.refused(many, "docx").code, "zip-bomb")
        finally:
            office.MAX_UNZIPPED, office.MAX_ENTRIES = saved

    def test_huge_sheets(self):
        saved = office.MAX_CELLS
        office.MAX_CELLS = 500
        try:
            rows = [(f"r{i}", i, i * 2) for i in range(300)]  # 900 cells
            e = self.refused(xlsx({"Big": rows}), "xlsx")
            self.assertEqual(e.code, "too-big")
            self.assertIn("about 900 filled cells", e.message)
            self.assertEqual(self.refused(ods(rows), "ods").code, "too-big")
            text = "\n".join(f"r{i},{i},{i * 2}" for i in range(300)).encode()
            self.assertEqual(self.refused(text, "csv").code, "too-big")
            office.inspect(self.write("small.xlsx", xlsx({"Small": rows[:100]})), "xlsx")
        finally:
            office.MAX_CELLS = saved

    def test_empty(self):
        for ext in ("docx", "xlsx", "csv", "doc", "rtf"):
            with self.subTest(ext=ext):
                self.assertEqual(self.refused(b"", ext).code, "empty")

    def test_csv_reading(self):
        self.assertEqual(office.inspect(self.write("a.csv", b"a;b;c\n1;2;3\n4;5;6\n"), "csv")["separator"], ";")
        self.assertEqual(office.inspect(self.write("b.csv", b"a\tb\n1\t2\n"), "csv")["separator"], "\t")
        self.assertEqual(office.inspect(self.write("c.csv", b'"x, y",b\n"1,2",3\n'), "csv")["separator"], ",")
        self.assertEqual(office.inspect(self.write("d.csv", "naïve,café\n".encode("cp1252")), "csv")["charset"], 1)
        self.assertEqual(office.inspect(self.write("e.csv", "naïve,café\n".encode("utf-8")), "csv")["charset"], 76)
        self.assertEqual(self.refused(b"a,b\n\0\0\0", "csv").code, "mismatch")


class Tokens(unittest.TestCase):
    def test_round_trip_and_limits(self):
        payload, reason = office.verify(sign(grant("docx", 10)))
        self.assertIsNone(reason)
        self.assertEqual(office.job_from(payload)["ext"], "docx")
        self.assertEqual(office.verify(sign(grant("docx", 10), ttl=-5)), (None, "expired"))
        token = sign(grant("docx", 10))
        self.assertEqual(office.verify(token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1])[1], "bad-signature")
        # A download grant, signed with the raw secret, is no conversion grant.
        self.assertEqual(office.verify(sign(grant("docx", 10), key=SECRET.encode()))[1], "bad-signature")
        for bad in (dict(grant("docx", 10), k="mp4"), grant("pptx", 10), grant("docx", 0), grant("docx", office.MAX_BYTES + 1), dict(grant("docx", 10), c="x")):
            self.assertIsNone(office.job_from(office.verify(sign(bad))[0]), bad)
        opts = office.job_from(office.verify(sign(grant("xlsx", 5, fit=False, orientation="sideways", sheets="first")))[0])["options"]
        self.assertEqual(opts, {"fit": False, "orientation": "auto", "sheets": "first"})


@needs_office
class Convert(Files):
    def convert(self, ext: str, path: str | None = None, **opts) -> tuple:
        job = tempfile.mkdtemp(prefix="pw-office-conv-")
        self.addCleanup(shutil.rmtree, job, True)
        src = os.path.join(job, f"input.{ext}")
        shutil.copy(path or self.paths[ext], src)
        pdf = office.convert(src, ext, {"fit": True, "orientation": "auto", "sheets": "all", **opts}, job, office.inspect(src, ext))
        with open(pdf, "rb") as f:
            data = f.read()
        text = subprocess.run([PDFTOTEXT, "-layout", pdf, "-"], capture_output=True, text=True).stdout if PDFTOTEXT else None
        fonts = subprocess.run([PDFFONTS, pdf], capture_output=True, text=True).stdout if PDFFONTS else None
        return data, office.page_count(pdf), text, fonts

    def test_every_format(self):
        expect = {
            "docx": "Quarterly figures", "odt": "OpenDocument text", "rtf": "Hello from RTF", "doc": "Quarterly figures",
            "xlsx": "North", "xls": "North", "ods": "North", "csv": "Thandi Nkosi",
        }
        for ext, words in expect.items():
            if ext not in self.paths:
                continue
            with self.subTest(ext=ext):
                data, pages, text, fonts = self.convert(ext)
                self.assertTrue(data.startswith(b"%PDF-"))
                self.assertGreaterEqual(pages or 0, 1)
                if text is not None:
                    self.assertIn(words, text)
                # Every font is embedded, so the PDF looks the same everywhere.
                self.assertGreater(data.count(b"/FontDescriptor"), 0)
                if fonts is not None:
                    rows = [ln.split() for ln in fonts.splitlines()[2:] if ln.strip()]
                    self.assertTrue(rows and all(r[-5] == "yes" for r in rows), fonts)

    def test_table_and_accents_kept(self):
        _, pages, text, _ = self.convert("docx")
        self.assertEqual(pages, 1)
        if text is not None:
            self.assertRegex(text, r"Region\s+Units\s+Revenue")
            self.assertRegex(text, r"North\s+120\s+R 12,400")
            self.assertIn("café and naïve", text)

    def test_sheet_options(self):
        data, pages, text, _ = self.convert("xlsx")
        self.assertEqual(pages, 2)
        if text is not None:
            self.assertIn("Only on the second sheet", text)
        data, pages, text, _ = self.convert("xlsx", sheets="first", orientation="landscape")
        self.assertEqual(pages, 1)
        if text is not None:
            self.assertNotIn("Only on the second sheet", text)
        box = [float(v) for v in data.split(b"/MediaBox[", 1)[1].split(b"]", 1)[0].split()] if b"/MediaBox[" in data else None
        if box:
            self.assertGreater(box[2], box[3], "landscape")

    def test_csv_values_print_as_written(self):
        _, _, text, _ = self.convert("csv")
        if text is not None:
            self.assertIn("007", text)
            self.assertIn("0123", text)
            self.assertIn("03/04/2025", text)
            self.assertNotIn("input", text)  # no header with the sheet's (our file's) name

    def test_linked_local_file_not_read(self):
        # A picture linked (not embedded) to a file on the server: stock
        # LibreOffice pulls it into the PDF; with this profile it stays out.
        picture = os.path.join(self.dir, "server-picture.png")
        with open(picture, "wb") as f:
            f.write(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
            ))
        os.chmod(picture, 0o644)
        body = (
            '<office:text><text:p>Picture:<draw:frame draw:name="p" text:anchor-type="as-char" svg:width="5cm" svg:height="5cm">'
            f'<draw:image xlink:href="file://{picture}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>'
            "</draw:frame></text:p></office:text>"
        )
        path = self.write("linked.odt", odf("application/vnd.oasis.opendocument.text", body))
        data, _, _, _ = self.convert("odt", path)
        self.assertNotIn(b"/Subtype/Image", data.replace(b" ", b""))

    def test_timeout_and_cancel_leave_nothing_running(self):
        for kw, expected in (({"timeout": 1}, office.Refused), ({"cancelled": lambda: True}, office.Cancelled)):
            with self.subTest(kw=list(kw)):
                job = tempfile.mkdtemp(prefix="pw-office-stop-")
                src = os.path.join(job, "input.docx")
                shutil.copy(self.paths["long.docx"], src)
                try:
                    started = time.time()
                    with self.assertRaises(expected) as caught:
                        office.convert(src, "docx", {}, job, office.inspect(src, "docx"), **kw)
                    self.assertLess(time.time() - started, 10)
                    if expected is office.Refused:
                        self.assertEqual(caught.exception.code, "timeout")
                    time.sleep(0.3)
                    self.assertEqual(soffice_processes(job), [])
                finally:
                    shutil.rmtree(job, ignore_errors=True)

    def test_never_root_and_no_network(self):
        seen = {}
        job = tempfile.mkdtemp(prefix="pw-office-who-")
        self.addCleanup(shutil.rmtree, job, True)
        src = os.path.join(job, "input.docx")
        shutil.copy(self.paths["docx"], src)

        def watch():
            until = time.time() + 30
            while time.time() < until and "uid" not in seen:
                for pid in soffice_processes(job):
                    try:
                        with open(f"/proc/{pid}/status") as f:
                            uid = int(next(ln for ln in f if ln.startswith("Uid:")).split()[1])
                        seen["uid"] = uid
                    except (OSError, StopIteration, ValueError):
                        pass
                time.sleep(0.05)

        t = threading.Thread(target=watch)
        t.start()
        office.convert(src, "docx", {}, job, office.inspect(src, "docx"))
        t.join()
        self.assertIn("uid", seen)
        self.assertNotEqual(seen["uid"], 0)
        if os.geteuid() != 0:
            self.assertEqual(seen["uid"], os.geteuid())
        prefix = office.sandbox_prefix()
        if prefix:
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            probe = f"import socket; socket.create_connection(('127.0.0.1', {port}), timeout=2)"
            run = subprocess.run(prefix + [sys.executable, "-c", probe], capture_output=True, text=True)
            listener.close()
            self.assertNotEqual(run.returncode, 0, "LibreOffice's sandbox reached the network")


class Route(Files):
    """POST /convert/office through worker.py's own handler."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), worker.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        super().tearDownClass()

    def post(self, data: bytes, token: str | None, path="/convert/office", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        h = {"Content-Type": "application/octet-stream", "Origin": "https://example.test", **(headers or {})}
        if token is not None:
            h[office.TOKEN_HEADER] = token
        conn.request("POST", path, body=data, headers=h)
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    def void(self, ref: str) -> dict:
        res, body = self.post(b"", None, f"/refs/{ref}/void", {"Authorization": f"Bearer {SECRET}"})
        return json.loads(body)

    def jobs_left(self) -> list:
        """Job folders still there a moment after the answer (the PDF is
        deleted once its last byte is sent, after the browser has it)."""
        until = time.time() + 3
        while True:
            left = [d for d in os.listdir(tempfile.gettempdir()) if d.startswith("pw-office-job-")]
            if not left or time.time() > until:
                return left
            time.sleep(0.05)

    def test_preflight_allows_the_token_header(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("OPTIONS", "/convert/office", headers={"Origin": "https://example.test", "Access-Control-Request-Headers": "x-convert-token"})
        res = conn.getresponse()
        res.read()
        self.assertIn("X-Convert-Token", res.getheader("Access-Control-Allow-Headers"))

    def test_refusals(self):
        data = self.files["docx"]
        g = grant("docx", len(data))
        res, body = self.post(data, sign(g, ttl=-1))
        self.assertEqual((res.status, json.loads(body)["code"]), (401, "expired"))
        res, body = self.post(data, sign(g, key=SECRET.encode()))
        self.assertEqual((res.status, json.loads(body)["code"]), (401, "bad-signature"))
        res, body = self.post(data, None)
        self.assertEqual(res.status, 401)
        res, body = self.post(data, sign(dict(g, k="mp4")))
        self.assertEqual(res.status, 400)
        res, body = self.post(data, sign(grant("docx", len(data) + 1)))
        self.assertEqual((res.status, json.loads(body)["code"]), (400, "size"))
        # The extension in the grant is what's checked, not the bytes' own claim.
        x = grant("xlsx", len(data))
        res, body = self.post(data, sign(x))
        self.assertEqual((res.status, json.loads(body)["code"]), (415, "mismatch"))
        self.assertEqual(self.void(x["c"])["status"], "error")
        self.assertEqual(self.jobs_left(), [])

    def test_busy(self):
        saved = office.MAX_QUEUE
        office.MAX_QUEUE = -office.MAX_CONCURRENT
        try:
            data = self.files["docx"]
            g = grant("docx", len(data))
            res, body = self.post(data, sign(g))
            self.assertEqual((res.status, json.loads(body)["code"]), (503, "busy"))
            self.assertTrue(self.void(g["c"])["used"])
        finally:
            office.MAX_QUEUE = saved

    def test_refund_record(self):
        # A grant voided before use (a refund) can't start a conversion.
        data = self.files["docx"]
        g = grant("docx", len(data))
        self.assertEqual(self.void(g["c"])["used"], False)
        res, body = self.post(data, sign(g))
        self.assertEqual((res.status, json.loads(body)["code"]), (409, "used"))

    @needs_office
    def test_converts_once(self):
        data = self.files["docx"]
        g = grant("docx", len(data))
        token = sign(g)
        res, body = self.post(data, token)
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("Content-Type"), "application/pdf")
        self.assertEqual(res.getheader("Access-Control-Allow-Origin"), "*")
        self.assertIn("X-Page-Count", res.getheader("Access-Control-Expose-Headers"))
        self.assertEqual(res.getheader("X-Page-Count"), "1")
        self.assertTrue(body.startswith(b"%PDF-"))
        self.assertEqual(self.void(g["c"]), {"used": True, "status": "ready", "error": None, "since": worker.STARTED})
        res, body = self.post(data, token)
        self.assertEqual((res.status, json.loads(body)["code"]), (409, "used"))
        self.assertEqual(self.jobs_left(), [])

    @needs_office
    def test_encrypted_is_refundable(self):
        path = os.path.join(self.dir, "locked.docx")
        if not os.path.exists(path):
            self.skipTest("no locked file")
        with open(path, "rb") as f:
            data = f.read()
        g = grant("docx", len(data))
        res, body = self.post(data, sign(g))
        self.assertEqual((res.status, json.loads(body)["code"]), (422, "encrypted"))
        verdict = self.void(g["c"])
        self.assertEqual((verdict["used"], verdict["status"]), (True, "error"))

    @needs_office
    def test_browser_leaving_stops_the_job(self):
        data = self.files["long.docx"]
        g = grant("docx", len(data))
        sock = socket.create_connection(("127.0.0.1", self.port))
        head = (f"POST /convert/office HTTP/1.1\r\nHost: x\r\n{office.TOKEN_HEADER}: {sign(g)}\r\n"
                f"Content-Length: {len(data)}\r\n\r\n").encode()
        sock.sendall(head + data)
        time.sleep(0.6)
        sock.close()
        until = time.time() + 20
        while time.time() < until and worker.refs.get(g["c"], {}).get("status") == "working":
            time.sleep(0.1)
        self.assertEqual(worker.refs[g["c"]]["status"], "error")
        time.sleep(0.5)
        self.assertEqual(self.jobs_left(), [])


if __name__ == "__main__":
    unittest.main()
