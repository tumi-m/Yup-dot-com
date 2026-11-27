"""
Word and Excel to PDF for the media worker, with headless LibreOffice.

The browser uploads one file straight here (POST /convert/office) with a
short-lived token the web app signed after checking the visitor's plan, the
file's size and the daily allowance (app/api/convert/link). The token names
the file's size and type and starts one conversion. The PDF comes back in
the same response, and the upload, the PDF and LibreOffice's profile are
deleted as soon as it has been sent, or the conversion failed.

Before LibreOffice sees a file, its real type is checked against its name
(magic bytes, the parts inside a zip, the streams inside an older Office
file), and password-protected files, macro-enabled files, zip bombs and
sheets too big to print are turned away with a message saying so.

LibreOffice then runs through this file's --uno entry point, under the
system Python that has LibreOffice's UNO bridge (python3-uno):
  - with a fresh profile per job that turns macros, link updates,
    recalculation on load and links out of the document off, and the
    document opened with macros never run and links never updated;
  - with no network at all where the host allows it (a new network
    namespace), and an unreachable proxy where it doesn't;
  - never as root, with a memory cap, a CPU limit and a hard timeout;
  - one or two jobs at a time, the rest waiting in a short queue.

Standard library only. worker.py routes POST /convert/office here
(handles/handle) and shows health() to the web app.
"""

import base64
import ctypes
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

MB = 1024 * 1024


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


SECRET = os.environ.get("MEDIA_WORKER_SECRET", "").strip().encode()
# Largest upload taken (the web app's limits are lower, per plan).
MAX_BYTES = _env_int("OFFICE_MAX_BYTES", 100 * MB)
# Conversions at once, and how many more may upload and wait for a turn.
MAX_CONCURRENT = max(1, _env_int("OFFICE_MAX_CONCURRENT", 2))
MAX_QUEUE = max(0, _env_int("OFFICE_MAX_QUEUE", 8))
QUEUE_WAIT = _env_int("OFFICE_QUEUE_WAIT_SECONDS", 60)
# Longest an upload may take, so a slow one can't hold a place for good.
UPLOAD_TIMEOUT = _env_int("OFFICE_UPLOAD_SECONDS", 600)
# Hard limit for one conversion, from LibreOffice starting to the PDF written.
TIMEOUT = _env_int("OFFICE_TIMEOUT_SECONDS", 90)
# Address space for LibreOffice and its helper. LibreOffice reserves far more
# than it uses, so this is a ceiling against runaway files, not a budget.
MEMORY_MB = _env_int("OFFICE_MEMORY_MB", 2048)
# Zip formats (docx, xlsx, odt, ods): total unpacked size and number of parts.
MAX_UNZIPPED = _env_int("OFFICE_MAX_UNZIPPED_BYTES", 512 * MB)
MAX_ENTRIES = _env_int("OFFICE_MAX_ZIP_ENTRIES", 10_000)
# Spreadsheet cells with a value (about 500 to a printed page at 100%).
MAX_CELLS = _env_int("OFFICE_MAX_CELLS", 1_000_000)
MAX_PDF_BYTES = _env_int("OFFICE_MAX_PDF_BYTES", 512 * MB)
SOFFICE = os.environ.get("OFFICE_SOFFICE") or shutil.which("soffice") or "/usr/bin/soffice"
# The Python LibreOffice's UNO bridge is built for (Debian: /usr/bin/python3).
UNO_PYTHON = os.environ.get("OFFICE_PYTHON") or "/usr/bin/python3"
# "auto": LibreOffice gets no network where the host allows a new network
# namespace; "off" skips that (it still has an unreachable proxy).
SANDBOX = os.environ.get("OFFICE_SANDBOX", "auto").strip().lower()
# Who LibreOffice runs as if the worker itself runs as root.
RUN_AS = os.environ.get("OFFICE_USER", "nobody")

TOKEN_HEADER = "X-Convert-Token"
PATH = "/convert/office"
HERE = os.path.abspath(__file__)

# Extension -> (what it is, container, LibreOffice import filter).
FORMATS = {
    "docx": ("word", "ooxml", "MS Word 2007 XML"),
    "doc": ("word", "ole", "MS Word 97"),
    "odt": ("word", "odf", "writer8"),
    "rtf": ("word", "rtf", "Rich Text Format"),
    "xlsx": ("sheet", "ooxml", "Calc MS Excel 2007 XML"),
    "xls": ("sheet", "ole", "MS Excel 97"),
    "ods": ("sheet", "odf", "calc8"),
    "csv": ("sheet", "csv", "Text - txt - csv (StarCalc)"),
}

# A key of its own, derived from the shared secret, so a download grant never
# passes for a conversion grant or the other way round. The web app derives
# the same one (lib/office-server.ts).
TOKEN_KEY = base64.urlsafe_b64encode(
    hmac.new(SECRET, b"pdf-wizard/office-token/v1", hashlib.sha256).digest()
).rstrip(b"=")


class Refused(Exception):
    """A reason this file or request can't be converted, safe to show as-is."""

    def __init__(self, status: int, message: str, code: str = "refused"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


class Cancelled(Exception):
    """The browser went away (Cancel, or the tab closed) during the job."""


# ---------------------------------------------------------------------------
# Hardening the worker itself
# ---------------------------------------------------------------------------

def _not_dumpable() -> None:
    """LibreOffice runs as the worker's own user in the container. Marking the
    worker non-dumpable keeps its /proc files (environ holds the shared
    secret, mem its memory) away from processes of the same user, so a
    document that links to /proc/1/environ can't put the secret in a PDF.
    Children start dumpable again at exec, as usual."""
    if sys.platform.startswith("linux"):
        try:
            ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE, 0
        except (OSError, AttributeError):
            pass


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------

def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify(token: str, now: float | None = None) -> tuple[dict | None, str | None]:
    """As worker.verify_token, with the conversion key: (payload, None), or
    (None, "bad-signature" | "expired")."""
    if not SECRET or not isinstance(token, str) or "." not in token or len(token) > 4000:
        return None, "bad-signature"
    body, sig = token.rsplit(".", 1)
    expected = hmac.new(TOKEN_KEY, body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, _b64url_decode(sig)):
            return None, "bad-signature"
        payload = json.loads(_b64url_decode(body))
    except (ValueError, json.JSONDecodeError):
        return None, "bad-signature"
    if not isinstance(payload, dict):
        return None, "bad-signature"
    e = payload.get("e")
    if not isinstance(e, (int, float)) or e < (time.time() if now is None else now):
        return None, "expired"
    return payload, None


def job_from(payload: dict) -> dict | None:
    """The conversion a token allows, or None if it isn't one."""
    ext, size, opts = payload.get("x"), payload.get("z"), payload.get("o") or {}
    if payload.get("k") != "office" or ext not in FORMATS or not isinstance(opts, dict):
        return None
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_BYTES:
        return None
    ref = payload.get("c")
    if not isinstance(ref, str) or not re.fullmatch(r"[\w-]{8,64}", ref):
        return None
    return {
        "ext": ext,
        "size": size,
        "ref": ref,
        "options": {
            "fit": opts.get("fit") is not False,
            "orientation": opts.get("orientation") if opts.get("orientation") in ("portrait", "landscape") else "auto",
            "sheets": "first" if opts.get("sheets") == "first" else "all",
        },
    }


# ---------------------------------------------------------------------------
# What a file really is
# ---------------------------------------------------------------------------

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ZIP_MAGIC = b"PK\x03\x04"

LABELS = {
    "word": "Word",
    "sheet": "Excel",
    "slides": "PowerPoint",
}

WORD_TYPES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
}
SHEET_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
}
SLIDE_TYPE = re.compile(r"presentationml\.(presentation|slideshow|template)\.main\+xml|ms-powerpoint")
MACRO_TYPE = re.compile(r"macroEnabled|binary\.macroEnabled", re.I)
ODF_TYPES = {
    "application/vnd.oasis.opendocument.text": "word",
    "application/vnd.oasis.opendocument.text-template": "word",
    "application/vnd.oasis.opendocument.spreadsheet": "sheet",
    "application/vnd.oasis.opendocument.spreadsheet-template": "sheet",
    "application/vnd.oasis.opendocument.presentation": "slides",
}


def damaged(ext: str) -> Refused:
    return Refused(415, f"This file is damaged or isn't a real .{ext} file, so it can't be opened.", "damaged")


def mismatch(ext: str, real: str, real_ext: str | None = None) -> Refused:
    """The name says one thing and the bytes another. `real`: what the bytes
    are ("word", "sheet", "slides", or "pdf", "zip", "image", "unknown");
    `real_ext`: the extension they'd have, when known."""
    want = FORMATS[ext][0]
    if real == want and real_ext and real_ext != ext:
        return Refused(415, f"This is a .{real_ext} file with a .{ext} name. Rename it to .{real_ext} and try again.", "mismatch")
    if real in LABELS and real != want:
        art = lambda k: "an Excel" if k == "sheet" else f"a {LABELS[k]}"  # noqa: E731
        tool = {"word": " Use Word to PDF.", "sheet": " Use Excel to PDF."}.get(real, " Use PPTX to PDF." if real_ext == "pptx" else "")
        return Refused(415, f"This is {art(real)} file, not {art(want)} file.{tool}", "mismatch")
    names = {"pdf": "a PDF", "zip": "a zip archive", "image": "a picture"}
    if real in names:
        return Refused(415, f"This is {names[real]}, not a real .{ext} file.", "mismatch")
    return Refused(415, f"This file isn't a real .{ext} file. It may be another kind of file renamed.", "mismatch")


def encrypted() -> Refused:
    return Refused(422, "This file is password-protected. Remove the password in Word or Excel, save it, and try again.", "encrypted")


def macros(ext: str) -> Refused:
    real = "docm" if FORMATS[ext][0] == "word" else "xlsm"
    return Refused(415, f"This is a macro-enabled file (.{real}). Save it as .{ext} without macros and try again.", "macros")


def bomb() -> Refused:
    return Refused(422, "This file unpacks to far more than its size, so it can't be converted safely.", "zip-bomb")


def too_many_cells(n: int) -> Refused:
    return Refused(
        422,
        f"This spreadsheet is too big for a PDF (about {n:,} filled cells). Set a print area, or split it into smaller files.",
        "too-big",
    )


def guess(head: bytes) -> str:
    """A rough name for what some bytes are, for messages."""
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(ZIP_MAGIC):
        return "zip"
    if head[:3] == b"\xff\xd8\xff" or head.startswith(b"\x89PNG") or head[:4] in (b"GIF8", b"RIFF"):
        return "image"
    return "unknown"


class Ole:
    """Just enough of the compound file format (.doc, .xls, and encrypted
    .docx/.xlsx) to list its streams and read the start of one."""

    FREE, END = 0xFFFFFFFF, 0xFFFFFFFE

    def __init__(self, f, size: int):
        self.f, self.size = f, size
        f.seek(0)
        h = f.read(512)
        if len(h) < 512 or h[:8] != OLE_MAGIC:
            raise ValueError("not a compound file")
        shift, mini_shift = struct.unpack_from("<HH", h, 30)
        if shift not in (9, 12) or mini_shift != 6:
            raise ValueError("bad sector size")
        self.ss = 1 << shift
        n_fat, self.dir_start = struct.unpack_from("<II", h, 44)
        self.mini_cutoff, self.minifat_start, n_minifat, difat_start, n_difat = struct.unpack_from("<IIIII", h, 56)
        self.max_sector = size // self.ss
        difat = [s for s in struct.unpack_from("<109I", h, 76) if s < self.max_sector]
        seen = 0
        while difat_start < self.max_sector and seen < n_difat and seen < 10_000:
            block = struct.unpack("<%dI" % (self.ss // 4), self.sector(difat_start))
            difat += [s for s in block[:-1] if s < self.max_sector]
            difat_start, seen = block[-1], seen + 1
        self.fat = []
        for s in difat[:n_fat]:
            self.fat += struct.unpack("<%dI" % (self.ss // 4), self.sector(s))
        self.entries = self._entries()
        root = self.entries[0] if self.entries else None
        self.mini_start = root["start"] if root else self.END
        self.minifat = []
        if n_minifat:
            for s in self.chain(self.minifat_start):
                self.minifat += struct.unpack("<%dI" % (self.ss // 4), self.sector(s))

    def sector(self, n: int) -> bytes:
        self.f.seek((n + 1) * self.ss)
        data = self.f.read(self.ss)
        if len(data) < self.ss:
            raise ValueError("truncated")
        return data

    def chain(self, start: int, table: list | None = None) -> list:
        table = self.fat if table is None else table
        out, n = [], start
        while n < len(table) and n not in (self.END, self.FREE):
            out.append(n)
            if len(out) > len(table):
                raise ValueError("loop")
            n = table[n]
        return out

    def _entries(self) -> list:
        data = b"".join(self.sector(s) for s in self.chain(self.dir_start)[:4096])
        out = []
        for i in range(0, len(data) - 127, 128):
            e = data[i:i + 128]
            name_len, kind = struct.unpack_from("<HB", e, 64)
            if kind not in (1, 2, 5) or not 2 <= name_len <= 64:
                continue
            start, size = struct.unpack_from("<IQ", e, 116)
            out.append({"name": e[:name_len - 2].decode("utf-16-le", "replace"), "kind": kind, "start": start, "size": size})
        return out

    def names(self) -> set:
        return {e["name"] for e in self.entries if e["kind"] == 2}

    def read(self, name: str, limit: int) -> bytes:
        """The first `limit` bytes of a stream."""
        e = next((e for e in self.entries if e["kind"] == 2 and e["name"] == name), None)
        if not e:
            return b""
        want = min(e["size"], limit)
        if e["size"] < self.mini_cutoff:
            mini = self.chain(self.mini_start)
            out = b""
            for m in self.chain(e["start"], self.minifat):
                big, off = divmod(m * 64, self.ss)
                if big >= len(mini):
                    break
                out += self.sector(mini[big])[off:off + 64]
                if len(out) >= want:
                    break
            return out[:want]
        out = b""
        for s in self.chain(e["start"]):
            out += self.sector(s)
            if len(out) >= want:
                break
        return out[:want]


def inspect_ole(path: str, ext: str, kind: str) -> dict:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        try:
            ole = Ole(f, size)
        except (ValueError, struct.error):
            raise damaged(ext)
        names = ole.names()
        if "EncryptedPackage" in names or "EncryptionInfo" in names:
            raise encrypted()
        real = _ole_kind(names)
        if real != kind:
            raise mismatch(ext, real or "unknown", OLE_EXT.get(real))
        if kind == "word":
            fib = ole.read("WordDocument", 32)
            if len(fib) < 12 or struct.unpack_from("<H", fib, 0)[0] != 0xA5EC:
                raise damaged(ext)
            # fEncrypted, or fObfuscated (the old XOR "protection").
            if struct.unpack_from("<H", fib, 10)[0] & 0x8100:
                raise encrypted()
        else:
            book = ole.read("Workbook" if "Workbook" in names else "Book", 64 * 1024)
            pos = 0
            # FILEPASS (0x2F) sits among the first records of the workbook.
            for _ in range(400):
                if pos + 4 > len(book):
                    break
                rtype, rlen = struct.unpack_from("<HH", book, pos)
                if rtype == 0x002F:
                    raise encrypted()
                if rtype == 0x000A:  # end of the workbook globals
                    break
                pos += 4 + rlen
    return {}


OLE_EXT = {"word": "doc", "sheet": "xls", "slides": "ppt"}
ZIP_EXT = {"ooxml": {"word": "docx", "sheet": "xlsx", "slides": "pptx"}, "odf": {"word": "odt", "sheet": "ods", "slides": "odp"}}


def _ole_kind(names: set) -> str | None:
    if "WordDocument" in names:
        return "word"
    if "Workbook" in names or "Book" in names:
        return "sheet"
    if "PowerPoint Document" in names:
        return "slides"
    return None


def _attrs(tag: str) -> dict:
    return dict(re.findall(r'([\w:]+)\s*=\s*"([^"]*)"', tag))


def _zip_identity(zf: zipfile.ZipFile, names: set) -> tuple:
    """What an Office zip is: (kind, extension, its content types)."""
    if "[Content_Types].xml" in names:
        listing = _read_small(zf, "[Content_Types].xml").decode("utf-8", "replace")
        content = {_attrs(t).get("ContentType", "") for t in re.findall(r"<(?:\w+:)?Override\b[^>]*>", listing)}
        if content & WORD_TYPES or any("ms-word." in c for c in content):
            real = "word"
        elif content & SHEET_TYPES or any("ms-excel." in c for c in content):
            real = "sheet"
        elif any(SLIDE_TYPE.search(c) for c in content):
            real = "slides"
        else:
            return "unknown", None, content
        return real, ZIP_EXT["ooxml"][real], content
    if "mimetype" in names:
        real = ODF_TYPES.get(_read_small(zf, "mimetype").decode("ascii", "replace").strip())
        return (real, ZIP_EXT["odf"][real], set()) if real else ("unknown", None, set())
    return "zip", None, set()


def inspect_zip(path: str, ext: str, kind: str, container: str) -> dict:
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise damaged(ext)
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise bomb()
        if sum(i.file_size for i in infos) > MAX_UNZIPPED:
            raise bomb()
        names = {i.filename for i in infos}
        if any(i.flag_bits & 0x1 for i in infos):
            raise encrypted()

        real, real_ext, content = _zip_identity(zf, names)
        if real != kind or (real_ext in ("docx", "xlsx")) != (container == "ooxml"):
            raise mismatch(ext, real, real_ext)
        if container == "ooxml":
            # A .docm or .xlsm renamed, or macros added to a plain file.
            if any(MACRO_TYPE.search(c) for c in content) or any(n.lower().endswith("vbaproject.bin") for n in names):
                raise macros(ext)
            if not content & (WORD_TYPES if kind == "word" else SHEET_TYPES):
                raise mismatch(ext, "unknown")
        else:
            manifest = _read_small(zf, "META-INF/manifest.xml", 4 * MB)
            if b"encryption-data" in manifest:
                raise encrypted()

        # Unpack everything once, counting the bytes that really come out (a
        # header can understate them), and the filled cells of a sheet.
        cells = _unpack_all(zf, infos, ext, kind, container, MAX_UNZIPPED, depth=0)[1]
        if kind == "sheet" and cells > MAX_CELLS:
            raise too_many_cells(cells)
        return {"cells": cells}


def _read_small(zf: zipfile.ZipFile, name: str, limit: int = MB) -> bytes:
    try:
        info = zf.getinfo(name)
    except KeyError:
        return b""
    if info.file_size > limit:
        raise bomb()
    try:
        with zf.open(info) as f:
            return f.read(limit + 1)[:limit]
    except (zipfile.BadZipFile, OSError, ValueError, EOFError, NotImplementedError):
        return b""


# Cells with a value: <v> (numbers, shared strings, formulas' results) and
# <is> (inline strings) in a worksheet; office:value-type in ODF.
_CELL_MARKS = {"ooxml": (b"<v>", b"<is>"), "odf": (b"office:value-type=",)}


def _unpack_all(zf, infos, ext: str, kind: str, container: str, budget: int, depth: int) -> tuple:
    """Unpacks every part, raising a bomb past `budget` bytes; returns the
    bytes and the filled cells counted on the way. A zip inside (an embedded
    workbook, which LibreOffice may open) counts against the same budget."""
    total, cells = 0, 0
    marks = _CELL_MARKS.get(container, ())
    for info in infos:
        if info.is_dir():
            continue
        counting = kind == "sheet" and (
            (container == "ooxml" and info.filename.startswith("xl/worksheets/") and info.filename.endswith(".xml"))
            or (container == "odf" and info.filename == "content.xml")
        )
        # Read to the real end of the data, whatever size the header gives
        # (the size only decides when the checksum is checked).
        probe = zipfile.ZipInfo(info.filename, info.date_time)
        for attr in ("compress_type", "compress_size", "CRC", "flag_bits", "header_offset", "extra", "orig_filename"):
            setattr(probe, attr, getattr(info, attr))
        probe.file_size = 1 << 62
        nested = bytearray() if depth < 1 else None
        tail = b""
        try:
            with zf.open(probe) as f:
                while True:
                    chunk = f.read(MB)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > budget:
                        raise bomb()
                    if counting:
                        window = tail + chunk
                        cells += sum(window.count(m) for m in marks) - sum(tail.count(m) for m in marks)
                        tail = window[-32:]
                    if nested is not None and (nested or chunk.startswith(ZIP_MAGIC)):
                        nested += chunk
        except (zipfile.BadZipFile, OSError, EOFError, ValueError, NotImplementedError, RuntimeError):
            raise damaged(ext)
        if nested:
            try:
                inner = zipfile.ZipFile(io.BytesIO(bytes(nested)))
            except zipfile.BadZipFile:
                continue
            with inner:
                parts = inner.infolist()
                if len(parts) > MAX_ENTRIES:
                    raise bomb()
                try:
                    total += _unpack_all(inner, parts, ext, "embedded", "zip", budget - total, depth + 1)[0]
                except Refused as e:
                    # A damaged embedded file is LibreOffice's to skip; a bomb isn't.
                    if e.code == "zip-bomb":
                        raise
    return total, cells


def inspect_rtf(path: str, ext: str) -> dict:
    with open(path, "rb") as f:
        head = f.read(64)
    if not head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"{\\rtf"):
        raise mismatch(ext, guess(head) if guess(head) != "unknown" else "unknown")
    return {}


CSV_SEPARATORS = (",", ";", "\t", "|")


def inspect_csv(path: str, ext: str) -> dict:
    """Plain text: its encoding, its separator, and how many cells it fills."""
    with open(path, "rb") as f:
        head = f.read(256 * 1024)
    kind = guess(head)
    if kind != "unknown" or head.startswith(OLE_MAGIC) or head.lstrip().startswith(b"{\\rtf"):
        raise mismatch(ext, kind if kind != "unknown" else "unknown")
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        charset, text = 65535, head.decode("utf-16", "replace")
    else:
        if b"\x00" in head:
            raise mismatch(ext, "unknown")
        try:
            text, charset = head.decode("utf-8"), 76
        except UnicodeDecodeError as e:
            # A multi-byte letter cut by the sample's end is still UTF-8.
            if e.start >= len(head) - 4:
                text, charset = head[:e.start].decode("utf-8"), 76
            else:
                text, charset = head.decode("cp1252", "replace"), 1
    text = text.lstrip("﻿")
    lines = [ln for ln in text.splitlines()[:200] if ln.strip()]
    if len(head) == 256 * 1024 and lines:
        lines = lines[:-1]  # likely cut
    sep, cols = ",", 1
    best = -1.0
    for cand in CSV_SEPARATORS:
        counts = [_unquoted(ln).count(cand) for ln in lines[:100]]
        if not counts or max(counts) == 0:
            continue
        common = max(set(counts), key=counts.count)
        score = counts.count(common) / len(counts) + (0.01 if cand == "," else 0)
        if common > 0 and score > best:
            best, sep, cols = score, cand, common + 1
    with open(path, "rb") as f:
        rows = sum(chunk.count(b"\n") for chunk in iter(lambda: f.read(MB), b"")) + 1
    cells = rows * cols
    if cells > MAX_CELLS:
        raise too_many_cells(cells)
    return {"separator": sep, "charset": charset, "columns": min(cols, 1024), "cells": cells}


def _unquoted(line: str) -> str:
    """The line with quoted values taken out, so a comma inside one doesn't count."""
    return re.sub(r'"[^"]*"', "", line)


def inspect(path: str, ext: str) -> dict:
    """Checks a file before LibreOffice sees it; raises Refused with the reason."""
    if ext not in FORMATS:
        raise Refused(415, "This kind of file can't be converted here.", "unsupported")
    kind, container, _ = FORMATS[ext]
    size = os.path.getsize(path)
    if size == 0:
        raise Refused(422, "This file is empty.", "empty")
    with open(path, "rb") as f:
        head = f.read(8)
    info: dict
    if container in ("ooxml", "odf"):
        if head.startswith(OLE_MAGIC):
            # An encrypted .docx/.xlsx is a compound file, as is a .doc renamed.
            info = _ole_in_zip_clothing(path, ext, kind)
        elif not head.startswith(ZIP_MAGIC):
            raise mismatch(ext, guess(head))
        else:
            info = inspect_zip(path, ext, kind, container)
    elif container == "ole":
        if head.startswith(ZIP_MAGIC):
            # A .docx (or .odt, or another kind) renamed .doc.
            try:
                with zipfile.ZipFile(path) as zf:
                    real, real_ext, _ = _zip_identity(zf, set(zf.namelist()))
            except (zipfile.BadZipFile, OSError, ValueError):
                raise damaged(ext)
            raise mismatch(ext, real, real_ext)
        if not head.startswith(OLE_MAGIC):
            if ext == "doc" and head.lstrip().startswith(b"{\\rtf"):
                raise Refused(415, "This is an RTF file with a .doc name. Rename it to .rtf and try again.", "mismatch")
            raise mismatch(ext, guess(head))
        info = inspect_ole(path, ext, kind)
    elif container == "rtf":
        info = inspect_rtf(path, ext)
    else:
        info = inspect_csv(path, ext)
    return info


def _ole_in_zip_clothing(path: str, ext: str, kind: str) -> dict:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        try:
            names = Ole(f, size).names()
        except (ValueError, struct.error):
            raise damaged(ext)
    if "EncryptedPackage" in names or "EncryptionInfo" in names:
        raise encrypted()
    real = _ole_kind(names)
    raise mismatch(ext, real or "unknown", OLE_EXT.get(real))


# ---------------------------------------------------------------------------
# Running LibreOffice
# ---------------------------------------------------------------------------

# A fresh profile for every job. Macros off at the highest level, no links
# out of documents, no link updates or recalculation on load (cached values
# are printed, so WEBSERVICE() and friends never run), no printer lookups,
# and an unreachable proxy for anything that would still go online.
PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Save/Document"><prop oor:name="LoadPrinter" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetProxyType" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPProxyPort" oor:op="fuse"><value>9</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPSProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPSProxyPort" oor:op="fuse"><value>9</value></prop></item>
<item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetNoProxy" oor:op="fuse"><value></value></prop></item>
</oor:items>
"""

_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_admit_lock = threading.Lock()
_admitted = 0
_sandbox: list | None = None


def _drop_root() -> dict:
    """Popen arguments that keep LibreOffice off root, if the worker is root."""
    if os.geteuid() != 0:
        return {}
    import pwd

    pw = pwd.getpwnam(RUN_AS)
    return {"user": pw.pw_uid, "group": pw.pw_gid, "extra_groups": []}


def sandbox_prefix() -> list:
    """`unshare` into new user and network namespaces where the host allows
    it (no network at all, not even loopback), else nothing."""
    global _sandbox
    if _sandbox is None:
        cmd = [shutil.which("unshare") or "unshare", "--user", "--map-root-user", "--net", "--"]
        ok = False
        if SANDBOX != "off" and shutil.which(cmd[0]):
            try:
                ok = subprocess.run(cmd + ["true"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=10, **_drop_root()).returncode == 0
            except (OSError, subprocess.SubprocessError, KeyError):
                ok = False
        _sandbox = cmd if ok else []
    return _sandbox


def _clean_env(job: str) -> dict:
    # Nothing from the worker's own environment: no secret reaches LibreOffice.
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": job,
        "TMPDIR": os.path.join(job, "tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "SAL_USE_VCLPLUGIN": "svp",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def _uri(path: str) -> str:
    from urllib.parse import quote

    return "file://" + quote(os.path.abspath(path))


def _killgroup(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        pass


def convert(src: str, ext: str, options: dict, job: str, info: dict | None = None,
            cancelled=lambda: False, timeout: int | None = None) -> str:
    """Converts `src` (already inspected) to job/out.pdf, returning its path."""
    kind, _, filter_name = FORMATS[ext]
    info = info or {}
    os.makedirs(os.path.join(job, "tmp"), exist_ok=True)
    os.makedirs(os.path.join(job, "profile", "user"), exist_ok=True)
    with open(os.path.join(job, "profile", "user", "registrymodifications.xcu"), "w", encoding="utf-8") as f:
        f.write(PROFILE)
    out = os.path.join(job, "out.pdf")
    filter_options = None
    if ext == "csv":
        sep = info.get("separator", ",")
        cols = info.get("columns", 1)
        # Every column as text, so values print exactly as written: no lost
        # leading zeros, no dates turned around.
        formats = "/".join(f"{i}/2" for i in range(1, cols + 1))
        filter_options = f"{ord(sep)},34,{info.get('charset', 76)},1,{formats},1033,false,false"
    spec = {
        "input": os.path.abspath(src),
        "output": out,
        "profile": os.path.join(job, "profile"),
        "kind": kind,
        "filter": filter_name,
        "filterOptions": filter_options,
        "csv": ext == "csv",
        "options": options,
        "soffice": SOFFICE,
        "timeout": timeout or TIMEOUT,
        "memoryMb": MEMORY_MB,
        "maxPdfBytes": MAX_PDF_BYTES,
    }
    with open(os.path.join(job, "job.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f)
    drop = _drop_root()
    if drop:
        for root, dirs, files in os.walk(job):
            for name in [root] + [os.path.join(root, n) for n in dirs + files]:
                os.chown(name, drop["user"], drop["group"])
    log = open(os.path.join(job, "helper.log"), "wb")
    try:
        proc = subprocess.Popen(
            sandbox_prefix() + [UNO_PYTHON, "-I", HERE, "--uno", job],
            cwd=job, env=_clean_env(job), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, **drop,
        )
    except OSError as e:
        log.close()
        print(f"office: couldn't start LibreOffice's helper: {e}", flush=True)
        raise Refused(503, "Conversion isn't available right now. Try again later.", "unavailable")
    deadline = time.time() + (timeout or TIMEOUT)
    try:
        while True:
            try:
                proc.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if cancelled():
                    raise Cancelled()
                if time.time() > deadline:
                    raise Refused(504, "This file took too long to convert. Try a smaller file, or split it.", "timeout")
    finally:
        # Whatever happened, nothing it started outlives the job.
        _killgroup(proc)
        log.close()
    result = {}
    try:
        with open(os.path.join(job, "result.json"), encoding="utf-8") as f:
            result = json.load(f)
    except (OSError, ValueError):
        pass
    if result.get("ok") and os.path.isfile(out) and os.path.getsize(out) > 0:
        with open(out, "rb") as f:
            if f.read(5) == b"%PDF-":
                return out
    error = result.get("error") or ("crashed" if proc.returncode else "no-output")
    try:
        with open(os.path.join(job, "helper.log"), "rb") as f:
            tail = f.read()[-600:].decode("utf-8", "replace").replace("\n", " | ")
    except OSError:
        tail = ""
    print(f"office: conversion failed ({ext}): {error} {result.get('detail', '')} {tail}".strip(), flush=True)
    raise _failure(error, kind)


def _failure(error: str, kind: str) -> Refused:
    if error == "load":
        return Refused(422, "This file couldn't be opened. It may be damaged, password-protected or saved in a format we can't read.", "load")
    if error == "kind":
        return Refused(415, "This file isn't the kind its name says.", "mismatch")
    if error == "empty":
        return Refused(422, "This spreadsheet is empty: there's nothing to print." if kind == "sheet" else "This document is empty.", "empty")
    if error == "start":
        return Refused(503, "Conversion isn't available right now. Try again later.", "unavailable")
    return Refused(500, "Couldn't convert this file.", "failed")


def page_count(pdf: str) -> int | None:
    """Pages in a PDF LibreOffice wrote: the largest /Count of a page tree."""
    try:
        with open(pdf, "rb") as f:
            data = f.read(64 * MB)
    except OSError:
        return None
    counts = [int(m) for m in re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", data)]
    counts += [int(m) for m in re.findall(rb"/Count\s+(\d+)[^>]*?/Type\s*/Pages\b", data)]
    return max(counts) if counts else None


# ---------------------------------------------------------------------------
# HTTP (called from worker.py's handler)
# ---------------------------------------------------------------------------

def handles(path: str) -> bool:
    return path == PATH


def _content_length(handler) -> int | None:
    raw = handler.headers.get("Content-Length")
    if raw is None or not raw.strip().isdigit():
        return None
    return int(raw)


def _drain(handler, length: int | None) -> None:
    """Reads and drops a body the request won't use, so the browser gets the
    answer instead of a reset connection."""
    left = min(length or 0, MAX_BYTES + 1)
    try:
        handler.connection.settimeout(20)
        while left > 0:
            chunk = handler.rfile.read(min(left, MB))
            if not chunk:
                break
            left -= len(chunk)
    except OSError:
        pass


def _gone(handler) -> bool:
    """The browser hung up (Cancel, or the tab closed). The whole body has
    been read, so anything readable now is the end of the connection."""
    try:
        ready, _, _ = select.select([handler.connection], [], [], 0)
        if not ready:
            return False
        return handler.connection.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


def _admit() -> bool:
    global _admitted
    with _admit_lock:
        if _admitted >= MAX_CONCURRENT + MAX_QUEUE:
            return False
        _admitted += 1
        return True


def _leave() -> None:
    global _admitted
    with _admit_lock:
        _admitted = max(0, _admitted - 1)


BUSY = "The converter is busy. Try again in a minute."


def handle(handler, refs: dict, lock) -> None:
    """POST /convert/office: the token in X-Convert-Token, the file as the body."""
    length = _content_length(handler)
    payload, reason = verify(handler.headers.get(TOKEN_HEADER, ""))
    if not payload:
        _drain(handler, length)
        if reason == "expired":
            return handler.json(401, {"error": "This upload link expired. Please try again.", "code": "expired"})
        print("POST /convert/office: bad token signature. MEDIA_WORKER_SECRET differs from the web app's.", flush=True)
        return handler.json(401, {"error": "The conversion server rejected this site.", "code": "bad-signature"})
    job = job_from(payload)
    if not job:
        _drain(handler, length)
        return handler.json(400, {"error": "Unsupported request."})
    if length is None:
        return handler.json(411, {"error": "The file's size is missing."})
    if length != job["size"]:
        if length <= MAX_BYTES:
            _drain(handler, length)
        return handler.json(400, {"error": "This file isn't the one the upload link was made for.", "code": "size"})

    with lock:
        # One grant, one conversion; a refunded grant ("void") starts none.
        if job["ref"] in refs:
            record = None
        else:
            record = refs[job["ref"]] = {"status": "working", "created": time.time()}
    if record is None:
        _drain(handler, length)
        return handler.json(409, {"error": "This file was already sent. Please start again.", "code": "used"})

    def fail(status: int, error: str, code: str | None = None):
        record.update(status="error", error=error)
        body = {"error": error}
        if code:
            body["code"] = code
        return handler.json(status, body)

    if not _admit():
        _drain(handler, length)
        return fail(503, BUSY, "busy")
    work = tempfile.mkdtemp(prefix="pw-office-job-")
    os.chmod(work, 0o700)
    try:
        src = os.path.join(work, f"input.{job['ext']}")
        try:
            handler.connection.settimeout(60)
            left, until = length, time.time() + UPLOAD_TIMEOUT
            with open(src, "wb") as f:
                while left > 0 and time.time() < until:
                    chunk = handler.rfile.read(min(left, MB))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
        except OSError:
            left = 1
        if left > 0:
            record.update(status="error", error="Upload incomplete.")
            return
        try:
            info = inspect(src, job["ext"])
        except Refused as e:
            return fail(e.status, e.message, e.code)
        # Waiting for a turn; a browser that leaves meanwhile gives up its place.
        until = time.time() + QUEUE_WAIT
        while not _slots.acquire(timeout=0.5):
            if _gone(handler):
                record.update(status="error", error="Cancelled.")
                return
            if time.time() > until:
                return fail(503, BUSY, "busy")
        try:
            pdf = convert(src, job["ext"], job["options"], work, info, cancelled=lambda: _gone(handler))
        except Cancelled:
            record.update(status="error", error="Cancelled.")
            return
        except Refused as e:
            return fail(e.status, e.message, e.code)
        finally:
            _slots.release()
        # Only the PDF is needed now: the upload and LibreOffice's profile go
        # before it is sent, and the PDF as soon as it has been.
        for name in os.listdir(work):
            target = os.path.join(work, name)
            if os.path.isdir(target):
                shutil.rmtree(target, ignore_errors=True)
            elif target != pdf:
                os.remove(target)
        pages = page_count(pdf)
        size = os.path.getsize(pdf)
        try:
            handler.send_response(200)
            handler.cors()
            handler.send_header("Content-Type", "application/pdf")
            handler.send_header("Content-Length", str(size))
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("Access-Control-Expose-Headers", "X-Page-Count")
            if pages:
                handler.send_header("X-Page-Count", str(pages))
            handler.end_headers()
            with open(pdf, "rb") as f:
                shutil.copyfileobj(f, handler.wfile, MB)
            handler.wfile.flush()
        except OSError:
            # The browser left while the PDF was on its way: it has no file.
            record.update(status="error", error="Not delivered.")
            return
        record.update(status="ready", pages=pages)
    except Exception as e:  # noqa: BLE001 — a clean message, never a trace
        print(f"office: {type(e).__name__}: {e}", flush=True)
        if record.get("status") == "working":
            try:
                fail(500, "Couldn't convert this file.")
            except OSError:
                pass
    finally:
        _leave()
        shutil.rmtree(work, ignore_errors=True)


_health: dict | None = None


def health() -> dict:
    """For the web app's setup check: is LibreOffice here and usable."""
    global _health
    if _health is None:
        soffice = bool(shutil.which(SOFFICE) or os.path.isfile(SOFFICE))
        try:
            uno = subprocess.run([UNO_PYTHON, "-I", "-c", "import uno"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20).returncode == 0
        except (OSError, subprocess.SubprocessError):
            uno = False
        _health = {"soffice": soffice, "uno": uno}
    return {
        "ready": _health["soffice"] and _health["uno"],
        **_health,
        "network": "none" if sandbox_prefix() else "proxy-only",
        "maxBytes": MAX_BYTES,
        "concurrent": MAX_CONCURRENT,
        "timeout": TIMEOUT,
    }


# ---------------------------------------------------------------------------
# The LibreOffice side (run as: python3 -I office.py --uno <job dir>)
# ---------------------------------------------------------------------------

def _uno_main(job: str) -> int:
    import resource

    with open(os.path.join(job, "job.json"), encoding="utf-8") as f:
        spec = json.load(f)
    result = {"ok": False, "error": "failed"}

    def finish(res: dict) -> int:
        with open(os.path.join(job, "result.json"), "w", encoding="utf-8") as f:
            json.dump(res, f)
        return 0 if res.get("ok") else 1

    # Limits for this process and LibreOffice, which inherits them.
    mem = spec["memoryMb"] * MB
    resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    cpu = int(spec["timeout"]) + 10
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
    resource.setrlimit(resource.RLIMIT_FSIZE, (spec["maxPdfBytes"], spec["maxPdfBytes"]))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    import uno
    from com.sun.star.beans import PropertyValue
    from com.sun.star.connection import NoConnectException

    def props(**kw):
        out = []
        for k, v in kw.items():
            p = PropertyValue()
            p.Name, p.Value = k, v
            out.append(p)
        return tuple(out)

    pipe = "pwoffice_" + secrets.token_hex(8)
    office = subprocess.Popen(
        [spec["soffice"], "--headless", "--invisible", "--nocrashreport", "--nodefault", "--nofirststartwizard",
         "--nolockcheck", "--nologo", "--norestore", "-env:UserInstallation=" + _uri(spec["profile"]),
         f"--accept=pipe,name={pipe};urp;"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    desktop = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        ctx = None
        until = time.time() + 45
        while ctx is None:
            try:
                ctx = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
            except NoConnectException:
                if office.poll() is not None or time.time() > until:
                    return finish({"ok": False, "error": "start"})
                time.sleep(0.2)
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        load = {
            "Hidden": True,
            "ReadOnly": True,
            "MacroExecutionMode": 0,  # MacroExecMode.NEVER_EXECUTE
            "UpdateDocMode": 0,  # UpdateDocMode.NO_UPDATE
            "FilterName": spec["filter"],
        }
        if spec.get("filterOptions"):
            load["FilterOptions"] = spec["filterOptions"]
        try:
            doc = desktop.loadComponentFromURL(_uri(spec["input"]), "_blank", 0, props(**load))
        except Exception as e:  # noqa: BLE001
            return finish({"ok": False, "error": "load", "detail": type(e).__name__})
        if doc is None:
            return finish({"ok": False, "error": "load"})
        service = "com.sun.star.text.TextDocument" if spec["kind"] == "word" else "com.sun.star.sheet.SpreadsheetDocument"
        if not doc.supportsService(service):
            return finish({"ok": False, "error": "kind"})
        if spec["kind"] == "sheet":
            if not _prepare_sheets(doc, spec["options"], spec.get("csv")):
                return finish({"ok": False, "error": "empty"})
        data = props(
            UseTaggedPDF=True,
            ExportBookmarks=True,
            EmbedStandardFonts=True,
            ExportNotes=False,
            Quality=90,
            ReduceImageResolution=False,
        )
        store = props(
            FilterName="writer_pdf_Export" if spec["kind"] == "word" else "calc_pdf_Export",
            FilterData=uno.Any("[]com.sun.star.beans.PropertyValue", data),
            Overwrite=True,
        )
        try:
            doc.storeToURL(_uri(spec["output"]), store)
        except Exception as e:  # noqa: BLE001
            return finish({"ok": False, "error": "export", "detail": type(e).__name__})
        try:
            doc.close(True)
        except Exception:  # noqa: BLE001
            pass
        result = {"ok": True}
        return finish(result)
    except Exception as e:  # noqa: BLE001
        return finish({"ok": False, "error": "failed", "detail": f"{type(e).__name__}: {e}"[:300]})
    finally:
        if desktop is not None:
            try:
                desktop.terminate()
            except Exception:  # noqa: BLE001 — the bridge closes as LibreOffice quits
                pass
        try:
            office.wait(10)
        except subprocess.TimeoutExpired:
            office.kill()


def _prepare_sheets(doc, options: dict, csv: bool) -> bool:
    """Page setup for spreadsheets: the first sheet only if asked, the sheet's
    width fitted to the page, and the orientation. False if nothing prints."""
    sheets = doc.Sheets
    names = list(sheets.ElementNames)
    visible = [n for n in names if sheets.getByName(n).IsVisible]
    if not visible:
        return False
    if options.get("sheets") == "first":
        for n in names:
            if n != visible[0]:
                sheets.removeByName(n)
        visible = visible[:1]
    styles = doc.StyleFamilies.getByName("PageStyles")
    anything = False
    for name in visible:
        sheet = sheets.getByName(name)
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(False)
        end = cursor.RangeAddress
        used = sheet.getCellRangeByPosition(0, 0, end.EndColumn, end.EndRow)
        if used.queryContentCells(1 | 2 | 4 | 8 | 16).Count:  # VALUE, DATETIME, STRING, ANNOTATION, FORMULA
            anything = True
        style = styles.getByName(sheet.PageStyle)
        columns = sheet.Columns
        if csv:
            # A CSV has no page setup or column widths: A4, widths that fit
            # the values (long ones wrap at 8 cm), and cell lines. The default
            # header would print the sheet's name, which is our file's name.
            style.Width, style.Height = 21000, 29700
            style.PrintGrid = True
            style.HeaderIsOn = False
            for c in range(end.EndColumn + 1):
                col = columns.getByIndex(c)
                col.OptimalWidth = True
                if col.Width > 8000:
                    col.Width = 8000
                    col.IsTextWrapped = True
        width = 0
        areas = sheet.getPrintAreas()
        spans = [(a.StartColumn, a.EndColumn) for a in areas] or [(0, end.EndColumn)]
        for start, stop in spans:
            for c in range(start, min(stop, 1023) + 1):
                col = columns.getByIndex(c)
                if col.IsVisible:
                    width += col.Width
        orientation = options.get("orientation", "auto")
        portrait = min(style.Width, style.Height), max(style.Width, style.Height)
        printable = portrait[0] - style.LeftMargin - style.RightMargin
        landscape = (
            orientation == "landscape"
            or (orientation == "auto" and (style.IsLandscape or width > printable))
        )
        style.IsLandscape = landscape
        style.Width, style.Height = (portrait[1], portrait[0]) if landscape else portrait
        if options.get("fit", True):
            # As wide as one page, as many pages down as it needs.
            style.ScaleToPagesX = 1
            style.ScaleToPagesY = 0
    return anything


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--uno":
    sys.exit(_uno_main(sys.argv[2]))
else:
    _not_dumpable()
