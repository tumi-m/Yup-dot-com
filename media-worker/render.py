"""
Web page to PDF for the media worker: a page (from its address, or HTML the
visitor uploaded or pasted) is opened in headless Chromium, driven by
Playwright, and printed to PDF. worker.py registers it with a few lines:

  POST   /render            {"token": grant from /api/render/link, "html"?: the page, "name"?: its file name}
  GET    /render/<id>       {"status", "stage", "progress", "pages", "size", "filename", "cut", "error"}
  GET    /render/<id>/file  the PDF; it is deleted from memory once it has been sent
  DELETE /render/<id>       cancel the job, or delete its PDF

Keeping the page off private networks. Every connection Chromium makes (the
page, its redirects, subresources, frames, workers, websockets, anything)
goes through a small SOCKS5 proxy in this process, one per job, never
straight out: each job's browser context is told to use it, loopback
included, and Chromium's own DNS is switched off. The proxy resolves the
name itself, refuses it if any answer is loopback, private, link-local
(cloud metadata), CGNAT, multicast, reserved, or one of those inside an
IPv6 address (IPv4-mapped, 6to4, NAT64, Teredo), and connects to the
address it checked. A name's first answer is kept for the rest of the job,
so a name that changes its answer (DNS rebinding) can't reach anything new.
On top of that, every request is checked by scheme (http and https only)
and counted, video and audio aren't fetched, websockets aren't opened,
service workers, downloads, popups and permissions are off, the proxy caps
connections and bytes, and each job has a fresh context with no cookies or
credentials and a time limit.

Pasted or uploaded HTML is served to the browser from memory under a name
that never resolves (html.invalid), so relative links lead nowhere; public
http(s) pictures, styles and fonts load under the same rules, and the page
can't navigate away.
"""

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import struct
import tempfile
import threading
import time
import unicodedata
import urllib.parse

MAX_CONCURRENT = int(os.environ.get("RENDER_MAX_CONCURRENT", "2"))
# Jobs waiting for a free browser beyond the ones rendering.
MAX_QUEUE = int(os.environ.get("RENDER_MAX_QUEUE", "8"))
# The whole job, from opening the page to the finished PDF.
JOB_SECONDS = float(os.environ.get("RENDER_MAX_SECONDS", "60"))
# How long the page may take to load before what has arrived is printed.
LOAD_SECONDS = float(os.environ.get("RENDER_LOAD_SECONDS", "20"))
MAX_REQUESTS = int(os.environ.get("RENDER_MAX_REQUESTS", "400"))
MAX_CONNECTIONS = int(os.environ.get("RENDER_MAX_CONNECTIONS", "400"))
# Bytes the proxy carries for one job, both ways.
MAX_TRAFFIC = int(os.environ.get("RENDER_MAX_DOWNLOAD_BYTES", str(50 * 1024**2)))
MAX_PDF = int(os.environ.get("RENDER_MAX_PDF_BYTES", str(40 * 1024**2)))
MAX_HTML = int(os.environ.get("RENDER_MAX_HTML_BYTES", str(5 * 1024**2)))
# The most pages any grant may ask for; the web app sends the plan's.
HARD_MAX_PAGES = int(os.environ.get("RENDER_MAX_PAGES", "500"))
# A finished PDF waits this long to be downloaded, then is deleted.
RESULT_TTL = float(os.environ.get("RENDER_RESULT_TTL_SECONDS", "120"))
# Chromium's binary. Unset: the one `playwright install` put in place.
CHROMIUM = os.environ.get("RENDER_CHROMIUM") or None
# "auto" tries Chromium's sandbox and runs without it if it can't start
# (most containers); "1" refuses to render without it; "0" never tries.
SANDBOX = os.environ.get("RENDER_SANDBOX", "auto").strip().lower()
# Tests only: loopback "ip:port" pairs the guard lets through. Leave unset.
TEST_ADDRESSES = set()
for _pair in os.environ.get("RENDER_TEST_ADDRESSES", "").split(","):
    _host, _, _port = _pair.strip().rpartition(":")
    try:
        if ipaddress.ip_address(_host.strip("[]")).is_loopback and _port.isdigit():
            TEST_ADDRESSES.add((str(ipaddress.ip_address(_host.strip("[]"))), int(_port)))
    except ValueError:
        pass

VIEWPORT = {"width": 1280, "height": 800}
# The document of a pasted or uploaded page: .invalid never resolves anywhere.
# Plain http, so the page's http pictures aren't blocked as mixed content.
HTML_ORIGIN = "http://html.invalid"
HTML_URL = HTML_ORIGIN + "/"
MARGINS = {"none": "0", "small": "10mm", "large": "20mm"}
# Chromium and PDF readers top out near 200 inches a page; a taller "fit"
# page is split into pages this tall.
FIT_MAX_PX = 200 * 96


# ---------------------------------------------------------------------------
# Which addresses a page may reach
# ---------------------------------------------------------------------------

def _nets(*pairs):
    return [(ipaddress.ip_network(n), why) for n, why in pairs]


# Checked in order, so the cloud metadata addresses are named as such.
BLOCKED = _nets(
    ("169.254.169.254/32", "metadata"),
    ("fd00:ec2::254/128", "metadata"),
    ("0.0.0.0/8", "this-network"),
    ("10.0.0.0/8", "private"),
    ("100.64.0.0/10", "cgnat"),
    ("127.0.0.0/8", "loopback"),
    ("169.254.0.0/16", "link-local"),
    ("172.16.0.0/12", "private"),
    ("192.0.0.0/24", "reserved"),
    ("192.0.2.0/24", "reserved"),
    ("192.88.99.0/24", "reserved"),
    ("192.168.0.0/16", "private"),
    ("198.18.0.0/15", "reserved"),
    ("198.51.100.0/24", "reserved"),
    ("203.0.113.0/24", "reserved"),
    ("224.0.0.0/4", "multicast"),
    ("240.0.0.0/4", "reserved"),
    ("::/128", "this-network"),
    ("::1/128", "loopback"),
    ("64:ff9b:1::/48", "reserved"),
    ("100::/64", "reserved"),
    ("2001::/23", "reserved"),
    ("2001:db8::/32", "reserved"),
    ("fc00::/7", "private"),
    ("fe80::/10", "link-local"),
    ("fec0::/10", "link-local"),
    ("ff00::/8", "multicast"),
)
NAT64 = ipaddress.ip_network("64:ff9b::/96")
V4_COMPAT = ipaddress.ip_network("::/96")


def address_problem(ip) -> str | None:
    """Why a page may not reach this address, or None for a public one."""
    if isinstance(ip, str):
        ip = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        # IPv4 carried inside IPv6 is judged as the IPv4 address it reaches.
        if ip.ipv4_mapped:
            return address_problem(ip.ipv4_mapped)
        if ip.teredo:
            return "reserved"
        if ip.sixtofour:
            return address_problem(ip.sixtofour)
        if ip in NAT64 or (ip in V4_COMPAT and int(ip) > 1):
            return address_problem(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    for net, why in BLOCKED:
        if ip.version == net.version and ip in net:
            return why
    # Anything else IANA doesn't call global (a range added after this list).
    return None if ip.is_global else "reserved"


def allowed_port(port: int) -> bool:
    # The web's own ports, and the high ones sites run on. Not mail, SSH and
    # the other services that live below 1024.
    return port in (80, 443) or 1024 <= port <= 65535


async def system_resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen = []
    for info in infos:
        addr = info[4][0].split("%", 1)[0]
        if addr not in seen:
            seen.append(addr)
    return seen


# Tests swap this for a resolver they control.
RESOLVE = system_resolve
HOST_NAME = re.compile(r"^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*\.?$")


class Guard:
    """One job's SOCKS5 proxy: every connection the browser makes comes here,
    is checked, and goes on only to the address that was checked."""

    def __init__(self, resolve=None):
        self.resolve = resolve or RESOLVE
        # Name -> the addresses its first lookup gave, for the whole job.
        self.pins: dict[str, list[str]] = {}
        self._lookups: dict[str, asyncio.Future] = {}
        self.lookups = 0
        self.blocked: list[tuple[str, str]] = []
        self.unresolved: list[str] = []
        self.unreachable: list[str] = []
        self.connections = 0
        self.refused_connections = 0
        self.traffic = 0
        # "bytes" once the traffic cap is reached: the job fails.
        self.over: str | None = None
        self.port = 0
        self._server = None
        self._writers = set()

    async def start(self):
        self._server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def close(self):
        if self._server:
            self._server.close()
        for w in list(self._writers):
            w.close()
        self._writers.clear()

    def _stop(self, why: str):
        """A cap was reached: nothing more for this job."""
        if not self.over:
            self.over = why
        for w in list(self._writers):
            w.close()

    async def _lookup(self, name: str, port: int) -> list[str]:
        """The name's addresses: looked up once, then the same for the whole job."""
        if name in self.pins:
            return self.pins[name]
        if name not in self._lookups:
            async def look():
                self.lookups += 1
                try:
                    found = await asyncio.wait_for(self.resolve(name, port), 5)
                except Exception:  # noqa: BLE001 — not found, or no answer in time
                    found = []
                addresses = []
                for a in found or []:
                    try:
                        a = str(ipaddress.ip_address(str(a).split("%", 1)[0]))
                    except ValueError:
                        continue
                    if a not in addresses:
                        addresses.append(a)
                self.pins[name] = addresses
                return addresses
            self._lookups[name] = asyncio.ensure_future(look())
        return await self._lookups[name]

    async def check(self, host: str, port: int) -> tuple[list[str], str | None]:
        """(addresses to connect to, None), or ([], why not)."""
        if not allowed_port(port):
            self.blocked.append((f"{host}:{port}", "port"))
            return [], "port"
        try:
            addresses = [str(ipaddress.ip_address(host.strip("[]")))]
            name = None
        except ValueError:
            name = host.lower().rstrip(".")
            if not HOST_NAME.match(name):
                self.blocked.append((host, "name"))
                return [], "name"
            addresses = await self._lookup(name, port)
            if not addresses:
                self.unresolved.append(name)
                return [], "unresolved"
        for addr in addresses:
            if (addr, port) in TEST_ADDRESSES:
                continue
            why = address_problem(addr)
            if why:
                # One bad answer refuses the name: a mix is how rebinding hides.
                self.blocked.append((name or addr, why))
                return [], why
        return addresses, None

    async def _client(self, reader, writer):
        self._writers.add(writer)
        upstream = None
        try:
            if self.over or self.connections >= MAX_CONNECTIONS:
                # Past the cap, new connections fail; the page keeps what it has.
                self.refused_connections += 1
                return
            self.connections += 1
            host, port = await asyncio.wait_for(self._handshake(reader, writer), 10)
            addresses, why = await self.check(host, port)
            if not addresses:
                # 0x02: connection not allowed by ruleset; 0x04: host unreachable.
                writer.write(b"\x05" + (b"\x04" if why == "unresolved" else b"\x02") + b"\x00\x01" + b"\0" * 6)
                await writer.drain()
                return
            # Only the addresses just checked: the name is never looked up again.
            for address in addresses:
                try:
                    up_reader, upstream = await asyncio.wait_for(asyncio.open_connection(address, port), 10)
                    break
                except (OSError, asyncio.TimeoutError):
                    upstream = None
            if not upstream:
                self.unreachable.append(host)
                writer.write(b"\x05\x05\x00\x01" + b"\0" * 6)
                await writer.drain()
                return
            self._writers.add(upstream)
            writer.write(b"\x05\x00\x00\x01" + b"\0" * 6)
            await writer.drain()
            await asyncio.gather(self._pipe(reader, upstream), self._pipe(up_reader, writer))
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, OSError, ValueError):
            pass
        finally:
            for w in (writer, upstream):
                if w:
                    self._writers.discard(w)
                    w.close()

    async def _handshake(self, reader, writer) -> tuple[str, int]:
        ver, count = await reader.readexactly(2)
        if ver != 5:
            raise ValueError("not SOCKS5")
        await reader.readexactly(count)
        writer.write(b"\x05\x00")  # no authentication
        await writer.drain()
        ver, cmd, _, atyp = await reader.readexactly(4)
        if ver != 5 or cmd != 1:  # CONNECT only: no BIND, no UDP
            writer.write(b"\x05\x07\x00\x01" + b"\0" * 6)
            await writer.drain()
            raise ValueError("unsupported command")
        if atyp == 1:
            host = socket.inet_ntop(socket.AF_INET, await reader.readexactly(4))
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
        elif atyp == 3:
            size = (await reader.readexactly(1))[0]
            host = (await reader.readexactly(size)).decode("ascii")
        else:
            raise ValueError("bad address type")
        port = struct.unpack(">H", await reader.readexactly(2))[0]
        return host, port

    async def _pipe(self, reader, writer):
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                self.traffic += len(chunk)
                if self.traffic > MAX_TRAFFIC:
                    self._stop("bytes")
                    break
                writer.write(chunk)
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                writer.write_eof()
            except (OSError, RuntimeError, AttributeError):
                pass


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

class RenderError(Exception):
    """A problem the visitor can act on; the message is shown as it is."""


# Runs in every frame before the page's own scripts: no popups, no print
# dialog, and no peer-to-peer connections that could go around the proxy.
PAGE_SCRIPT = """
(() => {
  const none = () => null;
  try { Object.defineProperty(window, "open", { value: none }); } catch (e) {}
  try { Object.defineProperty(window, "print", { value: () => {} }); } catch (e) {}
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport"]) {
    try { Object.defineProperty(window, name, { value: undefined }); } catch (e) {}
  }
})();
"""

# Scrolls down the page and back, so pictures that load as they come into
# view are there for the PDF.
SCROLL_SCRIPT = """
async (budget) => {
  const end = Date.now() + budget;
  const step = Math.max(200, Math.floor(innerHeight * 0.9));
  for (let y = step; Date.now() < end; y += step) {
    const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 100));
    if (y >= height) break;
  }
  window.scrollTo(0, 0);
}
"""

SIZE_SCRIPT = """
() => ({
  width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
  height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
})
"""

_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|]')


def pdf_filename(title: str | None, fallback: str) -> str:
    """The name the visitor's browser saves: the page's title in any script,
    minus characters no file system accepts and invisible ones that can
    disguise a name (bidi overrides)."""
    out = []
    for ch in unicodedata.normalize("NFKC", title or ""):
        cat = unicodedata.category(ch)
        if cat == "Cc":
            out.append(" ")
        elif cat in ("Cf", "Cs") and ch != "‍":
            continue
        else:
            out.append(ch)
    name = re.sub(r"\s+", " ", _UNSAFE_NAME.sub(" ", "".join(out))).strip(" .")
    if len(name) > 100:
        name = name[:100].rstrip(" .")
    return f"{name or fallback}.pdf"


def count_pages(pdf: bytes) -> int:
    # Chromium writes each page as an uncompressed "/Type /Page" object.
    return len(re.findall(rb"/Type\s*/Page(?![s\w])", pdf))


def net_message(error: str, guard: Guard) -> str:
    """What a failed navigation means, in words the visitor can act on."""
    e = error
    if "Download is starting" in e:
        return "That link downloads a file instead of opening a page."
    if guard.over == "bytes":
        return "This page is too big to save as a PDF."
    if "ERR_SOCKS" in e or "ERR_PROXY" in e or "ERR_TUNNEL" in e or "ERR_BLOCKED_BY_CLIENT" in e:
        if any(why == "port" for _, why in guard.blocked):
            return "That address uses a port that can't be opened."
        if guard.blocked:
            return "That address is on a private or local network, so it can't be opened."
        if guard.unresolved:
            return "We couldn't find that site. Check the address."
        return "The site didn't answer. Check the address, or try again later."
    if "ERR_TOO_MANY_REDIRECTS" in e:
        return "That page redirects too many times."
    if "ERR_UNSAFE_REDIRECT" in e or "ERR_UNSAFE_PORT" in e or "ERR_DISALLOWED_URL_SCHEME" in e:
        return "That page sends to an address that can't be opened."
    if "ERR_CERT" in e or "ERR_SSL" in e:
        return "The site's security certificate isn't valid, so it wasn't opened."
    if "ERR_EMPTY_RESPONSE" in e or "ERR_INVALID_RESPONSE" in e or "ERR_INVALID_HTTP_RESPONSE" in e:
        return "The site sent back an empty or broken answer."
    if "ERR_ABORTED" in e:
        return "The site didn't send a page."
    return "The site didn't answer. Check the address, or try again later."


def status_message(status: int) -> str:
    if status == 401:
        return "This page needs a sign-in, so it can't be saved."
    if status == 403:
        return "The site refused to show this page to us (403). Some sites block automatic visits."
    if status in (404, 410):
        return f"The site says this page doesn't exist ({status}). Check the address."
    if status == 429:
        return "The site is limiting visits right now. Try again later."
    if status >= 500:
        return f"The site had an error ({status}). Try again later."
    return f"The site answered with an error ({status})."


class Service:
    """The browser and its jobs, on an event loop of their own: the HTTP
    server's threads hand jobs over and read their state."""

    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.started = threading.Event()
        self.jobs: dict[str, dict] = {}
        # Grant nonces already used: one grant, one PDF.
        self.used: dict[str, float] = {}
        self.lock = threading.Lock()
        self.pw = None
        self.browser = None
        self.sandbox: bool | None = None
        self.problem: str | None = None
        self.available = self._importable()
        self.user_agent: str | None = None
        self._deny = None
        self._launching = None
        self._slots = None
        self._home = None
        # Tests: a resolver for every job's guard.
        self.resolve = None

    @staticmethod
    def _importable() -> bool:
        try:
            import playwright.async_api  # noqa: F401
            return True
        except ImportError:
            return False

    # ----- lifecycle -----------------------------------------------------

    def start(self):
        """Starts the loop and opens the browser in the background."""
        if self.thread or not self.available:
            if not self.available:
                self.problem = "Playwright isn't installed (pip install -r requirements.txt)."
                print("render: Playwright isn't installed, so web pages can't be saved as PDF.", flush=True)
            return
        self.thread = threading.Thread(target=self._run, name="render", daemon=True)
        self.thread.start()
        self.started.wait(10)

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self._slots = asyncio.Semaphore(MAX_CONCURRENT)
        self.loop.create_task(self._reaper())
        self.loop.create_task(self._warm())
        self.loop.call_soon(self.started.set)
        self.loop.run_forever()

    async def _warm(self):
        try:
            await self._ensure_browser()
        except Exception as e:  # noqa: BLE001 — logged; the first job tries again
            print(f"render: Chromium didn't start: {type(e).__name__}: {str(e).splitlines()[0][:300]}", flush=True)

    async def _deny_all(self, reader, writer):
        # Anything outside a job's context (none is expected) gets nowhere.
        writer.close()

    async def _ensure_browser(self):
        if self.browser and self.browser.is_connected():
            return self.browser
        if self._launching:
            return await asyncio.shield(self._launching)
        self._launching = self.loop.create_task(self._launch())
        try:
            return await asyncio.shield(self._launching)
        finally:
            self._launching = None

    async def _launch(self):
        from playwright.async_api import async_playwright

        if not self.pw:
            self.pw = await async_playwright().start()
        if not self._deny:
            self._deny = await asyncio.start_server(self._deny_all, "127.0.0.1", 0)
        self._home = self._home or tempfile.mkdtemp(prefix="pw-render-home-")
        deny_port = self._deny.sockets[0].getsockname()[1]
        options = {
            "headless": True,
            "executable_path": CHROMIUM,
            # Contexts get their own proxy; this one refuses everything.
            "proxy": {"server": f"socks5://127.0.0.1:{deny_port}"},
            "args": [
                # Chromium never looks names up itself: the guard does.
                "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-quic",
                # Docker gives /dev/shm 64 MB, too little for big pages.
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-domain-reliability",
                "--disable-sync",
                "--no-pings",
                "--no-first-run",
                "--mute-audio",
            ],
            # The worker's secrets and proxy settings stay out of the browser.
            "env": {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": self._home,
                "XDG_CONFIG_HOME": self._home,
                "XDG_CACHE_HOME": self._home,
                "LANG": "C.UTF-8",
                "TZ": "UTC",
                **({"FONTCONFIG_PATH": os.environ["FONTCONFIG_PATH"]} if os.environ.get("FONTCONFIG_PATH") else {}),
            },
            # Chrome's popup blocker back on (the headless shell has none;
            # the route below closes popups either way).
            "ignore_default_args": ["--disable-popup-blocking"],
            "handle_sigint": False,
            "handle_sigterm": False,
            "handle_sighup": False,
            "timeout": 30_000,
        }
        tries = [True, False] if SANDBOX == "auto" else [True] if SANDBOX in ("1", "true", "yes") else [False]
        last = None
        for sandbox in tries:
            try:
                browser = await self.pw.chromium.launch(chromium_sandbox=sandbox, **options)
            except Exception as e:  # noqa: BLE001
                last = e
                if sandbox and len(tries) > 1:
                    print("render: Chromium's sandbox couldn't start here (common in containers), so it runs without it. "
                          "See media-worker/README.md for what still isolates it.", flush=True)
                continue
            self.browser, self.sandbox, self.problem = browser, sandbox, None
            major = browser.version.split(".", 1)[0]
            self.user_agent = (f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                               f"Chrome/{major}.0.0.0 Safari/537.36")
            print(f"render: Chromium {browser.version} ready, sandbox {'on' if sandbox else 'off'}", flush=True)
            return browser
        self.problem = ("Chromium's sandbox isn't available here and RENDER_SANDBOX=1 requires it."
                        if SANDBOX in ("1", "true", "yes") else "Chromium didn't start.")
        raise last or RuntimeError(self.problem)

    async def _reaper(self):
        while True:
            await asyncio.sleep(10)
            now = time.time()
            with self.lock:
                for job_id, job in list(self.jobs.items()):
                    done = job.get("finished")
                    if done and now - done > RESULT_TTL:
                        job["pdf"] = None
                    if done and now - done > RESULT_TTL + 600:
                        del self.jobs[job_id]
                for ref, at in list(self.used.items()):
                    if now - at > 2 * 60 * 60:
                        del self.used[ref]

    # ----- jobs ---------------------------------------------------------

    def waiting(self) -> int:
        return sum(1 for j in self.jobs.values() if j["status"] == "working")

    def submit(self, grant: dict, html: str | None, name: str | None) -> dict:
        job = {
            "id": secrets.token_urlsafe(24),
            "status": "working",
            "stage": "queued",
            "progress": 0.02,
            "created": time.time(),
            "pdf": None,
        }
        with self.lock:
            self.jobs[job["id"]] = job
        job["future"] = asyncio.run_coroutine_threadsafe(self._job(job, grant, html, name), self.loop)
        return job

    def cancel(self, job: dict):
        if job["status"] == "working":
            job.update(status="error", error="Cancelled.", finished=time.time())
            future = job.get("future")
            if future:
                # Thread-safe: the job's task is cancelled on its own loop.
                future.cancel()
        job["pdf"] = None

    async def _job(self, job: dict, grant: dict, html: str | None, name: str | None):
        try:
            try:
                await asyncio.wait_for(self._slots.acquire(), JOB_SECONDS)
            except asyncio.TimeoutError:
                raise RenderError("The service is busy. Try again in a minute.")
            try:
                await asyncio.wait_for(self._render(job, grant, html, name), JOB_SECONDS)
            except asyncio.TimeoutError:
                raise RenderError("The page took too long to turn into a PDF." if job["stage"] == "printing"
                                  else "The page took too long to load.")
            finally:
                self._slots.release()
        except asyncio.CancelledError:
            job.update(status="error", error="Cancelled.")
        except RenderError as e:
            job.update(status="error", error=str(e))
        except Exception as e:  # noqa: BLE001 — a clean message, the cause to the log
            print(f"render {job['id'][:8]} failed: {type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ''}", flush=True)
            job.update(status="error", error="Couldn't make a PDF of this page. Try again.")
        finally:
            job["finished"] = time.time()

    async def _render(self, job: dict, grant: dict, html: str | None, name: str | None):
        try:
            browser = await self._ensure_browser()
        except Exception:  # noqa: BLE001
            raise RenderError("Saving web pages isn't working on this server right now. Try again later.")
        options = grant.get("o") if isinstance(grant.get("o"), dict) else {}
        max_pages = max(1, min(int(grant.get("x") or 100), HARD_MAX_PAGES))
        guard = Guard(self.resolve)
        await guard.start()
        job["guard"] = guard
        context = None
        try:
            context = await browser.new_context(
                proxy={"server": f"socks5://127.0.0.1:{guard.port}"},
                accept_downloads=False,
                service_workers="block",
                viewport=VIEWPORT,
                user_agent=self.user_agent,
                locale="en-US",
                timezone_id="UTC",
                permissions=[],
                reduced_motion="reduce",
                color_scheme="light",
            )
            page = await context.new_page()
            job["context"] = context
            await self._fence(context, page, guard, html)
            target = HTML_URL if html is not None else grant["u"]
            job["stage"] = "loading"
            job["progress"] = 0.08
            started = time.monotonic()
            try:
                response = await page.goto(target, wait_until="commit", timeout=LOAD_SECONDS * 1000)
            except Exception as e:  # noqa: BLE001
                if "Timeout" in type(e).__name__ or "Timeout" in str(e)[:80]:
                    raise RenderError("The site took too long to answer.")
                raise RenderError(net_message(str(e), guard))
            if guard.over == "bytes":
                raise RenderError("This page is too big to save as a PDF.")
            if response and response.status >= 400:
                raise RenderError(status_message(response.status))
            job["progress"] = 0.25
            # What arrives in time is printed: a page that never stops loading still gets its PDF.
            for state, progress in (("domcontentloaded", 0.4), ("load", 0.55)):
                left = LOAD_SECONDS - (time.monotonic() - started)
                if left > 0.2:
                    try:
                        await page.wait_for_load_state(state, timeout=left * 1000)
                    except Exception:  # noqa: BLE001
                        pass
                job["progress"] = progress
            await self._settle(page)
            job["progress"] = 0.75
            if guard.over == "bytes":
                raise RenderError("This page is too big to save as a PDF.")
            job["stage"] = "printing"
            pdf = await self._print(page, options, max_pages)
            if guard.over == "bytes":
                raise RenderError("This page is too big to save as a PDF.")
            if len(pdf) > MAX_PDF:
                raise RenderError(f"The PDF would be bigger than {MAX_PDF // 1024**2} MB, the most we save.")
            pages = count_pages(pdf)
            title = await page.title() if html is None or not name else None
            if html is not None:
                stem = re.sub(r"\.(x?html?|xht)$", "", name or "", flags=re.I).strip()
                filename = pdf_filename(stem or title, "page")
            else:
                host = urllib.parse.urlsplit(page.url).hostname or "page"
                filename = pdf_filename(title, host)
            job.update(status="ready", stage="ready", progress=1.0, pdf=pdf, size=len(pdf), pages=pages,
                       cut=pages >= max_pages, filename=filename)
        finally:
            job.pop("context", None)
            if context:
                try:
                    await context.close()
                except Exception:  # noqa: BLE001
                    pass
            await guard.close()

    async def _fence(self, context, page, guard: Guard, html: str | None):
        """Every request is checked before it leaves; anything that isn't
        the job's own page is closed."""
        await context.add_init_script(PAGE_SCRIPT)
        # "opened": the job's own first page load has been let through.
        state = {"requests": 0, "opened": False}

        async def route(route):
            request = route.request
            later_page_change = False

            async def refuse(what=None, why=None):
                if what:
                    guard.blocked.append((what, why))
                # A page change refused after the first load answers 204, which
                # cancels it and keeps the page; an aborted one would put
                # Chromium's error page in its place.
                if later_page_change:
                    return await route.fulfill(status=204)
                return await route.abort("blockedbyclient")

            try:
                state["requests"] += 1
                url = request.url
                parts = urllib.parse.urlsplit(url)
                scheme = parts.scheme.lower()
                try:
                    frame = request.frame
                except Exception:  # noqa: BLE001 — a worker's request, or a new page's first one
                    frame = None
                if (frame is None and request.is_navigation_request()) or (frame is not None and frame.page is not page):
                    # A popup (its first request comes before its frame): closed, and fetches nothing.
                    return await route.abort("blockedbyclient")
                main = request.is_navigation_request() and frame is page.main_frame
                first, later_page_change = main and not state["opened"], main and state["opened"]
                if state["requests"] > MAX_REQUESTS:
                    return await refuse()
                if scheme not in ("http", "https"):
                    return await refuse(scheme, "scheme")
                if html is not None:
                    if first and url == HTML_URL:
                        state["opened"] = True
                        return await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html)
                    if main or parts.hostname == "html.invalid":
                        # A pasted page can't send the browser elsewhere, and the
                        # files next to an uploaded one aren't here to fetch.
                        return await refuse()
                if request.resource_type == "media":
                    # Video and audio don't print, and are most of a page's bytes.
                    return await refuse()
                # The same check (and pinned answer) the proxy makes when it
                # connects, done early so a refused page change keeps the page.
                _, why = await guard.check(parts.hostname or "", parts.port or (443 if scheme == "https" else 80))
                if why:
                    return await refuse()
                if first:
                    state["opened"] = True
                await route.continue_()
            except Exception:  # noqa: BLE001 — the page or context is closing
                try:
                    await route.abort()
                except Exception:  # noqa: BLE001
                    pass

        await context.route("**/*", route)

        async def websocket(ws):
            # Never connected: live connections aren't needed for a PDF.
            guard.blocked.append((ws.url, "websocket"))
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

        await context.route_web_socket("**/*", websocket)

        def other_page(p):
            if p is not page:
                asyncio.ensure_future(p.close())

        context.on("page", other_page)

    async def _settle(self, page):
        """A moment for late pictures and fonts, within the job's time."""
        for step in (
            lambda: page.wait_for_load_state("networkidle", timeout=3000),
            lambda: asyncio.wait_for(page.evaluate(SCROLL_SCRIPT, 2500), 4),
            lambda: page.wait_for_load_state("networkidle", timeout=2000),
            lambda: asyncio.wait_for(page.evaluate("() => document.fonts && document.fonts.ready.then(() => true)"), 3),
        ):
            try:
                await step()
            except Exception:  # noqa: BLE001
                pass

    async def _print(self, page, options: dict, max_pages: int) -> bytes:
        media = "print" if options.get("p") == "print" else "screen"
        await page.emulate_media(media=media)
        margin = MARGINS.get(options.get("g"), MARGINS["small"])
        kwargs = {
            "print_background": options.get("b", 1) != 0,
            "margin": {"top": margin, "right": margin, "bottom": margin, "left": margin},
            "page_ranges": f"1-{max_pages}",
            "prefer_css_page_size": False,
            "tagged": True,
            "outline": True,
        }
        size = options.get("f")
        if size == "fit":
            try:
                box = await asyncio.wait_for(page.evaluate(SIZE_SCRIPT), 3)
            except Exception:  # noqa: BLE001
                box = {"width": VIEWPORT["width"], "height": VIEWPORT["height"]}
            width = min(max(int(box.get("width") or 0), VIEWPORT["width"]), 4000)
            height = min(max(int(box.get("height") or 0) + 2, 200), FIT_MAX_PX)
            kwargs.update(width=f"{width}px", height=f"{height}px")
        else:
            kwargs.update(format="Letter" if size == "letter" else "A4", landscape=options.get("l") == 1)
        return await page.pdf(**kwargs)


service = Service()


# ---------------------------------------------------------------------------
# HTTP (called from worker.py's handler)
# ---------------------------------------------------------------------------

# Room for the page and JSON's escaping of it.
BODY_LIMIT = MAX_HTML * 2 + 64 * 1024


def start():
    service.start()


def health() -> dict:
    """For the web app's /api/media/health, which sends the secret."""
    return {"render": service.available and service.problem is None, "renderSandbox": service.sandbox}


def _grant_problem(grant: dict, html, name) -> str | None:
    """Why this grant can't start a job (None when it can)."""
    if grant.get("k") != "render" or grant.get("m") not in ("url", "html"):
        return "Unsupported request."
    if grant["m"] == "url":
        url = grant.get("u")
        if not isinstance(url, str) or len(url) > 2048:
            return "Unsupported request."
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            return "Only http and https pages can be saved."
        return None
    if not isinstance(html, str) or (name is not None and not isinstance(name, str)):
        return "Unsupported request."
    data = html.encode("utf-8", "surrogatepass")
    if len(data) > MAX_HTML:
        return f"HTML up to {MAX_HTML // 1024**2} MB can be saved."
    # The page is the one the web app was told about when it gave the grant.
    if grant.get("n") != len(data) or grant.get("d") != hashlib.sha256(data).hexdigest():
        return "This page doesn't match the one the link was made for. Try again."
    return None


def _read_body(handler) -> tuple[dict | None, bool]:
    """(the JSON body or None, whether it was too big to read)."""
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        return None, False
    if length > BODY_LIMIT:
        return None, True
    if length <= 0:
        return None, False
    try:
        body = json.loads(handler.rfile.read(length))
    except (ValueError, UnicodeDecodeError):
        return None, False
    return (body if isinstance(body, dict) else None), False


def _status(job: dict) -> dict:
    keys = ("status", "stage", "progress", "pages", "size", "filename", "cut", "error")
    body = {k: job.get(k) for k in keys if job.get(k) is not None}
    if job["status"] == "ready" and job.get("pdf") is None:
        body["status"] = "gone"
    return body


def _send_pdf(handler, job: dict):
    pdf, name = job.get("pdf"), job.get("filename") or "page.pdf"
    if pdf is None:
        return handler.json(410, {"error": "This PDF has been downloaded or has expired. Make it again."})
    stem, ext = os.path.splitext(name)
    ascii_stem = re.sub(r"_+", "_", re.sub(r'[^\x20-\x7e]|["\\]', "_", stem)).strip(" _")
    ascii_name = (ascii_stem if re.search(r"[A-Za-z0-9]", ascii_stem) else "page") + ext
    handler.send_response(200)
    handler.cors()
    handler.send_header("Content-Type", "application/pdf")
    handler.send_header("Content-Length", str(len(pdf)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Disposition", f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{urllib.parse.quote(name)}')
    handler.end_headers()
    try:
        handler.wfile.write(pdf)
        handler.wfile.flush()
    except OSError:
        return  # cut off: kept for one more try until it expires
    # Sent: deleted straight away.
    job["pdf"] = None


def handle(handler, verify) -> bool:
    """Answers /render requests; False for any other path. `verify` is
    worker.py's verify_token, so grants are checked the same way."""
    path = urllib.parse.urlparse(handler.path).path
    if path != "/render" and not path.startswith("/render/"):
        return False
    method = handler.command
    if method == "POST" and path == "/render":
        _post(handler, verify)
        return True
    m = re.fullmatch(r"/render/([\w-]{16,64})(/file)?", path)
    job = service.jobs.get(m.group(1)) if m else None
    if method == "GET" and m:
        if not job:
            handler.json(404, {"error": "This PDF has expired. Make it again."})
        elif m.group(2):
            if job["status"] != "ready":
                handler.json(409, {"error": "Not ready yet."})
            else:
                _send_pdf(handler, job)
        else:
            handler.json(200, _status(job))
        return True
    if method == "DELETE" and m and not m.group(2):
        if not job:
            handler.json(404, {"error": "Not found."})
        else:
            service.cancel(job)
            handler.json(200, {"ok": True})
        return True
    handler.json(404, {"error": "Not found."})
    return True


def _post(handler, verify):
    if not service.available or not service.thread:
        return handler.json(503, {"error": "Saving web pages isn't set up on this server yet.", "code": "unavailable"})
    body, too_big = _read_body(handler)
    if too_big:
        # Not read: the connection closes with the answer.
        handler.close_connection = True
        return handler.json(413, {"error": f"HTML up to {MAX_HTML // 1024**2} MB can be saved.", "code": "too-big"})
    if body is None:
        return handler.json(400, {"error": "Invalid request."})
    grant, reason = verify(body.get("token", ""))
    if not grant:
        if reason == "expired":
            return handler.json(401, {"error": "This link expired. Please try again.", "code": "expired"})
        print("POST /render: bad token signature. MEDIA_WORKER_SECRET differs from the web app's.", flush=True)
        return handler.json(401, {"error": "The PDF server rejected this site.", "code": "bad-signature"})
    problem = _grant_problem(grant, body.get("html"), body.get("name"))
    if problem:
        return handler.json(400, {"error": problem})
    ref = grant.get("c") if isinstance(grant.get("c"), str) else None
    with service.lock:
        if ref and ref in service.used:
            return handler.json(409, {"error": "This PDF was already started.", "code": "used"})
        if service.waiting() >= MAX_CONCURRENT + MAX_QUEUE:
            return handler.json(503, {"error": "The service is busy. Try again in a minute.", "code": "busy"})
        if ref:
            service.used[ref] = time.time()
    job = service.submit(grant, body.get("html") if grant["m"] == "html" else None, body.get("name"))
    handler.json(202, {"id": job["id"]})


def cleanup():
    """Closes the browser (tests)."""
    if service.loop and service.browser:
        asyncio.run_coroutine_threadsafe(service.browser.close(), service.loop).result(10)
    if service._home:
        shutil.rmtree(service._home, ignore_errors=True)
