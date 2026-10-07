# Media worker (YouTube downloads)

**X (Twitter) needs nothing from this folder.** The web app resolves X posts
itself, streams the MP4 through `/api/media/file`, and converts to MP3 in the
browser with ffmpeg.wasm.

**YouTube needs this worker.** HD YouTube is delivered as separate video and
audio tracks that ffmpeg has to merge. YouTube also requires a JavaScript
runtime (Deno) to unlock its streams, and ties stream URLs to the IP that
requested them. None of that can run on Vercel's serverless functions.

```
browser ──(1) paste link──▶ Next.js /api/media/info ──▶ worker /info
browser ──(2) download────▶ Next.js /api/media/link   (checks plan + daily quota,
                                                        signs a 10-minute token)
browser ──(3) token───────▶ worker /jobs → poll /jobs/<id> → /jobs/<id>/file
```

Playlists: `/api/media/playlist` asks the worker's `POST /playlist` for the
list (titles, durations, ids; nothing is downloaded, at most
`MEDIA_PLAYLIST_MAX_ITEMS`, default 200). The browser then downloads the
videos it picked one by one through steps 2 and 3, so each counts against the
daily quota. Workers deployed before playlists answer 404 there; redeploy, and
`/api/media/health` reports `"playlists": "ready"`.

Video bytes go straight from the worker to the browser and never pass through
Vercel. The worker only accepts downloads signed by the web app, and only for
YouTube and X hosts. A tampered token (say, 720p edited to 1080p) is rejected,
and each token starts one job.

A download that fails or is cancelled (`DELETE /jobs/<id>`) doesn't count
against the visitor's quota: the web app asks the worker's `GET /refs/<grant>`
how the job ended before giving the download back.

## Deploy

Any container host works: Railway, Fly.io, Render, or a small VPS.

1. Deploy this folder using its `Dockerfile`.
2. Set these on the worker:

   | Variable | |
   | -------- | - |
   | `MEDIA_WORKER_SECRET` | Long random string, shared with the web app |
   | `MEDIA_ALLOWED_ORIGINS` | Your site origin(s), e.g. `https://pdfwizard.app` (default `*`) |
   | `MEDIA_MAX_CONCURRENT` | Parallel downloads (default 3) |
   | `MEDIA_MAX_DURATION_SECONDS` | Longest video allowed (default 3 h) |
   | `MEDIA_PLAYLIST_MAX_ITEMS` | Longest playlist listed (default 200) |
   | `YTDLP_PROXY` | Residential proxy URL, e.g. `http://user:pass@host:port`. Usually required, see below |
   | `YTDLP_COOKIES_FILE` | Path to a Netscape-format cookies file, as an alternative |
   | `YTDLP_AUTO_UPDATE` | `1` upgrades yt-dlp at every start |
   | `MEDIA_MAX_BYTES` | Largest file a job may produce (default 4 GiB) |
   | `MEDIA_JOB_TTL_SECONDS` | How long a finished file stays downloadable (default 900) |
   | `MEDIA_JOB_MAX_RUNTIME_SECONDS` | A job running longer is presumed stuck and removed (default 2 h) |
   | `PORT` | Listening port (default 8080) |
   | `FFMPEG_LOCATION`, `DENO_PATH` | Only outside the Dockerfile: where ffmpeg and Deno are, if not on `PATH` |
   | `MEDIA_TEST_HOSTS` | Tests only. Leave unset |

3. On Vercel, set `MEDIA_WORKER_URL` (the worker's public HTTPS URL) and the same
   `MEDIA_WORKER_SECRET`, then redeploy.
4. Open `https://<your-site>/api/media/health`. It reports what's missing:
   an unset variable, a worker that doesn't answer, or no JavaScript runtime.

**Run exactly one instance.** Jobs live in the worker's memory, so with two
replicas the browser's progress polls can land on the one that doesn't have
the job. Scale up, not out, or turn on sticky sessions.

Avoid hosts that sleep when idle (such as Render's free tier). The first
request after a sleep times out.

## Things to know before launch

- **YouTube actively blocks data-centre IPs.** From almost every cloud host,
  YouTube answers "Sign in to confirm you're not a bot". Visitors then see
  "YouTube is blocking downloads right now", and the worker and web app logs
  say why. In production you will need
  `YTDLP_PROXY` (a residential proxy) or `YTDLP_COOKIES_FILE`. Budget for it.
  Cookies come from a throwaway Google account, and YouTube may ban it.
- **Keep yt-dlp current.** YouTube changes often, and yt-dlp ships fixes within
  days. Rebuild weekly (bump `YTDLP_REFRESH` in the Dockerfile) or set
  `YTDLP_AUTO_UPDATE=1`.
- **Legal.** Downloading from YouTube conflicts with YouTube's Terms of Service
  unless the uploader allows it, and charging for it (1080p on Pro) raises the
  stakes. Payment processors and ad networks may restrict businesses that sell
  it. Get legal advice, publish a DMCA/takedown contact, and consider running
  the downloaders on a separate domain and payment account, so a complaint can't
  take down the PDF business.

## Test

```bash
FFMPEG=/path/to/ffmpeg npm run test:media   # needs python3 + yt-dlp
```

The test builds a local multi-quality DASH stream shaped like YouTube HD and
checks: the right height at 1080/720/360p, H.264 + AAC merged into MP4, MP3
extraction, and rejection of tampered, expired, and wrongly signed tokens and
non-allowlisted hosts. It also serves local RSS feeds, which yt-dlp lists as
playlists the way it lists YouTube playlists with `extract_flat`, to check
`/playlist`: titles, durations and thumbnails, the 200-item cap and its flag,
rejection of single videos, friendly errors, and that no media is fetched.
