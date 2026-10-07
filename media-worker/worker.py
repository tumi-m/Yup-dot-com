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

Playlists are listed by POST /playlist (titles and ids only, nothing is
downloaded); each video is then downloaded through the same flow as above.

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
import unicodedata
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
# Longest playlist listed by /playlist; longer ones are cut and flagged.
PLAYLIST_MAX = int(os.environ.get("MEDIA_PLAYLIST_MAX_ITEMS", "200"))
# Extra hosts, for local testing only. Leave unset in production.
TEST_HOSTS = {h.strip() for h in os.environ.get("MEDIA_TEST_HOSTS", "").split(",") if h.strip()}

ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    "x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
}

slots = threading.BoundedSemaphore(MAX_CONCURRENT)
jobs: dict[str, dict] = {}
# Grant nonce ("c" in the token) -> its job. Outlives the job itself, so the
# web app can still ask whether a grant was used when deciding on a refund.
refs: dict[str, dict] = {}
REF_TTL = 6 * 60 * 60
jobs_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_token(token: str) -> tuple[dict | None, str | None]:
    """Token = base64url(json payload) + "." + base64url(HMAC-SHA256(payload)).

    Returns (payload, None), or (None, reason) with reason "bad-signature"
    (the web app signs with a different secret: retrying can't help) or
    "expired" (a fresh grant will work).
    """
    if not SECRET or not isinstance(token, str) or "." not in token:
        return None, "bad-signature"
    body, sig = token.rsplit(".", 1)
    expected = hmac.new(SECRET, body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, b64url_decode(sig)):
            return None, "bad-signature"
        payload = json.loads(b64url_decode(body))
    except (ValueError, json.JSONDecodeError):
        return None, "bad-signature"
    if not isinstance(payload, dict):
        return None, "bad-signature"
    if payload.get("e", 0) < time.time():
        return None, "expired"
    return payload, None


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
        # Progress goes to the hooks; printed bars only bury real errors in the log.
        "noprogress": True,
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


def short_side(f: dict) -> int:
    """"720p" means the short side, so a 720x1280 Short counts as 720p."""
    w, h = f.get("width"), f.get("height")
    return min(w, h) if w and h else (h or 0)


def limit_formats(info: dict, height: int) -> None:
    """Drops video formats above `height` (short side), so plain best-format
    selection picks the best one within the plan, portrait or landscape.
    When the source has nothing that small, only its smallest size is kept."""
    formats = info.get("formats") or []
    videos = [f for f in formats if is_video(f)]
    if not videos:
        return
    fit = [f for f in videos if short_side(f) <= height]
    if not fit:
        smallest = min(short_side(f) for f in videos)
        fit = [f for f in videos if short_side(f) == smallest]
    keep = {id(f) for f in fit}
    info["formats"] = [f for f in formats if not is_video(f) or id(f) in keep]


# Bidi overrides and other invisible format characters can disguise a name
# ("‮gnp.exe" shows as "exe.png"); zero-width joiners keep emoji intact.
_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|]')


def clean_text(text: str) -> str:
    """NFKC, control characters as spaces, invisible format characters dropped."""
    out = []
    for ch in unicodedata.normalize("NFKC", text or ""):
        cat = unicodedata.category(ch)
        if cat == "Cc":
            out.append(" ")
        elif cat in ("Cf", "Cs") and ch != "\u200d":
            continue
        else:
            out.append(ch)
    return "".join(out)


def display_filename(title: str | None, video_id: str | None, ext: str) -> str:
    """The name the visitor's browser saves: the real title in any script,
    minus characters no file system accepts. Files on disk use a fixed name."""
    name = _UNSAFE_NAME.sub(" ", clean_text(title or ""))
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > 120:
        name = name[:120].rstrip(" .")
    if not name:
        name = re.sub(r"[^\w-]", "", video_id or "") or "video"
    return f"{name}.{ext}"


def summarize(info: dict) -> dict:
    formats = info.get("formats") or []
    return {
        "id": info.get("id"),
        "title": clean_text(info.get("title") or "").strip() or "Untitled",
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        # Short side, like the plan limits: a 1080x1920 Short is 1080p.
        "heights": sorted({short_side(f) for f in formats if is_video(f)}) or ([short_side(info)] if info.get("height") else []),
        "hasAudio": any(f.get("acodec") != "none" for f in formats) if formats else True,
    }


def extract_info(url: str) -> dict:
    with yt_dlp.YoutubeDL(base_opts()) as ydl:
        return summarize(first_entry(ydl.extract_info(url, download=False)))


class LinkError(Exception):
    """A problem with the link itself, safe to show to the visitor as-is."""


def playlist_entry(e: dict) -> dict:
    thumbs = [t.get("url") for t in e.get("thumbnails") or [] if t.get("url")]
    duration = e.get("duration")
    return {
        "id": e.get("id"),
        "url": e.get("url") or e.get("webpage_url"),
        "title": e.get("title") or "Untitled",
        "duration": int(duration) if isinstance(duration, (int, float)) else None,
        "thumbnail": e.get("thumbnail") or (thumbs[-1] if thumbs else None),
    }


def extract_playlist(url: str) -> dict:
    """Lists a playlist without resolving or downloading any of its videos."""
    opts = base_opts()
    opts.pop("playlist_items", None)
    opts.update({
        "noplaylist": False,
        "extract_flat": "in_playlist",
        # One extra entry tells us whether the list was cut.
        "playlistend": PLAYLIST_MAX + 1,
        "skip_download": True,
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") != "playlist":
        raise LinkError("That link isn't a playlist.")
    raw = [e for e in info.get("entries") or [] if e]
    truncated = len(raw) > PLAYLIST_MAX
    count = info.get("playlist_count")
    if not isinstance(count, int) or count < len(raw):
        count = len(raw)
    # Deleted and private videos still appear in YouTube playlists.
    entries = [playlist_entry(e) for e in raw[:PLAYLIST_MAX]]
    entries = [e for e in entries if e["title"] not in ("[Deleted video]", "[Private video]")]
    if not entries:
        raise LinkError("This playlist is empty.")
    return {
        "id": info.get("id"),
        "title": info.get("title") or "Playlist",
        "uploader": info.get("uploader") or info.get("channel"),
        "count": count,
        "truncated": truncated,
        "entries": entries,
    }


class Cancelled(Exception):
    """The visitor cancelled the job (DELETE /jobs/<id>)."""


def set_progress(job: dict, value: float) -> None:
    # Never backwards: yt-dlp reports each stream (video, then audio) from 0.
    job["progress"] = max(job.get("progress") or 0.0, min(value, 0.99))


def download_opts(kind: str, out_dir: str, job: dict) -> dict:
    def progress(d):
        if job.get("cancelled"):
            raise Cancelled()
        # A video-only or audio-only stream is half of a merge (video first).
        info = d.get("info_dict") or {}
        split = kind == "mp4" and "none" in (info.get("vcodec"), info.get("acodec"))
        n = 2 if split else 1
        i = 1 if split and info.get("vcodec") == "none" else 0
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total > MAX_BYTES:
                raise yt_dlp.utils.DownloadError("File is larger than this service allows.")
            if d.get("fragment_count"):
                # Fragmented (DASH/HLS): the byte estimate runs ahead, fragments don't.
                frac = (max(1, d.get("fragment_index") or 1) - 1) / d["fragment_count"]
            else:
                frac = (d.get("downloaded_bytes", 0) / total) if total else 0
            # Stream i of n fills its own slice of the first 90%.
            set_progress(job, (i + min(frac, 1.0)) / n * 0.9)
        elif d.get("status") == "finished":
            set_progress(job, (i + 1) / n * 0.9)

    def postprocess(d):
        if job.get("cancelled"):
            raise Cancelled()
        # Merging audio and video, or extracting MP3. Moving the file is instant.
        if d.get("status") == "started" and d.get("postprocessor") != "MoveFiles":
            job["stage"] = "processing"
            set_progress(job, 0.9)

    opts = base_opts()
    opts.update({
        # A fixed name on disk; the visitor's file name is built from the title.
        "outtmpl": os.path.join(out_dir, "media.%(ext)s"),
        "progress_hooks": [progress],
        "postprocessor_hooks": [postprocess],
        "max_filesize": MAX_BYTES,
        # A fragment that never arrives fails the job instead of leaving a gap in the file.
        "skip_unavailable_fragments": False,
    })
    if kind == "mp3":
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
    else:
        # The height limit is applied to the formats beforehand (limit_formats),
        # by the short side. Prefer H.264 + AAC so the MP4 plays everywhere
        # (QuickTime, iOS, PowerPoint); fall back to any codec.
        opts["format"] = "bv*[vcodec^=avc1]+(ba[ext=m4a]/ba)/bv*+ba/b"
        opts["merge_output_format"] = "mp4"
    return opts


def cancelled_by(e: BaseException | None) -> bool:
    # yt-dlp may wrap exceptions raised in hooks.
    for _ in range(5):
        if e is None:
            return False
        if isinstance(e, Cancelled):
            return True
        wrapped = getattr(e, "exc_info", None)
        e = (wrapped[1] if isinstance(wrapped, tuple) and len(wrapped) > 1 else None) or e.__cause__ or e.__context__
    return False


def run_job(job_id: str, payload: dict):
    job = jobs[job_id]
    out_dir = tempfile.mkdtemp(prefix="pw-media-")
    job["dir"] = out_dir
    if not slots.acquire(timeout=120):
        job.update(status="error", error="The service is busy. Please try again in a minute.", finished=time.time())
        return
    kind = payload["k"]
    try:
        if job.get("cancelled"):
            raise Cancelled()
        job["stage"] = "downloading"
        # One extraction, reused for the download: YouTube rate-limits extractions.
        with yt_dlp.YoutubeDL(download_opts(kind, out_dir, job)) as ydl:
            info = first_entry(ydl.extract_info(payload["u"], download=False))
            if (info.get("duration") or 0) > MAX_DURATION:
                raise ValueError(f"Videos up to {MAX_DURATION // 3600} hours are supported.")
            if kind == "mp4":
                limit_formats(info, int(payload.get("h") or 720))
            ydl.process_ie_result(info, download=True)
        if job.get("cancelled"):
            raise Cancelled()
        files = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if not f.endswith((".part", ".ytdl"))]
        if not files:
            raise ValueError("Nothing was downloaded.")
        path = max(files, key=os.path.getsize)
        ext = os.path.splitext(path)[1].lstrip(".") or ("mp3" if kind == "mp3" else "mp4")
        job.update(status="ready", progress=1.0, stage="ready", path=path,
                   filename=display_filename(info.get("title"), info.get("id"), ext), size=os.path.getsize(path))
    except Exception as e:  # noqa: BLE001 — surface a clean message, never a trace
        if job.get("cancelled") or cancelled_by(e):
            job.update(status="error", error="Cancelled.")
            shutil.rmtree(out_dir, ignore_errors=True)
        elif isinstance(e, yt_dlp.utils.DownloadError):
            print(f"job {job_id[:8]} failed: {e}", flush=True)
            job.update(status="error", error=friendly_error(str(e), phase="job", kind=kind))
        else:
            print(f"job {job_id[:8]} failed: {type(e).__name__}: {e}", flush=True)
            job.update(status="error", error=str(e) if isinstance(e, ValueError) else "Download failed.")
    finally:
        job["finished"] = time.time()
        slots.release()


BOT_MESSAGE = "YouTube is blocking downloads right now. Try again later."


def is_bot_check(message: str) -> bool:
    m = message.lower()
    return "not a bot" in m or "sign in to confirm" in m


def friendly_error(message: str, subject: str = "video", phase: str = "info", kind: str = "mp4") -> str:
    """A short message the visitor can act on. Operator advice goes to the log."""
    m = message.lower()
    if is_bot_check(message):
        print("YouTube bot check: give the worker a residential proxy (YTDLP_PROXY) "
              "or cookies (YTDLP_COOKIES_FILE); see media-worker/README.md.", flush=True)
        return BOT_MESSAGE
    if "requested format is not available" in m:
        return "That quality isn't available for this video. Pick another."
    if "http error 403" in m:
        print("YouTube answered 403: if this keeps happening, the worker needs a proxy.", flush=True)
        return "YouTube refused this one. Try again."
    if "private" in m:
        return f"This {subject} is private."
    if "sign in" in m or "confirm your age" in m or "bot" in m:
        return f"The platform asked for a sign-in to access this {subject}, so it can't be downloaded."
    if phase == "job" and "http error 404" in m:
        # A stream URL that died mid-download, not a missing video.
        return ("The download failed partway. Try again, or pick a lower quality."
                if kind == "mp4" else "The download failed partway. Try again.")
    if ("unavailable" in m or "removed" in m or "does not exist" in m or "unviewable" in m
            or "http error 404" in m):
        return f"This {subject} is unavailable."
    if "larger than" in m or "max_filesize" in m:
        return "This file is larger than the service allows."
    if "no video" in m:
        return "That post doesn't contain a video."
    if phase == "job":
        # The link already worked for the preview, so it isn't the link.
        return ("The download failed partway. Try again, or pick a lower quality."
                if kind == "mp4" else "The download failed partway. Try again.")
    if subject == "playlist":
        return "Couldn't read this playlist. Check the link and try again."
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
            for c in [c for c, j in refs.items() if now - j["created"] > REF_TTL]:
                del refs[c]


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
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS")
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
                "playlists": True,
            })
        m = re.fullmatch(r"/refs/([\w-]{8,64})", path)
        if m:
            # Server to server: was this grant used, and how did its job end?
            if not self.authorized():
                return self.json(401, {"error": "Unauthorized."})
            job = refs.get(m.group(1))
            if not job:
                return self.json(404, {"used": False})
            return self.json(200, {"used": True, "status": job.get("status"), "error": job.get("error")})
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
        # Uptime monitors probe /health; the web app checks a file still exists
        # before saving it again.
        path = urllib.parse.urlparse(self.path).path
        m = re.fullmatch(r"/jobs/([\w-]{16,64})/file", path)
        if m:
            job = jobs.get(m.group(1))
            if job and job.get("status") == "ready":
                return self.send_file(job, head=True)
        self.send_response(200 if path == "/health" else 404)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self):
        """Cancel a job: stops the download and frees its slot and files."""
        path = urllib.parse.urlparse(self.path).path
        m = re.fullmatch(r"/jobs/([\w-]{16,64})", path)
        job = jobs.get(m.group(1)) if m else None
        if not job:
            return self.json(404, {"error": "Not found."})
        with jobs_lock:
            if job.get("status") == "working":
                job.update(cancelled=True, status="error", error="Cancelled.")
            else:
                # Finished either way: the visitor is done with the file.
                shutil.rmtree(job.get("dir") or "", ignore_errors=True)
                jobs.pop(m.group(1), None)
        self.json(200, {"ok": True})

    def send_file(self, job: dict, head: bool = False):
        path, name = job["path"], job["filename"]
        stem, ext = os.path.splitext(name)
        ascii_stem = re.sub(r"_+", "_", re.sub(r'[^\x20-\x7e]|["\\]', "_", stem)).strip(" _")
        ascii_name = (ascii_stem if re.search(r"[A-Za-z0-9]", ascii_stem) else "download") + ext
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "audio/mpeg" if name.endswith(".mp3") else "video/mp4")
        self.send_header("Content-Length", str(job["size"]))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{urllib.parse.quote(name)}',
        )
        self.end_headers()
        if head:
            return
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)

    def authorized(self) -> bool:
        """Server-to-server calls: the web app authenticates with the shared secret."""
        auth = self.headers.get("Authorization", "")
        return bool(SECRET) and hmac.compare_digest(auth.encode(), b"Bearer " + SECRET)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/info", "/playlist"):
            if not self.authorized():
                return self.json(401, {"error": "Unauthorized."})
            url = self.read_json().get("url", "")
            if not isinstance(url, str) or not host_allowed(url):
                return self.json(400, {"error": "Unsupported link."})
            subject = "playlist" if path == "/playlist" else "video"
            try:
                return self.json(200, extract_playlist(url) if subject == "playlist" else extract_info(url))
            except yt_dlp.utils.DownloadError as e:
                print(f"{path} failed: {e}", flush=True)
                body = {"error": friendly_error(str(e), subject)}
                if is_bot_check(str(e)):
                    body["code"] = "bot"
                return self.json(422, body)
            except LinkError as e:
                return self.json(422, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                print(f"{path} failed: {type(e).__name__}: {e}", flush=True)
                return self.json(502, {"error": "Couldn't read that link."})

        if path == "/jobs":
            payload, reason = verify_token(self.read_json().get("token", ""))
            if not payload:
                if reason == "expired":
                    return self.json(401, {"error": "This download link expired. Please try again.", "code": "expired"})
                print("POST /jobs: bad token signature. MEDIA_WORKER_SECRET differs from the web app's.", flush=True)
                return self.json(401, {"error": "The download server rejected this site.", "code": "bad-signature"})
            if not host_allowed(payload.get("u", "")) or payload.get("k") not in ("mp4", "mp3"):
                return self.json(400, {"error": "Unsupported request."})
            ref = payload.get("c") if isinstance(payload.get("c"), str) else None
            job_id = secrets.token_urlsafe(24)
            with jobs_lock:
                # One grant, one job: a grant is one counted download.
                if ref and ref in refs:
                    return self.json(409, {"error": "This download already started.", "code": "used"})
                jobs[job_id] = {"status": "working", "stage": "queued", "progress": 0.0, "created": time.time()}
                if ref:
                    refs[ref] = jobs[job_id]
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
