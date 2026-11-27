# Media worker (YouTube downloads, Word and Excel to PDF)

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
the health check (step 4 below) reports `"playlists": "ready"`.

Video bytes go straight from the worker to the browser and never pass through
Vercel. The worker only accepts downloads signed by the web app, and only for
YouTube and X hosts. A tampered token (say, 720p edited to 1080p) is rejected,
and each token starts one job. A stream that is still live, or hasn't
started, is turned away with a message saying so rather than recorded.

A download that fails or is cancelled (`DELETE /jobs/<id>`) doesn't count
against the visitor's quota: the web app voids the grant at the worker's
`POST /refs/<grant>/void`, which says how its job ended, before giving the
download back. The worker keeps this record in memory, so a grant made before
it last restarted isn't given back, and neither is one while it can't be
reached: it may have run the job. Redeploy the worker along with the web app:
an older worker can't void grants, so nothing is given back.

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
4. Check the setup. It reports what's missing: an unset variable, a worker
   that doesn't answer, or no JavaScript runtime. In production it needs the
   secret (anyone else gets a 404):

   ```bash
   curl -H "Authorization: Bearer $MEDIA_WORKER_SECRET" https://<your-site>/api/media/health
   ```

   The worker's own `/health` tells uptime monitors only `{"ok": true}`; its
   versions and settings go to the web app, which sends the secret.

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

## Word and Excel to PDF

Word to PDF and Excel to PDF run headless LibreOffice here (`office.py`). They
are the only tools on the site that upload the visitor's file, and both pages
say so.

```
browser ──(1) Convert──▶ Next.js /api/convert/link   (checks plan, file size, daily quota;
                                                       signs a 2-minute token for this
                                                       file's size and type)
browser ──(2) file + token in X-Convert-Token──▶ worker POST /convert/office
        ◀──────────────────── the PDF, in the same response
```

The file goes straight from the browser to the worker and the PDF straight
back; neither passes through Vercel. Each token starts one conversion and
only for a file of the size and type it names. The upload, LibreOffice's
profile and the PDF are deleted as soon as the PDF has been sent, and at
once when a conversion fails, times out or the visitor cancels (the worker
notices the browser hanging up and stops LibreOffice).

Before LibreOffice sees a file, the worker checks that it is what its name
says (the bytes, the parts inside a `.docx`, `.xlsx`, `.odt` or `.ods`, the
streams inside a `.doc` or `.xls`), and turns away password-protected files,
macro-enabled files (`.docm`, `.xlsm` renamed), zip bombs (more than 512 MB
unpacked, counted as it unpacks, embedded files included) and sheets with more
than a million filled cells, each with a message saying what to do.

LibreOffice runs:

- with a new profile for every job: macros off at the highest level and the
  document opened with macros never run, links never updated, formulas not
  recalculated on load (cached values print, so `WEBSERVICE()` and the like
  never run), pictures or sections linked to files outside the document not
  loaded, and an unreachable proxy;
- with no network at all where the host allows a new network namespace
  (`unshare`; the health check says `"network": "none"`). Docker's default
  seccomp profile doesn't, so in a plain Docker container it is
  `"proxy-only"`: no network through LibreOffice's own settings;
- never as root: as the image's `worker` user (as `nobody` if the worker is
  ever started as root), with a clean environment (no secrets), and the worker
  process itself marked non-dumpable, so LibreOffice can't read its memory or
  environment;
- with a hard timeout (90 s), a memory ceiling (2 GB of address space, a CPU
  limit and a 512 MB output limit), two at a time, up to eight more files
  waiting their turn for a minute before "busy, try again in a minute".

Spreadsheets have three options, set on the page: fit the sheet's width to
the page (on by default; never enlarges), orientation (automatic turns a sheet
wider than a portrait page sideways), and all sheets or the first. A CSV gets
A4 pages, column widths that fit its values, cell lines, and every value
printed exactly as written (leading zeros and dates kept).

### Deploy it

1. Rebuild and redeploy the worker from this folder's `Dockerfile`. The
   LibreOffice block makes the image roughly 500–650 MB larger (estimated
   from Debian's package sizes; `docker image ls` shows the real figure).
2. Give it memory: a conversion took 200–250 MB resident in testing (a
   250-page document, a 1,900-page sheet), so **1 GB** covers two at once
   with room for the worker; **2 GB** if it also serves YouTube downloads.
   One CPU is enough; two let both conversions run at full speed. Set
   `OFFICE_MAX_CONCURRENT=1` on a 512 MB host.
3. Check the worker (it needs the secret to show details):

   ```bash
   curl -H "Authorization: Bearer $MEDIA_WORKER_SECRET" https://<worker>/health
   # ... "office": {"ready": true, "soffice": true, "uno": true, "network": "none" or "proxy-only", ...}
   ```

4. On the web app (Vercel), with `MEDIA_WORKER_URL` and `MEDIA_WORKER_SECRET`
   already set, add `NEXT_PUBLIC_ENABLE_OFFICE_CONVERT=1` and redeploy. Until
   then the two tools are hidden (no page, not listed, not in the sitemap) and
   `/api/convert/link` answers 503. The page's Content-Security-Policy then
   allows the worker's address, as it does for YouTube downloads.
5. Check the web app sees it:

   ```bash
   curl -H "Authorization: Bearer $MEDIA_WORKER_SECRET" https://<your-site>/api/media/health
   # ... "office": {"ready": true, ...}
   ```

6. Convert a file by hand. The token is the one the web app would sign
   (any `.docx` will do; `SIZE` must be its size in bytes):

   ```bash
   SIZE=$(wc -c < letter.docx)
   TOKEN=$(MEDIA_WORKER_SECRET=$MEDIA_WORKER_SECRET node -e '
     const c = require("crypto");
     const key = c.createHmac("sha256", process.env.MEDIA_WORKER_SECRET).update("pdf-wizard/office-token/v1").digest("base64url");
     const body = Buffer.from(JSON.stringify({ k: "office", x: "docx", z: +process.argv[1], o: {}, s: "test", c: c.randomBytes(12).toString("base64url"), t: Math.floor(Date.now() / 1000), e: Math.floor(Date.now() / 1000) + 120 })).toString("base64url");
     console.log(body + "." + c.createHmac("sha256", key).update(body).digest("base64url"));' "$SIZE")
   curl -f -o letter.pdf -H "X-Convert-Token: $TOKEN" --data-binary @letter.docx https://<worker>/convert/office
   ```

   A wrong or expired token answers 401, a file that isn't what its name says
   415, a password-protected one 422, each with a message in JSON.

Settings (all optional):

| Variable | |
| -------- | - |
| `OFFICE_MAX_CONCURRENT` | Conversions at once (default 2) |
| `OFFICE_MAX_QUEUE` | Files that may upload and wait for a turn (default 8) |
| `OFFICE_QUEUE_WAIT_SECONDS` | How long one waits before "busy" (default 60) |
| `OFFICE_TIMEOUT_SECONDS` | Hard limit for one conversion (default 90) |
| `OFFICE_UPLOAD_SECONDS` | Longest an upload may take (default 600) |
| `OFFICE_MAX_BYTES` | Largest upload taken (default 100 MB; the web app's per-plan limits are lower) |
| `OFFICE_MEMORY_MB` | Address-space ceiling for LibreOffice (default 2048; it reserves far more than it uses) |
| `OFFICE_MAX_UNZIPPED_BYTES`, `OFFICE_MAX_ZIP_ENTRIES` | Zip bomb limits (default 512 MB, 10,000 parts) |
| `OFFICE_MAX_CELLS` | Filled cells a spreadsheet may have (default 1,000,000, about 2,000 pages) |
| `OFFICE_MAX_PDF_BYTES` | Largest PDF written (default 512 MB) |
| `OFFICE_SANDBOX` | `off` skips the network namespace (default `auto`) |
| `OFFICE_USER` | Who LibreOffice runs as if the worker runs as root (default `nobody`) |
| `OFFICE_SOFFICE`, `OFFICE_PYTHON` | Only outside the Dockerfile: `soffice`, and the Python that has `python3-uno` (default `/usr/bin/python3`) |

The worker's single-instance rule (below) applies here too: a grant is
recorded in memory, which is what makes a failed conversion refundable.

## Test

```bash
FFMPEG=/path/to/ffmpeg npm run test:media   # needs python3 + yt-dlp
npm run test:office                          # Word and Excel to PDF
```

`test:media` builds a local multi-quality DASH stream shaped like YouTube HD and
checks: the right height at 1080/720/360p, H.264 + AAC merged into MP4, MP3
extraction, and rejection of tampered, expired, and wrongly signed tokens and
non-allowlisted hosts. It also serves local RSS feeds, which yt-dlp lists as
playlists the way it lists YouTube playlists with `extract_flat`, to check
`/playlist`: titles, durations and thumbnails, the 200-item cap and its flag,
rejection of single videos, friendly errors, and that no media is fetched.

`npm run test:office` (`test_office.py`, standard library only) checks what a
file really is without LibreOffice: wrong extensions, damaged files, encrypted
compound files, `.docm`/`.xlsm` renamed, zip bombs (declared, understated and
embedded), sheets too big, empty files, CSV separators and encodings, tokens.
With LibreOffice and `python3-uno` installed it also converts every format and
reads the PDFs back (pages, text, tables, embedded fonts, sheet options, CSV
values as written), checks real password-protected files from LibreOffice, a
picture linked to a file on the server staying out of the PDF, the timeout
and cancel leaving no process behind, LibreOffice not running as root and
having no network, and the route through `worker.py`'s own handler: one
conversion per grant, refusals, busy, the browser hanging up, and the records
a refund reads.
