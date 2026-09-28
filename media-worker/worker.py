"""
PDF Wizard media worker.

Downloads YouTube and X (Twitter) media with yt-dlp and ffmpeg, which cannot
run on Vercel's serverless functions (HD YouTube streams are separate video and
audio tracks that must be merged with ffmpeg). Deploy this as a small container
next to the web app; see media-worker/README.md.

Flow (the web app never proxies video bytes, so no serverless limits apply):
  1. The web app checks the user's plan and quota, then signs a short-lived
     token describing exactly one download (URL, format, max height).
  2. The browser POSTs that token to /jobs here and polls /jobs/<id>.
  3. When ready, the browser fetches /jobs/<id>/file as an attachment.

Standard library only, apart from yt-dlp.
"""

import base64
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

SECRET = os.environ.get("MEDIA_WORKER_SECRET", "").encode()
PORT = int(os.environ.get("PORT", "8080"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("MEDIA_ALLOWED_ORIGINS", "*").split(",") if o.strip()]
MAX_CONCURRENT = int(os.environ.get("MEDIA_MAX_CONCURRENT", "3"))
MAX_DURATION = int(os.environ.get("MEDIA_MAX_DURATION_SECONDS", str(3 * 60 * 60)))
MAX_BYTES = int(os.environ.get("MEDIA_MAX_BYTES", str(4 * 1024**3)))
JOB_TTL = int(os.environ.get("MEDIA_JOB_TTL_SECONDS", "900"))
COOKIES = os.environ.get("YTDLP_COOKIES_FILE") or None
PROXY = os.environ.get("YTDLP_PROXY") or None
FFMPEG = os.environ.get("FFMPEG_LOCATION") or None
# YouTube needs a JavaScript runtime to solve its player challenges. The
# Dockerfile installs Deno via yt-dlp's "deno" extra; DENO_PATH overrides it.
DENO = os.environ.get("DENO_PATH") or shutil.which("deno")
# Jobs still running after this long are presumed stuck and cleaned up.
JOB_MAX_RUNTIME = int(os.environ.get("MEDIA_JOB_MAX_RUNTIME_SECONDS", str(2 * 60 * 60)))
# Extra hosts, for local testing only. Leave unset in production.
TEST_HOSTS = {h.strip() for h in os.environ.get("MEDIA_TEST_HOSTS", "").split(",") if h.strip()}

ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    "x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
}

slots = threading.BoundedSemaphore(MAX_CONCURRENT)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_token(token: str) -> dict | None:
    """Token = base64url(json payload) + "." + base64url(HMAC-SHA256(payload))."""
    if not SECRET or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    expected = hmac.new(SECRET, body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, b64url_decode(sig)):
            return None
        payload = json.loads(b64url_decode(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if payload.get("e", 0) < time.time():
        return None
    return payload


def host_allowed(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("https", "http") and (host in ALLOWED_HOSTS or host in TEST_HOSTS)


# ---------------------------------------------------------------------------
# yt-dlp
# ---------------------------------------------------------------------------

def base_opts() -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # X posts can hold several videos; only ever take the first.
        "playlist_items": "1",
        "restrictfilenames": True,
        "socket_timeout": 20,
        "retries": 3,
    }
    if COOKIES:
        opts["cookiefile"] = COOKIES
    if PROXY:
        opts["proxy"] = PROXY
    if FFMPEG:
        opts["ffmpeg_location"] = FFMPEG
    if DENO:
        opts["js_runtimes"] = {"deno": {"path": DENO}}
    return opts


def first_entry(info: dict) -> dict:
    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries") or [] if e]
        if not entries:
            raise yt_dlp.utils.DownloadError("no video in this post")
        return entries[0]
    return info


def is_video(f: dict) -> bool:
    # Some extractors leave vcodec unset (None) on video formats; only "none" means audio-only.
    return bool(f.get("height")) and f.get("vcodec") != "none"


def summarize(info: dict) -> dict:
    formats = info.get("formats") or []
    return {
        "id": info.get("id"),
        "title": info.get("title") or "Untitled",
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "heights": sorted({f["height"] for f in formats if is_video(f)}) or ([info["height"]] if info.get("height") else []),
        "hasAudio": any(f.get("acodec") != "none" for f in formats) if formats else True,
    }


def extract_info(url: str) -> dict:
    with yt_dlp.YoutubeDL(base_opts()) as ydl:
        return summarize(first_entry(ydl.extract_info(url, download=False)))


def download_opts(kind: str, height: int, out_dir: str, job: dict) -> dict:
    def progress(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total > MAX_BYTES:
                raise yt_dlp.utils.DownloadError("File is larger than this service allows.")
            # yt-dlp reports each stream (video, then audio) separately.
            frac = (d.get("downloaded_bytes", 0) / total) if total else 0
            job["progress"] = min(0.95, frac * 0.9)
        elif d.get("status") == "finished":
            job["progress"] = 0.92
            job["stage"] = "processing"

    opts = base_opts()
    opts.update({
        "outtmpl": os.path.join(out_dir, "%(title).120B.%(ext)s"),
        "progress_hooks": [progress],
        "max_filesize": MAX_BYTES,
    })
    if kind == "mp3":
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
    else:
        # Prefer H.264 + AAC so the MP4 plays everywhere (QuickTime, iOS,
        # PowerPoint); fall back to any codec at the requested height.
        opts["format"] = (
            f"bv*[height<={height}][vcodec^=avc1]+(ba[ext=m4a]/ba)/"
            f"bv*[height<={height}]+ba/"
            f"b[height<={height}]/b"
        )
        opts["merge_output_format"] = "mp4"
    return opts


def run_job(job_id: str, payload: dict):
    job = jobs[job_id]
    out_dir = tempfile.mkdtemp(prefix="pw-media-")
    job["dir"] = out_dir
    if not slots.acquire(timeout=120):
        job.update(status="error", error="The service is busy. Please try again in a minute.", finished=time.time())
        return
    try:
        job["stage"] = "downloading"
        # One extraction, reused for the download: YouTube rate-limits extractions.
        with yt_dlp.YoutubeDL(download_opts(payload["k"], int(payload.get("h") or 720), out_dir, job)) as ydl:
            info = first_entry(ydl.extract_info(payload["u"], download=False))
            if (info.get("duration") or 0) > MAX_DURATION:
                raise ValueError(f"Videos up to {MAX_DURATION // 3600} hours are supported.")
            ydl.process_ie_result(info, download=True)
        files = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if not f.endswith((".part", ".ytdl"))]
        if not files:
            raise ValueError("Nothing was downloaded.")
        path = max(files, key=os.path.getsize)
        job.update(status="ready", progress=1.0, stage="ready", path=path,
                   filename=os.path.basename(path), size=os.path.getsize(path))
    except yt_dlp.utils.DownloadError as e:
        print(f"job {job_id[:8]} failed: {e}", flush=True)
        job.update(status="error", error=friendly_error(str(e)))
    except Exception as e:  # noqa: BLE001 — surface a clean message, never a trace
        print(f"job {job_id[:8]} failed: {type(e).__name__}: {e}", flush=True)
        job.update(status="error", error=str(e) if isinstance(e, ValueError) else "Download failed.")
    finally:
        job["finished"] = time.time()
        slots.release()


def friendly_error(message: str) -> str:
    m = message.lower()
    if "not a bot" in m or "sign in to confirm" in m:
        return ("YouTube is blocking this download server as a bot. "
                "The site owner needs to give it a residential proxy or cookies (see media-worker/README.md).")
    if "requested format is not available" in m:
        return "That quality isn't available for this video. Pick another."
    if "http error 403" in m:
        return "YouTube refused the download. Try again; if it keeps happening, the server needs a proxy."
    if "private" in m:
        return "This video is private."
    if "sign in" in m or "confirm your age" in m or "bot" in m:
        return "The platform asked for a sign-in to access this video, so it can't be downloaded."
    if "unavailable" in m or "removed" in m or "does not exist" in m:
        return "This video is unavailable."
    if "larger than" in m or "max_filesize" in m:
        return "This file is larger than the service allows."
    if "no video" in m:
        return "That post doesn't contain a video."
    return "Couldn't download this video. Check the link and try again."


def reaper():
    """Deletes finished or abandoned jobs and their files."""
    while True:
        time.sleep(30)
        now = time.time()
        with jobs_lock:
            # Finished jobs live JOB_TTL after finishing, so a long download
            # isn't deleted while it runs or before the browser fetches it.
            expired = [
                k for k, j in jobs.items()
                if (j.get("finished") and now - j["finished"] > JOB_TTL)
                or (not j.get("finished") and now - j["created"] > JOB_MAX_RUNTIME)
            ]
            for k in expired:
                shutil.rmtree(jobs[k].get("dir") or "", ignore_errors=True)
                del jobs[k]


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "pw-media/1"

    def log_message(self, fmt, *args):  # keep logs free of user URLs
        pass

    def cors(self):
        origin = self.headers.get("Origin")
        if "*" in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict:
        length = min(int(self.headers.get("Content-Length") or 0), 64_000)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            return self.json(200, {
                "ok": True,
                "ytdlp": yt_dlp.version.__version__,
                "jsRuntime": DENO and "deno",
                "ejs": importlib.util.find_spec("yt_dlp_ejs") is not None,
                "proxy": bool(PROXY),
                "cookies": bool(COOKIES),
            })
        m = re.fullmatch(r"/jobs/([\w-]{16,64})(/file)?", path)
        if not m:
            return self.json(404, {"error": "Not found."})
        job = jobs.get(m.group(1))
        if not job:
            return self.json(404, {"error": "This download expired. Please start again."})
        if not m.group(2):
            return self.json(200, {k: job.get(k) for k in ("status", "progress", "stage", "filename", "size", "error")})
        if job.get("status") != "ready":
            return self.json(409, {"error": "Not ready yet."})
        self.send_file(job)

    def do_HEAD(self):
        # Uptime monitors often probe with HEAD.
        path = urllib.parse.urlparse(self.path).path
        self.send_response(200 if path == "/health" else 404)
        self.cors()
        self.end_headers()

    def send_file(self, job: dict):
        path, name = job["path"], job["filename"]
        ascii_name = name.encode("ascii", "ignore").decode() or "download"
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "audio/mpeg" if name.endswith(".mp3") else "video/mp4")
        self.send_header("Content-Length", str(job["size"]))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{urllib.parse.quote(name)}',
        )
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/info":
            # Server-to-server only: the web app authenticates with the shared secret.
            auth = self.headers.get("Authorization", "")
            if not SECRET or not hmac.compare_digest(auth.encode(), b"Bearer " + SECRET):
                return self.json(401, {"error": "Unauthorized."})
            url = self.read_json().get("url", "")
            if not host_allowed(url):
                return self.json(400, {"error": "Unsupported link."})
            try:
                return self.json(200, extract_info(url))
            except yt_dlp.utils.DownloadError as e:
                return self.json(422, {"error": friendly_error(str(e))})
            except Exception:  # noqa: BLE001
                return self.json(502, {"error": "Couldn't read that link."})

        if path == "/jobs":
            payload = verify_token(self.read_json().get("token", ""))
            if not payload:
                return self.json(401, {"error": "This download link expired. Please try again."})
            if not host_allowed(payload.get("u", "")) or payload.get("k") not in ("mp4", "mp3"):
                return self.json(400, {"error": "Unsupported request."})
            job_id = secrets.token_urlsafe(24)
            with jobs_lock:
                jobs[job_id] = {"status": "working", "stage": "queued", "progress": 0.0, "created": time.time()}
            threading.Thread(target=run_job, args=(job_id, payload), daemon=True).start()
            return self.json(202, {"id": job_id})

        self.json(404, {"error": "Not found."})


def main():
    if not SECRET:
        raise SystemExit("MEDIA_WORKER_SECRET must be set.")
    threading.Thread(target=reaper, daemon=True).start()
    print(f"media worker listening on :{PORT} (yt-dlp {yt_dlp.version.__version__}, "
          f"js runtime: {DENO or 'NONE - YouTube downloads will fail'})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
