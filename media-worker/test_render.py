"""
Tests for render.py: the address checks, the SOCKS5 guard every browser
connection goes through, and real Chromium jobs against local sites, some
of them hostile. Run with `npm run test:render` (or `python3 media-worker/test_render.py`);
needs Playwright and its Chromium (RENDER_CHROMIUM may name the binary).

The "public" site is a loopback port the guard is told to let through
(TEST_ADDRESSES, as in production nothing on loopback is). Everything a
hostile page tries to reach (another loopback port, [::1], 127.0.0.2,
cloud metadata, private names) is a listener that records any hit: each
test checks it got none, not only that the job said "blocked".
"""

import asyncio
import hashlib
import ipaddress
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("RENDER_LOAD_SECONDS", "6")
os.environ.setdefault("RENDER_MAX_SECONDS", "25")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render  # noqa: E402

PIXEL = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8cfc0f01f0005000201e2b1e9d30000000049454e44ae426082"
)
STOP = threading.Event()


def page(title: str, body: str = "", head: str = "") -> bytes:
    return f"<!doctype html><html><head><meta charset=utf-8><title>{title}</title>{head}</head><body>{body}</body></html>".encode()


class Recorder:
    def __init__(self):
        self.hits: list[tuple[str, str, dict]] = []
        self.lock = threading.Lock()

    def add(self, host, path, headers):
        with self.lock:
            self.hits.append((host, path, headers))

    def paths(self):
        with self.lock:
            return [p for _, p, _ in self.hits]


PUBLIC = Recorder()
HOSTILE = Recorder()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Server6(Server):
    address_family = socket.AF_INET6


def public_handler(port_of):
    class Public(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def send(self, body: bytes, status=200, ctype="text/html; charset=utf-8", headers=()):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path
            PUBLIC.add(self.headers.get("Host", ""), path, dict(self.headers))
            P, H = port_of["public"], port_of["hostile"]
            route = path.split("?", 1)[0]
            if route == "/ok":
                return self.send(page("Spell book", "<h1>Hello from the spell book</h1><p>A page to save.</p>"))
            if route == "/redirect":
                to = path.split("to=", 1)[1]
                self.send_response(302)
                self.send_header("Location", to)
                self.send_header("Content-Length", "0")
                return self.end_headers()
            if route == "/loop":
                n = int(path.split("n=", 1)[1]) if "n=" in path else 0
                self.send_response(302)
                self.send_header("Location", f"/loop?n={n + 1}")
                self.send_header("Content-Length", "0")
                return self.end_headers()
            if route == "/hang-headers":
                STOP.wait(60)
                return
            if route == "/hang-body":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(page("Partial page", "<h1>This part arrived</h1>")[:-14])
                self.wfile.flush()
                STOP.wait(60)
                return
            if route == "/huge":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                chunk = b"<p>" + b"x" * 65000 + b"</p>\n"
                try:
                    self.wfile.write(b"<title>Huge</title>")
                    for _ in range(1000):  # about 65 MB
                        self.wfile.write(chunk)
                except OSError:
                    pass
                return
            if route == "/medium":
                return self.send(page("Medium", "".join(f"<p>Paragraph {i}.</p>" for i in range(80))))
            if route == "/frames":
                return self.send(page("Frames", f'<h1>Frames</h1><iframe src="http://other.test:{P}/ok?framed=1"></iframe>'))
            if route == "/tall":
                return self.send(page("Tall", "".join(f"<p>Paragraph {i} of a very long page.</p>" for i in range(600))))
            if route == "/pixel.png":
                return self.send(PIXEL, ctype="image/png")
            if route == "/many-images":
                return self.send(page("Many", "".join(f'<img src="/pixel.png?i={i}" width=4 height=4>' for i in range(60))))
            if route == "/private-subs":
                targets = [f"http://127.0.0.1:{H}", f"http://[::1]:{H}", "http://169.254.169.254", "http://10.0.0.1",
                           f"http://evil.test:{H}", f"http://meta.test:{H}", f"http://2130706433:{H}", f"http://0x7f.0.0.1:{H}"]
                tags = "".join(
                    f'<img src="{t}/img.png"><script src="{t}/x.js"></script><link rel=stylesheet href="{t}/x.css">'
                    f'<iframe src="{t}/frame"></iframe><video src="{t}/v.mp4"></video>' for t in targets)
                script = "".join(
                    f'fetch("{t}/fetch").catch(()=>{{}}); navigator.sendBeacon("{t}/beacon", "x");'
                    f'try {{ new EventSource("{t}/sse"); }} catch (e) {{}}'
                    f'try {{ new Worker("{t}/worker.js"); }} catch (e) {{}}'
                    f'(() => {{ const x = new XMLHttpRequest(); x.open("GET", "{t}/xhr"); x.send(); }})();' for t in targets)
                return self.send(page("Private subresources", "<h1>Still printed</h1>" + tags + f"<script>{script}</script>"))
            if route == "/file-scheme":
                body = ('<h1>Local files</h1><iframe src="file:///etc/passwd"></iframe><img src="file:///etc/hostname">'
                        '<a id=a href="file:///etc/passwd">file</a>'
                        '<script>setTimeout(() => { try { location.href = "file:///etc/passwd"; } catch (e) {} }, 200);'
                        'fetch("file:///etc/passwd").catch(() => {});</script>')
                return self.send(page("File test", body))
            if route == "/popup":
                body = (f'<h1>Popups</h1><script>window.open("/popup-target");'
                        'const a = document.createElement("a"); a.href = "/popup-target2"; a.target = "_blank";'
                        'document.body.append(a); a.click();</script>')
                return self.send(page("Popups", body))
            if route == "/download-page":
                body = ('<h1>Download</h1><script>'
                        'const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["x"]));'
                        'a.download = "x.txt"; document.body.append(a); a.click();'
                        'setTimeout(() => { location.href = "/file.bin"; }, 100);</script>')
                return self.send(page("Has a download", body))
            if route == "/file.bin":
                return self.send(b"\0" * 4096, ctype="application/octet-stream",
                                 headers=[("Content-Disposition", 'attachment; filename="file.bin"')])
            if route == "/sw":
                body = ('<h1>Service worker</h1><script>'
                        '(navigator.serviceWorker ? navigator.serviceWorker.register("/sw.js").then(() => "registered") : Promise.resolve("blocked"))'
                        '.catch(() => "blocked").then((s) => { document.title = "sw " + s; });</script>')
                return self.send(page("sw pending", body))
            if route == "/sw.js":
                return self.send(b"self.addEventListener('fetch', () => {});", ctype="text/javascript")
            if route == "/ws-page":
                body = (f'<h1>Sockets</h1><script>for (const u of ["ws://public.test:{P}/ws", "ws://127.0.0.1:{H}/ws", "ws://[::1]:{H}/ws"]) '
                        '{ try { new WebSocket(u); } catch (e) {} }</script>')
                return self.send(page("Sockets", body))
            if route == "/rtc":
                body = (f'<h1>RTC</h1><script>document.title = "rtc " + typeof RTCPeerConnection;'
                        f'try {{ const pc = new RTCPeerConnection({{iceServers: [{{urls: "stun:127.0.0.1:{port_of["udp"]}"}}]}});'
                        'pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)); } catch (e) {}</script>')
                return self.send(page("rtc pending", body))
            if route == "/set-cookie":
                return self.send(page("Cookie set", "<h1>Cookie</h1>"), headers=[("Set-Cookie", "spell=secret; Max-Age=3600; Path=/")])
            if route == "/echo":
                return self.send(page("Echo", "<h1>Echo</h1>"))
            if route == "/storage":
                body = ('<script>const n = Number(localStorage.getItem("n") || 0) + 1; localStorage.setItem("n", n);'
                        'document.title = "visit " + n;</script>')
                return self.send(page("visit", body))
            if route == "/auth":
                return self.send(b"no", status=401, headers=[("WWW-Authenticate", 'Basic realm="x"')])
            if route == "/rebind-page":
                imgs = "".join(f'<img src="http://rebind.test:{P}/pixel.png?r={i}">' for i in range(8))
                return self.send(page("Rebind", "<h1>Rebind</h1>" + imgs))
            if route == "/js-away":
                to = path.split("to=", 1)[1]
                return self.send(page("Stays", f'<h1>Stays put</h1><script>setTimeout(() => {{ location.href = "{to}"; }}, 50);</script>'))
            if route == "/elsewhere":
                return self.send(page("Elsewhere", "<h1>Navigated away</h1>"))
            self.send(b"not found", status=404, ctype="text/plain")

    return Public


class Hostile(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        HOSTILE.add(self.server.server_address[0], self.path, dict(self.headers))
        body = b"<title>SECRET</title>INTERNAL SECRET"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET


class FakeDns:
    """Names the tests control; rebind.test answers differently after its first lookup."""

    def __init__(self):
        self.calls: dict[str, int] = {}

    async def __call__(self, host, port):
        self.calls[host] = self.calls.get(host, 0) + 1
        table = {
            "public.test": ["127.0.0.1"],
            "evil.test": ["10.0.0.7"],
            "meta.test": ["169.254.169.254"],
            "mapped.test": ["::ffff:127.0.0.1"],
            "mixed.test": ["127.0.0.1", "10.1.2.3"],
            "nat64.test": ["64:ff9b::a9fe:a9fe"],
            "localhost": ["127.0.0.1", "::1"],
            "other.test": ["127.0.0.1"],
        }
        if host == "rebind.test":
            return ["127.0.0.1"] if self.calls[host] == 1 else ["127.0.0.2"]
        return table.get(host, [])


DNS = FakeDns()
PORTS: dict[str, int] = {}
SERVERS = []
SOCKETS = []
UDP_PACKETS: list[bytes] = []
HAS_V6 = socket.has_ipv6


def setUpModule():
    hostile = Server(("127.0.0.1", 0), Hostile)
    PORTS["hostile"] = hostile.server_address[1]
    public = Server(("127.0.0.1", 0), public_handler(PORTS))
    PORTS["public"] = public.server_address[1]
    SERVERS.extend([public, hostile])
    # The same port on 127.0.0.2: where rebind.test points after its first answer.
    SERVERS.append(Server(("127.0.0.2", PORTS["public"]), Hostile))
    global HAS_V6
    try:
        SERVERS.append(Server6(("::1", PORTS["hostile"]), Hostile))
    except OSError:
        HAS_V6 = False
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    SOCKETS.append(udp)
    udp.bind(("127.0.0.1", 0))
    PORTS["udp"] = udp.getsockname()[1]

    def listen_udp():
        udp.settimeout(0.5)
        while not STOP.is_set():
            try:
                UDP_PACKETS.append(udp.recvfrom(4096)[0])
            except socket.timeout:
                pass
    threading.Thread(target=listen_udp, daemon=True).start()
    for s in SERVERS:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    render.TEST_ADDRESSES.add(("127.0.0.1", PORTS["public"]))
    render.service.resolve = DNS
    render.service.start()


def tearDownModule():
    STOP.set()
    render.cleanup()
    for s in SERVERS:
        s.shutdown()
        s.server_close()
    for s in SOCKETS:
        s.close()


def url(path: str, host: str = "public.test", port: int | None = None) -> str:
    return f"http://{host}:{port or PORTS['public']}{path}"


def run_job(target=None, html=None, name=None, options=None, pages=100, wait=40.0):
    grant = {"k": "render", "m": "html" if html is not None else "url", "o": options or {"f": "a4", "g": "small", "b": 1, "p": "screen"}, "x": pages}
    if target:
        grant["u"] = target
    started = time.monotonic()
    job = render.service.submit(grant, html, name)
    while job["status"] == "working" and time.monotonic() - started < wait:
        time.sleep(0.1)
    job["elapsed"] = time.monotonic() - started
    return job


def pdf_text(pdf: bytes) -> str | None:
    """The PDF's text with pdftotext, when it is installed."""
    if not shutil.which("pdftotext"):
        return None
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf)
        f.flush()
        return subprocess.run(["pdftotext", f.name, "-"], capture_output=True, text=True).stdout


def media_box(pdf: bytes) -> list[float]:
    import re
    return [float(x) for x in re.search(rb"/MediaBox\s*\[([^\]]+)\]", pdf).group(1).split()]


class AddressTests(unittest.TestCase):
    def test_blocked(self):
        for addr, why in [
            ("127.0.0.1", "loopback"), ("127.1.2.3", "loopback"), ("0.0.0.0", "this-network"),
            ("10.1.2.3", "private"), ("172.16.0.1", "private"), ("172.31.255.255", "private"), ("192.168.1.1", "private"),
            ("100.64.0.1", "cgnat"), ("100.100.100.200", "cgnat"), ("169.254.169.254", "metadata"), ("169.254.1.1", "link-local"),
            ("224.0.0.1", "multicast"), ("239.255.255.250", "multicast"), ("255.255.255.255", "reserved"), ("240.0.0.1", "reserved"),
            ("192.0.0.192", "reserved"), ("198.18.0.1", "reserved"), ("192.0.2.1", "reserved"),
            ("::1", "loopback"), ("::", "this-network"), ("fe80::1", "link-local"), ("fc00::1", "private"), ("fd12:3456::1", "private"),
            ("fd00:ec2::254", "metadata"), ("ff02::1", "multicast"), ("::ffff:127.0.0.1", "loopback"), ("::ffff:169.254.169.254", "metadata"),
            ("::ffff:10.0.0.1", "private"), ("64:ff9b::a9fe:a9fe", "metadata"), ("64:ff9b::7f00:1", "loopback"),
            ("2002:7f00:0001::1", "loopback"), ("2002:a9fe:a9fe::1", "metadata"), ("2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"),
            ("::127.0.0.1", "loopback"), ("2001:db8::1", "reserved"), ("fe80::1%eth0", "link-local"),
        ]:
            with self.subTest(addr=addr):
                self.assertEqual(render.address_problem(addr), why)

    def test_public(self):
        for addr in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]:
            with self.subTest(addr=addr):
                self.assertIsNone(render.address_problem(addr))

    def test_ports(self):
        self.assertTrue(all(render.allowed_port(p) for p in (80, 443, 1024, 8080, 8443, 65535)))
        self.assertFalse(any(render.allowed_port(p) for p in (0, 21, 22, 25, 81, 110, 445, 1023)))

    def test_test_addresses_only_loopback(self):
        out = subprocess.run(
            [sys.executable, "-c", "import render; print(sorted(render.TEST_ADDRESSES))"],
            env={**os.environ, "RENDER_TEST_ADDRESSES": "127.0.0.1:4813, 10.0.0.1:80, 169.254.169.254:80, [::1]:4814, junk"},
            cwd=os.path.dirname(os.path.abspath(__file__)), capture_output=True, text=True,
        ).stdout.strip()
        self.assertEqual(out, "[('127.0.0.1', 4813), ('::1', 4814)]")

    def test_filenames(self):
        self.assertEqual(render.pdf_filename("Report: Q3/Q4 ‮gnp.exe", "x"), "Report Q3 Q4 gnp.exe.pdf")
        self.assertEqual(render.pdf_filename("  ", "example.com"), "example.com.pdf")
        self.assertEqual(render.pdf_filename("星の魔法 — ночь", "x"), "星の魔法 — ночь.pdf")

    def test_grants(self):
        html = "<p>hi</p>"
        good = {"k": "render", "m": "html", "n": len(html), "d": hashlib.sha256(html.encode()).hexdigest()}
        self.assertIsNone(render._grant_problem(good, html, "a.html"))
        self.assertIsNotNone(render._grant_problem({**good, "d": "0" * 64}, html, None))
        self.assertIsNotNone(render._grant_problem(good, html + " ", None))
        self.assertIsNotNone(render._grant_problem({**good, "k": "mp4"}, html, None))
        self.assertIsNone(render._grant_problem({"k": "render", "m": "url", "u": "https://example.com/"}, None, None))
        for bad in ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "https://user:pw@example.com/", "data:text/html,hi", "chrome://settings"]:
            with self.subTest(url=bad):
                self.assertIsNotNone(render._grant_problem({"k": "render", "m": "url", "u": bad}, None, None))
        big = "x" * (render.MAX_HTML + 1)
        self.assertIsNotNone(render._grant_problem({**good, "n": len(big), "d": hashlib.sha256(big.encode()).hexdigest()}, big, None))


async def socks_connect(port: int, host: str, target_port: int, request: bytes | None = None):
    """A SOCKS5 CONNECT as Chromium sends it (names as names); the reply code and any answer."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"\x05\x01\x00")
    await writer.drain()
    await reader.readexactly(2)
    try:
        packed = b"\x01" + socket.inet_pton(socket.AF_INET, host)
    except OSError:
        try:
            packed = b"\x04" + socket.inet_pton(socket.AF_INET6, host)
        except OSError:
            packed = b"\x03" + bytes([len(host)]) + host.encode()
    writer.write(b"\x05\x01\x00" + packed + struct.pack(">H", target_port))
    await writer.drain()
    reply = await reader.readexactly(10)
    answer = b""
    if reply[1] == 0 and request:
        writer.write(request)
        await writer.drain()
        answer = await asyncio.wait_for(reader.read(-1), 5)
    writer.close()
    return reply[1], answer


class GuardTests(unittest.TestCase):
    def guard(self, coro_fn):
        async def go():
            g = render.Guard(DNS)
            await g.start()
            try:
                return g, await coro_fn(g)
            finally:
                await g.close()
        return asyncio.run(go())

    def test_refuses_private_and_connects_to_checked_address(self):
        before = len(HOSTILE.hits)
        get = b"GET /ok HTTP/1.0\r\nHost: x\r\n\r\n"

        async def go(g):
            P, H = PORTS["public"], PORTS["hostile"]
            return [
                await socks_connect(g.port, "public.test", P, get),
                await socks_connect(g.port, "127.0.0.1", H, get),
                await socks_connect(g.port, "::1", H, get),
                await socks_connect(g.port, "evil.test", H, get),
                await socks_connect(g.port, "meta.test", 80, get),
                await socks_connect(g.port, "mapped.test", H, get),
                await socks_connect(g.port, "mixed.test", P, get),
                await socks_connect(g.port, "nat64.test", 80, get),
                await socks_connect(g.port, "169.254.169.254", 80, get),
                await socks_connect(g.port, "public.test", 22, get),
                await socks_connect(g.port, "nowhere.test", 80, get),
                await socks_connect(g.port, "bad name", 80, get),
            ]
        g, replies = self.guard(go)
        codes = [r[0] for r in replies]
        self.assertEqual(codes[0], 0)
        self.assertIn(b"Hello from the spell book", replies[0][1])
        self.assertEqual(codes[1:10], [2] * 9, codes)
        self.assertEqual(codes[10], 4)
        self.assertNotEqual(codes[11], 0)
        self.assertEqual(len(HOSTILE.hits), before, HOSTILE.hits[before:])
        reasons = dict(g.blocked)
        self.assertEqual(reasons.get("meta.test"), "metadata")
        self.assertEqual(reasons.get("mixed.test"), "private")
        self.assertEqual(reasons.get("nat64.test"), "metadata")

    def test_rebinding_is_pinned(self):
        DNS.calls.pop("rebind.test", None)
        before = len(HOSTILE.hits)

        async def go(g):
            out = []
            for i in range(4):
                out.append(await socks_connect(g.port, "rebind.test", PORTS["public"], f"GET /ok?{i} HTTP/1.0\r\nHost: rebind.test\r\n\r\n".encode()))
            return out
        g, replies = self.guard(go)
        self.assertTrue(all(code == 0 and b"spell book" in answer for code, answer in replies))
        self.assertEqual(DNS.calls["rebind.test"], 1)
        self.assertEqual(len(HOSTILE.hits), before, "the address rebind.test changed to was reached")

    def test_traffic_cap(self):
        old = render.MAX_TRAFFIC
        render.MAX_TRAFFIC = 2 * 1024 * 1024
        try:
            async def go(g):
                return await socks_connect(g.port, "public.test", PORTS["public"], b"GET /huge HTTP/1.0\r\nHost: x\r\n\r\n")
            g, (code, answer) = self.guard(go)
        finally:
            render.MAX_TRAFFIC = old
        self.assertEqual(code, 0)
        self.assertEqual(g.over, "bytes")
        self.assertLess(len(answer), 3 * 1024 * 1024)


class BrowserTests(unittest.TestCase):
    """Real Chromium jobs. Each checks the hostile listeners stayed silent."""

    def setUp(self):
        self.hostile_before = len(HOSTILE.hits)
        self.udp_before = len(UDP_PACKETS)
        if not render.service.available:
            self.fail("Playwright isn't installed")

    def tearDown(self):
        self.assertEqual(HOSTILE.hits[self.hostile_before:], [], "a private address was reached")

    def ready(self, job):
        self.assertEqual(job["status"], "ready", job.get("error"))
        self.assertTrue(job["pdf"].startswith(b"%PDF-"))
        return job

    def failed(self, job, words):
        self.assertEqual(job["status"], "error", f"expected an error, got {job['status']}")
        self.assertIn(words, job["error"])
        return job

    def test_a_page_becomes_a_pdf(self):
        job = self.ready(run_job(url("/ok")))
        self.assertEqual(job["pages"], 1)
        self.assertEqual(job["filename"], "Spell book.pdf")
        self.assertEqual([round(x) for x in media_box(job["pdf"])], [0, 0, 596, 843])
        text = pdf_text(job["pdf"])
        if text is not None:
            self.assertIn("Hello from the spell book", text)

    def test_page_options(self):
        letter = self.ready(run_job(url("/ok"), options={"f": "letter", "l": 1, "g": "none", "b": 0, "p": "print"}))
        self.assertEqual([round(x) for x in media_box(letter["pdf"])], [0, 0, 792, 612])
        fit = self.ready(run_job(url("/medium"), options={"f": "fit", "g": "none", "b": 1, "p": "screen"}))
        box = media_box(fit["pdf"])
        self.assertEqual(round(box[2]), 960)  # 1280 CSS pixels
        self.assertGreater(box[3], 2000)
        self.assertEqual(fit["pages"], 1)
        # Taller than 200 inches: pages of 200 inches each.
        tall = self.ready(run_job(url("/tall"), options={"f": "fit", "g": "none", "b": 1, "p": "screen"}))
        self.assertEqual(round(media_box(tall["pdf"])[3]), 200 * 72)
        self.assertGreater(tall["pages"], 1)

    def test_later_page_changes_to_private_addresses(self):
        H = PORTS["hostile"]
        for to in [f"http://127.0.0.1:{H}/", f"http://evil.test:{H}/", "http://169.254.169.254/", "file:///etc/passwd"]:
            with self.subTest(to=to):
                job = self.ready(run_job(url(f"/js-away?to={to}")))
                self.assertEqual(job["filename"], "Stays.pdf")
                text = pdf_text(job["pdf"])
                if text is not None:
                    self.assertIn("Stays put", text)

    def test_frames_from_other_sites(self):
        self.ready(run_job(url("/frames")))
        self.assertTrue(any(h.startswith("other.test") and p == "/ok?framed=1" for h, p, _ in PUBLIC.hits))

    def test_redirects_to_private_addresses(self):
        H = PORTS["hostile"]
        targets = [f"http://127.0.0.1:{H}/secret", "http://169.254.169.254/latest/meta-data/", f"http://2130706433:{H}/",
                   f"http://0x7f000001:{H}/", f"http://0177.0.0.1:{H}/", f"http://evil.test:{H}/", f"http://meta.test:{H}/",
                   f"http://mapped.test:{H}/", f"http://localhost:{H}/"]
        if HAS_V6:
            targets += [f"http://[::1]:{H}/secret", f"http://[::ffff:127.0.0.1]:{H}/"]
        for target in targets:
            with self.subTest(target=target):
                self.failed(run_job(url(f"/redirect?to={target}")), "private or local network")

    def test_private_hosts_directly(self):
        H = PORTS["hostile"]
        for target in [f"http://127.0.0.1:{H}/", f"http://evil.test:{H}/", f"http://mixed.test:{PORTS['public']}/ok", "http://meta.test/"]:
            with self.subTest(target=target):
                self.failed(run_job(target), "private or local network")
        self.failed(run_job("http://nowhere.test/"), "couldn't find that site")

    def test_rebinding_host(self):
        DNS.calls.pop("rebind.test", None)
        job = self.ready(run_job(url("/rebind-page", host="rebind.test")))
        self.assertEqual(job["filename"], "Rebind.pdf")
        self.assertEqual(DNS.calls["rebind.test"], 1)
        self.assertTrue(any(p.startswith("/pixel.png?r=") for p in PUBLIC.paths()))

    def test_private_subresources_are_not_fetched(self):
        job = self.ready(run_job(url("/private-subs")))
        whys = {why for _, why in job["guard"].blocked}
        self.assertTrue({"loopback", "metadata", "private"} <= whys, whys)
        text = pdf_text(job["pdf"])
        if text is not None:
            self.assertIn("Still printed", text)
            self.assertNotIn("SECRET", text)

    def test_file_urls(self):
        job = self.ready(run_job(url("/file-scheme")))
        self.assertEqual(job["filename"], "File test.pdf")
        text = pdf_text(job["pdf"])
        if text is not None:
            self.assertIn("Local files", text)
            self.assertNotIn("root:", text)

    def test_endless_redirects(self):
        self.failed(run_job(url("/loop")), "redirects too many times")

    def test_a_site_that_never_answers(self):
        job = self.failed(run_job(url("/hang-headers")), "took too long to answer")
        self.assertLess(job["elapsed"], render.LOAD_SECONDS + 5)

    def test_a_page_that_never_finishes_loading(self):
        job = self.ready(run_job(url("/hang-body")))
        self.assertLess(job["elapsed"], render.JOB_SECONDS)
        text = pdf_text(job["pdf"])
        if text is not None:
            self.assertIn("This part arrived", text)

    def test_a_huge_page(self):
        old = render.MAX_TRAFFIC
        render.MAX_TRAFFIC = 4 * 1024 * 1024
        try:
            job = self.failed(run_job(url("/huge")), "too big")
        finally:
            render.MAX_TRAFFIC = old
        self.assertLess(job["guard"].traffic, 6 * 1024 * 1024)

    def test_page_cap(self):
        job = self.ready(run_job(url("/tall"), pages=3))
        self.assertEqual(job["pages"], 3)
        self.assertTrue(job["cut"])
        whole = self.ready(run_job(url("/tall")))
        self.assertGreater(whole["pages"], 3)
        self.assertFalse(whole["cut"])

    def test_request_cap(self):
        old = render.MAX_REQUESTS
        render.MAX_REQUESTS = 10
        before = len([p for p in PUBLIC.paths() if p.startswith("/pixel.png?i=")])
        try:
            self.ready(run_job(url("/many-images")))
        finally:
            render.MAX_REQUESTS = old
        fetched = len([p for p in PUBLIC.paths() if p.startswith("/pixel.png?i=")]) - before
        self.assertLessEqual(fetched, 9)

    def test_popups_are_not_opened(self):
        self.ready(run_job(url("/popup")))
        time.sleep(0.5)
        self.assertFalse([p for p in PUBLIC.paths() if p.startswith("/popup-target")])

    def test_downloads(self):
        job = self.ready(run_job(url("/download-page")))
        self.assertEqual(job["filename"], "Has a download.pdf")
        self.failed(run_job(url("/file.bin")), "downloads a file")

    def test_service_workers_are_blocked(self):
        job = self.ready(run_job(url("/sw")))
        self.assertEqual(job["filename"], "sw blocked.pdf")
        self.assertNotIn("/sw.js", PUBLIC.paths())

    def test_websockets_are_not_opened(self):
        self.ready(run_job(url("/ws-page")))
        self.assertNotIn("/ws", PUBLIC.paths())

    def test_webrtc_is_gone(self):
        job = self.ready(run_job(url("/rtc")))
        self.assertEqual(job["filename"], "rtc undefined.pdf")
        time.sleep(0.5)
        self.assertEqual(UDP_PACKETS[self.udp_before:], [])

    def test_fresh_context_no_cookies(self):
        self.ready(run_job(url("/set-cookie")))
        self.ready(run_job(url("/echo")))
        echo = [h for _, p, h in PUBLIC.hits if p == "/echo"][-1]
        self.assertNotIn("Cookie", echo)
        self.assertNotIn("Authorization", echo)
        first = self.ready(run_job(url("/storage")))
        second = self.ready(run_job(url("/storage")))
        self.assertEqual((first["filename"], second["filename"]), ("visit 1.pdf", "visit 1.pdf"))

    def test_sign_in_pages(self):
        self.failed(run_job(url("/auth")), "needs a sign-in")
        self.assertFalse(any("Authorization" in h for _, p, h in PUBLIC.hits if p == "/auth"))

    def test_ports_below_1024(self):
        self.failed(run_job(url("/ok", port=81)), "port")

    def test_pasted_html(self):
        H = PORTS["hostile"]
        html = ("<title>Pasted</title><h1>Pasted HTML</h1>"
                f'<img src="http://127.0.0.1:{H}/img.png"><img src="{url("/pixel.png?pasted=1")}"><img src="local.png">'
                f'<iframe src="file:///etc/passwd"></iframe><script>fetch("http://169.254.169.254/").catch(() => {{}});</script>'
                f'<meta http-equiv="refresh" content="0;url={url("/elsewhere")}">')
        job = self.ready(run_job(html=html, name="My page.html"))
        self.assertEqual(job["filename"], "My page.pdf")
        time.sleep(0.3)
        self.assertIn("/pixel.png?pasted=1", PUBLIC.paths())
        self.assertNotIn("/elsewhere", PUBLIC.paths())
        text = pdf_text(job["pdf"])
        if text is not None:
            self.assertIn("Pasted HTML", text)
        untitled = self.ready(run_job(html="<p>No title</p>"))
        self.assertEqual(untitled["filename"], "page.pdf")

    def test_cancel(self):
        started = time.monotonic()
        job = render.service.submit({"k": "render", "m": "url", "u": url("/hang-headers"), "o": {}, "x": 10}, None, None)
        time.sleep(1)
        render.service.cancel(job)
        while time.monotonic() - started < 10 and "finished" not in job:
            time.sleep(0.05)
        self.assertEqual((job["status"], job["error"]), ("error", "Cancelled."))
        self.assertLess(time.monotonic() - started, 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
