# Media worker (YouTube & X downloads)

The YouTube to MP4 (360p–1080p) and X (Twitter) to MP4/MP3 tools need
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg. HD YouTube is delivered
as separate video and audio tracks that ffmpeg has to merge, and **neither tool
can run on Vercel's serverless functions**. So downloads run in this small
container instead, next to the Vercel app.

```
browser ──(1) paste link──▶ Next.js /api/media/info ──▶ worker /info
browser ──(2) download────▶ Next.js /api/media/link   (checks plan + daily quota,
                                                        signs a 10-minute token)
browser ──(3) token───────▶ worker /jobs → poll /jobs/<id> → /jobs/<id>/file
```

Video bytes go straight from the worker to the browser and never pass through
Vercel. The worker only accepts downloads signed by the web app, and only for
YouTube and X hosts. A tampered token (say, 720p edited to 1080p) is rejected.

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
   | `YTDLP_COOKIES_FILE` / `YTDLP_PROXY` | Optional, see below |

3. On Vercel, set `MEDIA_WORKER_URL` (the worker's public HTTPS URL) and the same
   `MEDIA_WORKER_SECRET`, then redeploy.

Check it with `GET /health`.

## Things to know before launch

- **YouTube actively blocks data-centre IPs.** From many cloud hosts, YouTube
  answers with "Sign in to confirm you're not a bot". The worker turns that into
  a clear message, but in production you will likely need `YTDLP_PROXY`
  (a residential proxy) and/or `YTDLP_COOKIES_FILE`. Budget for it.
- **Keep yt-dlp current.** YouTube changes often, and yt-dlp ships fixes within
  days. Rebuild the image regularly, weekly at least.
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
non-allowlisted hosts.
