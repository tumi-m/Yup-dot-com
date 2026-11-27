# PDF Wizard 🧙 — A PDF Editor SaaS

> Cast spells on your PDFs. Merge, split, compress, convert, edit, and sign
> documents right in your browser — free, fast, and private.

**PDF Wizard** is a full-stack PDF toolkit + editor SaaS built with Next.js 16,
Supabase, Paystack, and a fully client-side PDF engine (`pdf-lib` + `pdf.js`). It
combines a grid of focused, instant tools (the model that drives the traffic of
sites like iLovePDF and Smallpdf) with a full editor and a freemium SaaS layer.

---

## Tools (the spellbook)

All tools run **entirely in the browser** — files are never uploaded — so they
work with or without an account. The one exception is Word and Excel to PDF
(hidden until switched on), which uploads the file to our conversion server
and deletes it straight after; its pages say so.

| Tool | What it does |
| ---- | ------------ |
| **Merge PDF** | Combine multiple PDFs into one (drag to reorder). |
| **Split PDF** | Extract page ranges, or split every page into its own file. |
| **Organize PDF** | Reorder pages by dragging or with the keyboard, turn single pages, delete them, add blank pages or another PDF's pages, reverse the order. Undo until you save. |
| **Delete Pages** | Pick pages, or type ranges like `2-4, 7`, and save the PDF without them. |
| **Extract Pages** | Pick pages, or type ranges, and save them as one new PDF. |
| **Rotate PDF** | Rotate all pages 90° / 180° / 270°. |
| **Crop PDF** | Drag a box on a page (or use the arrow keys, or type the margins in mm, in or pt), or trim each page's white margins, and apply it to all pages, this page, odd or even pages, or a typed list. Every page box is set, so viewers and printers agree. A crop hides what's outside; **Remove what's outside the box** turns those pages into pictures of the area kept (text inside stays searchable, links inside keep working), so what was outside leaves the file. Links, notes and fields wholly outside go. |
| **Resize PDF** | Every page onto A4, A3, A5, Letter, Legal, Tabloid or a custom size (mm, in or pt): keep each page's orientation or force one, fit inside, fill and crop, or don't scale, with optional margins, or 2 or 4 pages to a sheet. Pages stay vector; links, bookmarks and comments move with them; form fields are flattened first. Shows the first sheet before you start. Runs in a worker. |
| **Compress PDF** | Resizes images to the size they're shown at and re-encodes them; text, links, bookmarks and forms stay as they are. Never returns a bigger file. |
| **Repair PDF** | Recovers a damaged PDF: junk before the header or after the end, a broken or missing index, a download cut off part way (what arrived is kept, a page cut mid-way keeps its start), damaged object streams, a missing catalog and a page tree that loops. Pages are copied as they were, with their text, fields, links and bookmarks; a page pdf-lib can't copy is drawn by pdf.js as a picture with its text kept searchable. Says what came back: pages of pages, which are pictures, what was lost. Never makes an empty file; files that need a password go to Unlock PDF first. Reading and rebuilding run in a worker. |
| **PDF → JPG** | Render each page to a JPG/PNG, downloaded as a zip. |
| **JPG → PDF** | Combine pictures into a PDF (fit-to-image or A4): JPG, PNG, WebP, GIF (first frame), BMP, TIFF (every page; previews skipped), AVIF, HEIC (where the browser reads it: Safari; elsewhere it says how to save a JPG) and SVG (drawn at print resolution), mixed in any order. EXIF and TIFF orientation kept; pictures right-sized to 300 DPI on the page; transparency kept. Runs in a worker (SVG and HEIC are decoded on the page first). Separate pages for PNG, WebP, HEIC, TIFF and SVG to PDF offer that format in the file picker and take any picture. |
| **Scan to PDF** | The phone's rear camera at its best resolution (or a webcam, or photos), page after page. Each page's corners are found on the device (its own edge and shape search, no OpenCV) and can be dragged, by touch or with the arrow keys; the page is flattened with a perspective warp. Colour, greyscale or Document (black and white, with shadows and uneven light evened out), turn, reorder, retake, delete. One PDF: Fit, A4 or Letter, optionally made searchable with the OCR PDF engine. On a computer it shows a QR code that opens the page on a phone. The camera is allowed on this page only (`lib/permissions-policy.ts`) and turned off when the page is left or hidden. Pages are built in a worker. |
| **TXT → PDF** | A text file (UTF-8, UTF-16 or Windows-1252) laid out on A4 or Letter pages: words wrapped, long words broken, new pages as they fill, a form feed starts a page. Margins, text size (9–14 pt), Sans or Monospace (indents and columns kept), page numbers. Embedded Noto Sans / Noto Sans Mono, so accented Latin, Greek, Cyrillic and Devanagari (shaped) come out right; letters the font lacks (Chinese, Japanese, Korean, Arabic, Hebrew, emoji) are left out and the result says how many. Runs in a worker. |
| **Markdown → PDF** | The same layout for `.md`: headings, bold, italic, strikethrough, inline code, clickable links (web and mail only), numbered, bulleted, task and nested lists, quotes, code blocks, rules and GitHub tables (header repeated on each page). HTML is never rendered: tags are dropped and their words kept. Images aren't fetched; their description is shown. |
| **HTML to PDF** | A web page by its address, an `.html` file or pasted HTML, opened by Chromium on the media worker and printed: A4, Letter or one long page, portrait or landscape, margins, backgrounds, as on screen or the site's print version. Text stays selectable and links work. Pages are opened signed out, with no cookies; private and local addresses are refused on every request the page makes. The PDF is deleted from the worker once downloaded. *Hidden until `NEXT_PUBLIC_ENABLE_HTML_TO_PDF=1`; needs the media worker. Guests 5 a day, free 15, Pro 200.* [More below](#html-to-pdf). |
| **PDF → PDF/A** | An archival copy, PDF/A-2b (or 3b, which keeps attached files): fonts that aren't in the file embedded from free look-alikes with the same letter widths (Arimo, Tinos, Cousine), an sRGB output intent, XMP metadata matching the document's details, a file identifier; scripts, forbidden actions, multimedia, LZW, transfer functions, external streams and (in 2b) attachments taken out; encryption removed (asks for the password when one is needed to open); form fields flattened; comments given their own appearance and print flag. Pages that can't be fixed in place become pictures with their text kept searchable, and are named. Then our own check of those rules, shown plainly as ours, with a pointer to veraPDF for formal proof. Runs in a worker. [More below](#pdf-to-pdfa). |
| **PDF → Word** | Editable DOCX with real heading styles, lists, and tables. |
| **Translate PDF** | The document's text (never the file) translated by the language model behind the AI Assistant into one of 91 languages, South Africa's 11 official written languages among them: a Word file with headings, lists and tables kept (right to left for Arabic, Hebrew, Persian and Urdu), and a PDF for Latin, Greek, Cyrillic and Devanagari scripts. Progress by passage, Cancel, a preview. Scanned pages are named and sent to OCR PDF. *Guests 15,000 characters a day; needs the AI settings.* [More below](#translate-pdf). |
| **Word → PDF** | *Hidden until `NEXT_PUBLIC_ENABLE_OFFICE_CONVERT=1`; needs the media worker with LibreOffice.* `.docx`, `.doc`, `.odt`, `.rtf` converted by headless LibreOffice on the media worker, with fonts made to Office's widths (Carlito, Caladea, Liberation), all embedded, headings as bookmarks, tagged. **Uploads the file** (the page says so) and deletes it as soon as the PDF is sent. Guests 5 a day, free 10, Pro 200; 25 MB, 100 MB with Pro. [More below](#word-and-excel-to-pdf). |
| **PDF → Excel** | Every detected table as its own sheet; numbers stay summable. |
| **Excel → PDF** | *Hidden until switched on, as Word → PDF.* `.xlsx`, `.xls`, `.ods`, `.csv`: fit each sheet's width to the page, orientation (automatic, portrait, landscape), all sheets or the first. CSV values print exactly as written. Same upload, deletion and limits as Word → PDF. |
| **PDF → Text** | Extract text in true reading order (multi-column aware). |
| **PDF → Markdown** | Layout-aware conversion keeping headings, lists & tables. |
| **Extract Tables** | Detect tables by column structure, export each as CSV. |
| **PDF → RAG Chunks** | Retrieval-sized JSON chunks with heading breadcrumbs. |
| **OCR PDF** | Make scans searchable (invisible text layer) or extract text. 7 languages, on-device. |
| **AI Assistant** | Summarize a PDF and ask questions; answers cite pages. *Guests get 3 answers/day; needs an API key.* |
| **Protect PDF** | Encrypt with a password; choose print/copy permissions. |
| **Unlock PDF** | Remove a password you know. |
| **Redact PDF** | Black out text and areas for good: draw boxes (mouse, pen, a finger on a box's handles, or the keys), find text with "Mark all" (match case, whole words), or mark every email, phone number, card number (Luhn-checked), South African ID number (birth date and check digit), account-like number or IBAN, and date. A list shows, unticks or removes each mark; long files have page navigation. Each page with a mark is rebuilt as a picture with the marks painted black before it is encoded, its other words kept searchable as invisible text (not those under or next to a mark); pages without marks stay as they are. The file also loses its details and XMP metadata, scripts, attached files, thumbnails, the comments and fields on rebuilt pages, links over a mark, bookmark titles naming redacted text and anything nothing uses. Text a crop hides is found too, and marking it rebuilds its page from what shows. Copies of marked text left unmarked elsewhere are listed first: mark them too, or leave them on purpose. Up to 100 pages with marks at once free, 1,000 with Pro. The result is searched (every decoded stream and string, object streams too) and read again by pdf.js before it is offered; if anything redacted is left, nothing is saved. |
| **PDF → PPTX** | Each page becomes a picture slide (the text isn't editable). |
| **PPTX → PDF** | Renders PowerPoint slides in the browser as image-based pages with a selectable text layer; hidden slides are skipped and the file is never uploaded. |
| **Edit PPTX** | Edit slide text, reorder, duplicate or delete slides, then save as PPTX or PDF. In the browser. |
| **Google Slides → PDF / PPTX** | Download a deck from its link. The deck must be shared as "Anyone with the link"; private decks get a message saying so. PPTX can go straight into Edit PPTX. |
| **TikTok to MP4 / MP3** | Save a TikTok (full or short `vm.tiktok.com` link), or just its sound. Works with no extra setup. |
| **Instagram to MP4 / MP3** | Save a public Reel or video post, or just its audio. Works with no extra setup, but Instagram often blocks logged-out access from servers. |
| **YouTube to MP4** | *Paused (hidden) until `NEXT_PUBLIC_ENABLE_YOUTUBE=1`.* 360p–720p free; **1080p with Pro**. Separate 720p and 1080p pages. *Needs the media worker.* |
| **YouTube to MP3** | Audio only, extracted by the worker's ffmpeg. *Needs the media worker.* |
| **YouTube Playlist** | Lists a playlist (up to 200), downloads the picked videos as MP4 or MP3 two at a time (each counts toward the daily quota), and exports the list as CSV or TXT. *Needs the media worker.* |
| **X (Twitter) to MP4 / MP3** | Save a post's video, or just its audio. Works with no extra setup. |
| **Compress Video** | MP4, MOV or WebM in, a smaller H.264 MP4 out, in the browser (WebCodecs). Three presets; up to 4K. A file that's already lean comes back as it was. |
| **Sample Finder** | Paste a YouTube or TikTok link, or type a song: what it samples, where it was sampled, covers and remixes. Reads only the video's title, so it works while YouTube downloads are paused. Data from MusicBrainz and a hand-checked list. [More below](#sample-finder). |
| **Page Numbers** | Insert page numbers with position & format options. |
| **Watermark** | Stamp diagonal text across every page. |
| **Flatten PDF** | Make form fields, or fields and comments, part of the page so they can't be edited, keeping text selectable and links working; or turn every page into a picture (100–300 DPI), optionally keeping its text searchable; a run that would make more pictures than a browser tab can hold is turned away first, naming a resolution that fits. What was flattened leaves the file, along with anything only it used (an attached file, XFA data, an old field picture). The editor can flatten fields when it saves. |
| **Compare PDFs** | Two drop zones, the original and the changed version (swap them with one button). Every word of both is compared over the whole document, so text moved to another page shows as one move and a page added or taken out in the middle leaves the rest paired. Ligatures, odd spaces and words broken over a line end are evened out first; form values count. Changes are marked on the pages, side by side in one scroll: struck through in red where taken out, underlined in green where put in, a dashed line for moves, a dashed box for pictures, so they read without colour; on a phone one file's pages show at a time. A list with next and previous (N and P keys while focus is in the comparison), an overlay with a swipe slider and a pixel Difference view. Pages without text are compared by how they look; a tick does every page. Downloads: a report PDF and both files with the changes as comments. Up to 200 pages a file free, 2,000 with Pro. |
| **Edit PDF** | Full editor: change the text that's there, add text, whiteout, shapes, notes, links, form fields. |
| **Edit PDF Text** | The editor, opened in Edit text: click a line (or reach it with the keys) and change its words, size, bold, italic or colour, or remove it. Where the page draws the line on its own, the old words are taken out of the file and the new ones drawn on the same baseline; otherwise they are covered with a box in the page's colour, and the save says so and points to Redact PDF. New words use the line's own font when the file holds all of it and it has every letter, else the closest standard font, with Noto Sans for letters those lack. Turned and cropped pages work; right-to-left and top-to-bottom text can't be changed yet. Same limits as Edit PDF. |
| **Fill & Sign** | Fill existing PDF forms and place a drawn signature. |

Each tool has its own SEO-optimised, statically-generated page at
`/tools/<slug>` and is registered in [`lib/tools.tsx`](lib/tools.tsx).

---

## User journey: free first, upsell after value

Modelled on how the category leaders convert — [PDFescape](https://www.pdfescape.com/what/premium/)
(no registration, no watermark, limits as the upsell), iLovePDF (file-size and
batch caps), and Smallpdf (task-based prompts):

1. **No account wall, anywhere a first task happens.** The homepage hero asks
   what you're working on: PDF, PowerPoint, Google Slides, or video & audio
   (`/#pdf`, `/#pptx`, `/#slides`, `/#media` open a branch directly). Drop a
   file and pick what to do ("Edit", "Compress", "PPTX to PDF"…) and it is
   handed to that tool without a second upload; paste a Slides, X or YouTube
   link and pick PDF, PPTX, Edit, MP4 or MP3.
2. **The full editor works as a guest.** Edit PDF and Fill & Sign open
   instantly in an on-device editor (`/edit/[id]`, IndexedDB) that survives a
   reload. Opening, editing and previewing are unlimited; saving or
   downloading the result is one edit (guests and Free: 1 a day, with a small
   "Made with PDF Wizard" mark; Pro and Team: unlimited, no mark). The same
   for Edit PPTX.
3. **Keep going.** Every success screen offers the next step for the same file
   (compress → protect, OCR → Word…) — no download/re-upload round trip.
4. **Upsell only after value**, always dismissible, never blocking:
   a quiet card on success screens; one friendly nudge after a guest's third
   task of the day (at most once a day); an upgrade prompt when a real limit is
   reached (file size, batch size, AI answers, edits); and a cloud-save offer after a
   guest saves their first edit.

| Tier | Files | Batch | Edits/day | AI answers | Translation | Cloud library |
| ---- | ----- | ----- | --------- | ---------- | ----------- | ------------- |
| Guest (no account) | 50 MB | 10 | 1, marked | 3 a day | 15,000 characters a day | — (saved on device) |
| Free account | 50 MB | 10 | 1, marked | 10 a day | 60,000 characters a day | 5 documents |
| Pro | 500 MB | 200 | Unlimited | 40 a day, 600 a month | 400,000 characters a day | Unlimited |
| Team | 500 MB | 200 | Unlimited | 40 a day per member | 400,000 characters a day per member | Unlimited |

Limits live in `lib/limits.ts` and `lib/usage.ts`; the upsell UI in
`components/upsell/`. File and batch limits are enforced in the browser (tools
run there). Daily allowances (AI answers, translated characters, edits,
video downloads, Slides imports, song lookups) are counted on the server in Supabase (`usage_counters`, through
functions only the service role can call), keyed by user id or, for guests,
by a salted SHA-256 of their IP (raw IPs are never stored). The IP is the
one Vercel's edge reports (`x-real-ip`), never the first entry of
`X-Forwarded-For`, which the visitor writes. Hosted elsewhere, set
`TRUSTED_PROXY_HOPS`; without it every guest shares one allowance. Without
`SUPABASE_SERVICE_ROLE_KEY` they are counted in server memory instead (fine for
local dev, not for Vercel). AI also has a burst limit (6 a minute) and a
site-wide daily cap. An answer that never arrives is given back to the
daily allowance, up to as many a day as that allowance, but still counts
toward those two, since the model ran; one that never reached the model
leaves the site-wide cap alone. So one visitor adds at most twice its daily
allowance to the site-wide cap (6 for a guest IP). That cap is shared by
every plan: when it is reached, everyone sees "busy" until UTC midnight. An
edit is one distinct document saved or downloaded per UTC day; the same
unchanged document again is free.

## Video & Audio downloads

**X (Twitter)** works on the web app alone. `/api/media/info` resolves the post
through X's public embed endpoint (with FxTwitter and vxTwitter as fallbacks),
`/api/media/file` streams the MP4 from `video.twimg.com` with a proper filename,
and MP3 is converted in the browser with ffmpeg.wasm (self-hosted under
`/vendor`). When a post's only file is above the visitor's plan (1080p on
Free), the browser gets just its sound to convert, an M4A that
`/api/media/file` copies out of the video (`lib/audio-only.ts`), never the
video itself. These endpoints are unofficial and can change without notice.

**TikTok** works on the web app alone too (`lib/social/tiktok.ts`, following
yt-dlp's web method): the server loads the public post page, reads the
`__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON for the play URLs, and solves
TikTok's proof-of-work page when it shows one. The page's cookies and Referer
travel inside the signed download grant, because TikTok's CDN wants them.

**Instagram** (`lib/social/instagram.ts`) reads the public post page's
embedded JSON, then the embed page (its escaped `contextJSON`), then tries
yt-dlp's logged-out GraphQL query after the `get_ruling_for_content` check.
Every request sends a browser's `Sec-Fetch-*` headers: without them
Instagram answers pages with its error page and the API with "SecFetch
Policy violation". The GraphQL query is refused (HTTP 429) to plain HTTP
clients, and the embed leaves the file out of posts with blocked music.
Instagram limits logged-out access hard, especially from cloud servers, so
expect "Instagram is limiting downloads from servers right now" at times.
Each failed resolve logs one `Instagram resolve failed (…)` line with every
step's status and reason, to see in the server logs what Instagram answered.

TikTok and Instagram are unofficial, change without notice, and forbid
downloading in their terms; files only ever come from their own CDNs
(host allowlists in `lib/social/direct.ts`).

Each quality shows its file size: exact where the platform gives one
(TikTok's `DataSize`, or a HEAD request's `Content-Length`), otherwise bitrate ×
duration (`lib/media-size.ts`). When a 1080p or 720p file spends at least 1.4×
the bits it needs (`lib/video-quality.ts`, about 4.4 Mbps at 1080p30), a
**Smaller file** switch re-encodes it to H.264 in the browser with
[mediabunny](https://mediabunny.dev) (`lib/video-compress.ts`, the same engine as
Compress Video). It's off until the visitor turns it on (the choice is
remembered), and hidden where the browser has no H.264 encoder. MP3s use the
LAME VBR level closest to 1.4× the source's audio bitrate (V2 to V6) and keep
mono audio mono.

**YouTube** is paused (its tools are hidden) until `NEXT_PUBLIC_ENABLE_YOUTUBE=1`.
It needs a separate container ([`media-worker/`](media-worker/README.md):
yt-dlp + Deno + ffmpeg), because YouTube's HD tracks must be merged and its
stream URLs only work from the IP that requested them.

For all of them, the web app checks the plan (1080p is Pro) and the daily quota
(guest 5, free account 10, Pro 200), then signs a short-lived token for exactly
one download. After deploying, check what's missing with
`curl -H "Authorization: Bearer $MEDIA_WORKER_SECRET" https://<your-site>/api/media/health`
(without the secret it answers 404 in production).
Read the worker README's **Things to know before launch** section: YouTube
blocks cloud IPs, and there are legal points too.

## HTML to PDF

`/tools/html-to-pdf` (also found as URL to PDF, Webpage to PDF, Save web
page as PDF) saves a web page, an HTML file or pasted HTML as a PDF. A page
needs a real browser, so it is rendered on the media worker
(`media-worker/render.py`, headless Chromium driven by Playwright), not in
the visitor's browser, and the page says so before anything is sent.

1. **The grant** (`POST /api/render/link`, `lib/web-pdf-route.ts`): other
   sites' pages are refused; the address must be http or https, without a
   user name or password, not a private, local or metadata address (also
   after a DNS lookup) and not on a port below 1024 but 80 and 443. HTML is
   checked by size (up to 5 MB) and only its SHA-256 is sent. Then the
   daily allowance (guest 5, free 15, Pro and Team 200; up to 50 pages a
   PDF free, 300 with Pro), 6 tries a minute per person and 3,000 a day
   site-wide (`WEB_PDF_GLOBAL_DAILY_LIMIT`). Each try counts, even when the
   site then fails: the worker did the work.
2. **The worker** verifies the grant, opens the page in a fresh browser
   context and prints it. Every connection the page makes goes through a
   proxy in the worker that checks the address it connects to, after DNS,
   for every redirect and subresource; see
   [media-worker/README.md](media-worker/README.md#html-to-pdf-web-pages-html-files-pasted-html).
3. **The PDF** goes from the worker straight to the browser and is deleted
   from the worker's memory once sent (or after about two minutes).

Off until the owner deploys the worker and sets
`NEXT_PUBLIC_ENABLE_HTML_TO_PDF=1`: until then the tool is left out of
every list, search, the sitemap and the CSP, and `/api/render/link` answers 404.

## Sample Finder

`/tools/sample-finder` shows what a song samples, where it was sampled, its
covers and its remixes. Paste a YouTube or TikTok link, or type
"Artist – Title". It only reads a video's title, so it works while YouTube
downloads are paused; the homepage's video box and the X, TikTok and
Instagram tools offer it for YouTube links.

1. **Which song** (`POST /api/samples/identify`). A YouTube link's title and
   channel come from YouTube's public oEmbed endpoint (no key, no download); a
   TikTok post's sound from its public page; typed text is read as it is.
   `lib/samples/parse.ts` takes the artist and title out of the title
   (Topic and VEVO channels, separators, quotes in any script, tags such as
   "(Official Video)" dropped, live, remix or sped-up versions noted) and
   scores how sure it is. One MusicBrainz search finds the recording. Sure:
   the song is shown. Fairly sure: shown, with other matches behind "Not
   this song?". Unsure: the page asks "Which song is this?" and offers a
   form to type it. A clear reading MusicBrainz doesn't have (typed, or on
   the artist's own channel) is shown, saying so. 10 searches a minute per
   visitor, no daily allowance.
2. **Its connections** (`POST /api/samples/lookup`). One MusicBrainz
   recording lookup (with the song's work, so covers come in the same
   answer), merged with a hand-checked list of famous samples
   (`lib/samples/catalog.ts`) that also says what each one takes: a hook,
   vocals, drums, the bassline, or an interpolation (replayed, not lifted).
   Each lookup spends one of the day's (guest 10, Free 30, Pro and Team 300);
   another pick for the same search, the same song again that day, answers
   already cached, shared links and the hand-checked list are free. A
   shared link (`?q=…&rec=…`) opens from the cache only, under MusicBrainz's
   own title for that recording; one not cached yet just fills the box.

MusicBrainz is asked politely: a User-Agent naming the site and its
contact page, requests 1.1 s apart per server instance with at most one
waiting per visitor, one a second across the site (`usage_counters`), and
after a 503, 429 or timeout nothing at all for a while (its Retry-After, or
30 s doubling to 5 minutes), shared by every instance. Meanwhile visitors get
the hand-checked results with "MusicBrainz is busy". Answers are cached in
Supabase (`sample_cache`: 30 days, video titles 7 days, misses 1 day),
keyed by the song or video, or a search by a hash of the exact query sent;
never who asked. Run
[`supabase/migrations/20261107000000_sample_cache.sql`](supabase/migrations/20261107000000_sample_cache.sql)
once (new projects get it from `supabase/schema.sql`); without it the cache
is per server instance. `SAMPLES_MB_DISABLED=1` serves the hand-checked list
alone. Only MusicBrainz's open data (CC0) and widely documented facts are
used: no timestamps and no paid or closed sample databases.

## Layout-aware parsing

The 2026 generation of PDF parsers (IBM's **Docling**, **Marker**, **MinerU**)
share one insight: naive extraction concatenates text in stream order, which
scrambles multi-column pages and destroys tables. What downstream LLM/RAG
pipelines actually need is a *document tree* — reading order, heading hierarchy,
paragraphs, lists, and table structure.

Those tools are GPU/Python vision models. [`lib/pdf/parse.ts`](lib/pdf/parse.ts)
implements the same core idea using pure geometry, entirely in the browser —
every pdf.js text item carries a position, size, and font, which is enough to
rebuild structure:

1. **Spans → lines** — cluster glyph runs sharing a baseline.
2. **Column detection** — find the vertical gutter from a span-occupancy
   histogram *before* line grouping (columns usually share baselines, so
   grouping first would fuse them), then read left column fully before right.
3. **Heading hierarchy** — classify by font size relative to the weighted median
   body size, plus short bold lines.
4. **Paragraphs & lists** — group by line gap and indentation; detect bullet and
   ordered markers.
5. **Tables** — split lines into cells at wide horizontal gaps, then group
   consecutive rows whose cell x-positions align.

Serializers emit Markdown, plain text, per-table CSV, and RAG chunks that carry
their heading breadcrumb (`Report > Q3 > Revenue`) so each chunk stays
semantically self-contained.

**Honest limits:** this is a deterministic heuristic parser, not a vision model.
It is strong on digital PDFs and does **not** do OCR — scanned documents are
detected and reported rather than silently returning nothing.

## OCR, security, and Office conversion

- **OCR** — pages are rendered with pdf.js and recognised by Tesseract
  (WebAssembly) on the user's device. The searchable-PDF output lays an
  invisible text layer (render mode 3) exactly over each scanned word, scaled
  horizontally to match, so selection and search line up with the image —
  the same technique as Acrobat's *Recognize Text*.
- **Protect / Unlock** — upstream pdf-lib cannot write encrypted PDFs, so
  `lib/pdf/security.ts` isolates the `@cantoo/pdf-lib` fork, which adds the
  standard security handler.
- **Word / Excel** — built on the layout-aware parser, so headings map to real
  Word heading styles and tables to real tables. The `.xlsx` is written
  directly as SpreadsheetML over JSZip instead of pulling in a ~1 MB library.
  These target editable *content*, not a pixel-perfect copy of the layout.

## Word and Excel to PDF

`/tools/word-to-pdf` and `/tools/excel-to-pdf` share one panel
(`components/tools/OfficeToPdf.tsx`) and are the only tools that upload the
visitor's file. Browsers can't lay out a Word or Excel file faithfully, so the
media worker runs headless LibreOffice (`media-worker/office.py`):

1. The page asks `POST /api/convert/link` (`lib/office-server.ts`) with the
   tool, the file's extension and size (never its name), and for spreadsheets
   the page setup. The
   route refuses other sites' pages, types the tool doesn't take (by
   extension; the worker checks the bytes), empty files, files over the
   plan's limit (`officeMaxBytes`), more than ten asks a minute, and the
   daily allowance once spent (`officeConversionsPerDay`, bucket `office`),
   which it spends before answering. It answers with the worker's URL and a
   token signed with a key derived from `MEDIA_WORKER_SECRET` for this
   purpose: it names the file's size and extension and the options, lasts two
   minutes, starts one conversion, and can't pass for a download grant. The
   file's name never leaves the browser.
2. The browser uploads the file straight to the worker
   (`POST /convert/office`, token in `X-Convert-Token`), showing upload
   progress, then "Converting on our server" with the seconds, then the PDF
   arriving. The worker checks the file, converts it and sends the PDF back in
   the same response, then deletes everything.
3. A conversion that failed, was turned away or was cancelled is given back
   through `POST /api/convert/refund`, by the worker's own record, as YouTube
   downloads are, up to five a day per person. One that ran out of time
   isn't.

The pages say plainly, next to the drop zone and the Convert button and in
their questions, that the file is uploaded and deleted straight after; the
privacy policy and security page add the same while the tools are on. The
worker side (type checks, password-protected and macro-enabled files, zip
bombs, files that link outside themselves, LibreOffice's own root, timeouts,
the queue) is in
[`media-worker/README.md`](media-worker/README.md#word-and-excel-to-pdf).

**Switching it on:** rebuild the worker, check
`/api/media/health` reports `"office": {"ready": true}`, set
`NEXT_PUBLIC_ENABLE_OFFICE_CONVERT=1` and redeploy. Until then the tools have
no page, aren't listed, searched or in the sitemap, `/api/convert/link`
answers 503, and the CSP doesn't name the worker for them. `.pptx` stays with
PPTX to PDF, which renders it in the browser; `.ppt` and `.odp` aren't taken.

## Self-hosted runtime assets

`scripts/copy-vendor.mjs` runs before `dev` and `build` and copies the pdf.js
worker, the Tesseract engine, and all seven OCR language models from
`node_modules` into `public/vendor/` under **version-stamped paths**. They are
served from the app's own origin with `immutable` caching. So:

- the tools keep working behind firewalls, strict CSPs, and CDN outages;
- the browser tools make **zero third-party requests** (Google Analytics, when
  configured, loads only after a visitor accepts cookies);
- an upgrade can never pair a new pdf.js API with a stale cached worker
  (pdf.js refuses to run on a mismatch).

pdf.js runs from its legacy build, in the page and in the worker: the modern
build needs `Promise.withResolvers`, which Safari only has from 17.4 (iPhones
stuck on iOS 16 never get it).

`public/vendor` is generated and git-ignored.

## AI Assistant

`/tools/chat-with-pdf` parses the PDF in the browser and sends only its
page-tagged text to `POST /api/ai/chat`, which streams the answer back as
NDJSON. The model runs on [Ollama](https://ollama.com): Ollama Cloud by
default (DeepSeek V4.1 Flash), or your own Ollama server. The text is sent to
that host; the file never is. Guard rails: a daily allowance per tier (guests
included); long documents are cut at a page boundary to the plan's budget, and
both the model and the user are told which pages were read; the model's
reasoning is never shown. Returns `503` until `OLLAMA_API_KEY` (Ollama Cloud)
or `OLLAMA_HOST` (your own server) is set.

## Translate PDF

`/tools/translate-pdf` reads the PDF in the browser with the layout-aware
parser and cuts it into passages (`lib/translate/segments.ts`): each heading,
paragraph (long ones at sentence ends, at most 1,200 characters), list item
and table cell. Text with no letters (numbers, dates, amounts) stays as it is
and the same text twice is sent once. Up to 40 passages and 3,000 characters
go in one request to `POST /api/ai/translate`, two requests at a time, on the
same Ollama host as the assistant (`OLLAMA_TRANSLATE_MODEL` picks a model of
its own). The route (`lib/ai/translate-route.ts`) checks the site, the body
and the allowance as the chat route does, and streams each translation back
as NDJSON as it arrives.

The document's text is untrusted. It goes to the model as JSON lines in the
user message, never in the system prompt, which says to translate the
passages and never follow, answer or comment on them
(`lib/ai/translate.ts`). The answer must be JSON lines keyed by the request's
own short ids: prose, code fences, broken lines, unknown ids and "translations"
more than four times their passage's length (ten times for Chinese, Japanese
and Korean, at least 40 characters) are dropped. The model may write about
three tokens a character sent (1,536 to 8,192), and the route closes its
stream as soon as every passage has its answer, so a request can't be made to
write much more than it sent. Passages the model left out, or seems to have
merged into a neighbour, are asked for once more in the same request; any
still missing keep their original text in their own place, and the result
says how many and on which pages. Nothing is rendered as HTML, and the text is
never logged. The page and the privacy policy say the text goes to the same
AI provider as Chat with PDF's, and nothing is stored.

The files are written in a Web Worker (`lib/pdf/translate/`): a Word file from
`buildDocx` (paragraphs, tables and runs right to left for Arabic, Hebrew,
Persian and Urdu, with the language set) and, for Latin, Greek, Cyrillic and
Devanagari, a PDF laid out by the Markdown to PDF layout in Noto Sans.
Devanagari is shaped by fontkit (conjuncts, vowel signs before their
consonant), which needs a small stand-in for the generator runtime its Indic
shaper was compiled for (`provideGeneratorRuntime` in
`lib/pdf/text-to-pdf/fonts.ts`). Other scripts (Arabic, Hebrew, Chinese,
Japanese, Korean, Thai, other Indian scripts) come as a Word file only, and the
page says why before anything is sent. Picture-only pages are listed with a
link that takes the file to OCR PDF.

The allowance is counted on the server in characters, in blocks of 500 per
request (rounded up): guests 15,000 a day, Free 60,000, Pro and Team 400,000;
30 requests a minute per person and 3,000 requests a day site-wide. The page
works out what a document will take before it starts and, when it is more
than what is left, says so and offers Split PDF (and to guests and Free the
upgrade). What a request didn't deliver (it failed, was stopped, or the model
left passages out) is given back, keeping only whole blocks of what did come
back, so asking again for the rest never costs more than the first request;
up to 10 requests a day. Cancel aborts the requests, which closes the model's
stream. Passages that came back stay on the page, so translating again after
Cancel or a failure sends only the rest, and the page says what was kept and
what it counted; nothing half-translated is offered as a file.

Translate PDF isn't among the tools the homepage offers for a dropped PDF:
those twelve fill three rows of four above the fold, and a thirteenth sat
alone below it.

## PDF to PDF/A

`/tools/pdf-to-pdfa` (`lib/pdf/pdfa/`) works in a Web Worker on pdf-lib, with
no server and no Ghostscript. `convert.ts` runs the steps: open (decrypting as
Unlock PDF does), flatten form fields with Flatten PDF's code (checkboxes
whose mark is a ZapfDingbats letter are redrawn as lines first),
`annotations.ts`, `objects.ts` (actions, attachments, streams, graphics state,
odd hex strings and numbers, optional content), then `content.ts` reads every
content stream (pages, forms, appearances, Type 3 glyphs, patterns, soft
masks) with the compress lexer: which fonts draw which codes visibly, operators
PDF doesn't define (cut out), inline images and q/Q nesting PDF/A forbids.

Fonts that draw visible text but aren't embedded get a substitute
(`fonts.ts`, `truetype.ts`): each code's glyph name (from its encoding and
`glyph-names.ts`) or ToUnicode gives the letter, found in Arimo, Tinos or
Cousine (@fontsource, OFL, served from `/vendor`), and a small symbolic
TrueType font of just those glyphs is written with each glyph as wide as the
PDF already draws it, so nothing moves and the widths agree. A letter that
can't be found, or whose natural width is more than 5% of the size away, makes
that font's pages pictures instead: drawn by pdf.js at 200 DPI on the page
(`pictures.ts`), with the page's text invisible over them, then put in place
(`splice.ts`; links are kept and moved). `colour.ts` adds the sRGB output
intent (a CC0 ICC v2 profile kept in `srgb.ts`), or keeps a sound RGB or CMYK
one the file had, and gives DeviceCMYK a default colour space (the usual
CMYK-to-RGB formula) where needed; it also checks ICC profiles and JPEG 2000
pictures. `metadata.ts` writes the XMP and Info alike, and the trailer ID.
`check.ts` reads the saved file back and checks those rules; the report says
it is our own check and points to veraPDF. PDF/A-1b isn't offered: it forbids
transparency and wants CharSet and CIDSet lists for every font subset, which
would need Type 1 and CFF font parsing this tool doesn't have, so many pages
would become pictures. The tests (`tests/pdf-to-pdfa.test.mts`) also save
their results when `PDFA_OUT` is set, to run veraPDF on them.

## Motion design

`components/motion/primitives.tsx` holds a small shared vocabulary — one
easing curve, reveal-on-scroll, stagger, word-by-word headlines, spotlight
cards, count-ups, and a sparkle burst — all wrapped in `MotionConfig
reducedMotion="user"`, so visitors who ask their OS for less motion get it.
The landing hero (floating hat, orbiting tools, cursor parallax, cycling
before/after examples) lives in `components/landing/`.

## Editor

The editor renders each page to a canvas with **pdf.js**, then overlays an
annotation layer. Annotations are stored in **PDF points with a top-left origin**
so they're zoom-independent; the y-axis is flipped once, at bake time.

Cloned from PDFescape and extended: **whiteout**, rectangles, ellipses, lines,
arrows, highlight/underline/strikeout, sticky notes, images, signatures,
**links**, and **form field creation** (text, checkbox, radio, dropdown).
Links become real clickable link annotations and form fields become real
AcroForm fields, so both stay interactive in the exported PDF. Existing forms in
an uploaded PDF are detected and overlaid with live inputs for filling.

Usability work: **undo/redo** (one entry per gesture, not per frame), resize
handles on every annotation, a **thumbnail sidebar** with drag-to-reorder and
per-page rotate/insert/delete, a contextual **properties panel**, keyboard
shortcuts, and toasts. Page operations keep edits editable: they move with
their pages, in undo too (`lib/editor/page-map.ts`); only a turned page's edits
are drawn into it first.

**Edit text** (the E tool; `/tools/edit-pdf-text` opens the editor in it)
reads the shown page's text when it is turned on: pdf.js's text items, each
letter placed from the page's drawing operations with the reader Redact PDF
uses (`lib/pdf/redact/page-text.ts`, which also says which operation drew each
letter), grouped into runs of one line in one font, size and colour
(`lib/pdf/edit-text/runs.ts`). A run is boxed along its own baseline, so turned
pages, offset CropBoxes and sideways text line up. A run can be taken out when
every operation that draws it is in the page's own content, draws nothing
else but spaces, isn't Type 3, invisible or clipped short; the run keeps those
operations' places and character codes. On save (`lib/pdf/edit-text/apply.ts`,
loaded only when text was changed) the page's content is read again with the
content-stream lexer, each operation is checked to be the same one (same
count, same codes) and cut out, leaving a number-only TJ where later text on
the line is placed after it; the old streams leave the file. Anything that
can't be shown safe is covered with a box in the colour sampled round the run
on the page as drawn, and the editor says which on save. A line drawn twice
(bold made that way, a shadow) is one run and both copies go; one with other
text, a picture or an opaque shape painted in the same place, or drawn fully
transparent, is covered. Alternate text round removed words (ActualText, Alt
and E, in marked content or the structure tree) goes with them. Covers are
tagged, so the words under them aren't offered again, nor is the free plan's
mark. On a phone the words are typed in the sheet's own text box. Changes are edits
like any other: undo, redo and page moves keep them. Right-to-left and
top-to-bottom runs are shown but locked, with a note.

**Organize PDF, Delete Pages and Extract Pages** share one page grid
(`components/tools/PageOrganizer.tsx`). Moves, turns, blank pages and
deletions only change a list of pages (`lib/pdf/pages/plan.ts`), so they are
instant and undo is free; the PDF is written once, on save, in a Web Worker
(`lib/pdf/pages/`). Organize and Delete change the file in place, like the
editor's page operations; Extract copies the picked pages out, like Split.
Only the rows near the visible part of the grid are on the page at all (the
rest is kept as scroll room), so reversing or undoing on a 20,000-page file
is instant. Thumbnails are drawn two at a time and let go of their pixels
when scrolled away. A file with no pages, or a page tree that loops, is
turned away when it opens.

**Compare PDFs** (`components/tools/CompareTool.tsx`, `CompareView.tsx`,
`lib/pdf/compare/`) reads each page with the parser (`readPageText` in
`lib/pdf/parse.ts`), one page at a time in the page, since pdf.js parses in
its own worker. The words keep their page and box (`words.ts`); jsdiff's
Myers diff runs over the whole document in a Web Worker (`diff.ts`), and on
two long, very different files it lines up lines first when it runs out of
time. Pages are paired by the words they share (`pages.ts`). Pages with no
text are drawn and compared pixel by pixel in the page (`pixels.ts`, `run.ts`),
a pair at a time with progress and Cancel; the report (laid out by Markdown to
PDF) and the marked copies (highlight, strike-out, underline, square and note
annotations, `mark.ts`) are written in the worker. OCR isn't run on scans:
the page says so and points at OCR PDF.

**Crop PDF** (`components/tools/CropTool.tsx`, `lib/pdf/crop/`) keeps the box
as margins measured on the page as shown (`geometry.ts`), and maps them
through `lib/pdf/page-frame.ts`, so turned pages and MediaBoxes that don't
start at 0,0 crop where the box was drawn. Writing the file runs in a Web
Worker (`index.ts`). Finding white margins and drawing the pictures for
"Remove what's outside the box" need pdf.js and a canvas, so they run in the
page a page at a time (`pictures.ts`), with progress and Cancel, and a run
that would hold more pictures than a tab can is turned away first. Redrawing
the old content clipped to the box would look the same but keep every word
in the file, so removing is done with pictures and the page says so.

**Redact PDF** (`components/tools/RedactTool.tsx`, `lib/pdf/redact/`) keeps
every mark in displayed points from the page's top-left (`marks.ts`, which
also holds the search, the presets and their checks, and works out which
text each mark takes away and where unmarked copies of it are). pdf.js gives
one box per run of text, so the pages a search or preset finds something on
are read again with each letter placed by the font's own widths, character
and word spacing and kerning, from the page's drawing operations
(`page-text.ts`); until then letters are shared out by typical widths. Search
marks get a little room round them, and before a page is painted each one
grows along its line over any ink it cuts, up to an em, so no part of a
letter shows; words near a box are left out of the searchable layer. pdf.js
leaves out text outside a page's visible area (a crop hides it, but it is
still in the file), so text is also read from a copy whose page boxes are
made very large: what it finds there is marked "outside the visible page",
and marking it rebuilds the page from what shows. Drawing the marked
pages with the marks painted black needs pdf.js and a canvas, so it runs in
the page a page at a time (`pictures.ts`); rebuilding the pages, the clean-up
and a search of every object of the written file run in a Web Worker
(`index.ts`, `scan.ts`); then the result is opened again with pdf.js and its
text, comments, fields, bookmarks and details are read, the words under each
mark looked for (outside the visible area too), and each mark checked to
come out black (`verify.ts`). Up to 100 pages with marks are rebuilt at once
free, 1,000 with Pro. A
mode that removes only the text and pictures under the marks and keeps the
rest of the page as it was is not offered: it can't yet be shown to be safe
on every kind of font and drawing, and a picture of the page can.

## Tests

```bash
npm test
npm run test:office   # the worker's Word and Excel to PDF (python3; LibreOffice for the conversions)
```

`tests/office-route.test.mts` runs `/api/convert/link` and `/api/convert/refund`
(switch off and on, other sites, types, empty files, each plan's size and
daily limits, the minute's limit, what a grant says and its key, refunds by
the worker's record, and a grant verified by the worker's Python);
`tests/office-tools.test.mts` checks the two tools are listed, searched, in
the sitemap and named in the CSP only while switched on, and that their pages
say the file is uploaded.

The suites in `tests/` run the real pipeline against generated files. For PDFs:
structure extraction, multi-column reading order, table-vs-gutter
disambiguation, baking every annotation type, the form detect/fill/flatten
round-trip, Flatten PDF (each result rendered by pdf.js and compared with
the original, pixel by pixel), protect/unlock (verified by pdf.js as an independent reader), the
OCR text layer, Word/Excel output (verified with python-docx and
openpyxl), compression (images sized by placement, lossless graphics,
text and forms kept), resizing (page sizes, where text, links,
bookmarks and notes land, turned pages, 2 and 4 to a sheet), cropping
(page boxes, turned and offset pages, what stays and goes, and that removed
content is gone from the file's streams), redaction (text split over TJ
arrays, hex strings, Type3 and CID fonts, form XObjects, comments'
appearances, invisible OCR text, pictures of text, turned pages, copies
elsewhere, metadata, bookmarks, scripts, attachments, forms and links: each
result searched stream by stream and read back with pdf.js, and the marks
drawn to check they are black), editing existing text (which path ran, the old
words gone from the page and every stream or reported as covered, the rest of
the page pixel for pixel as it was, on turned, offset and mixed-size pages,
kerned TJ arrays, subset, whole and CID fonts, Type 3 fonts, form XObjects,
invisible OCR text, shared operators, owner-password, locked, stale, broken
and 300-page files, reordered and deleted pages), pictures to
PDF (multi-page and turned TIFFs rendered by pdf.js, mixed formats, looping
and lying TIFFs turned away), text and Markdown to PDF (read back with
pdf.js: wrapping inside the margins, pages, fonts, links, tables), comparing
(moves across pages, pages added and taken out, rewrapped and hyphenated text,
300-page files, and the marked copies' annotations landing on the changed
words on turned, sideways, offset and mixed-size pages), and repair
(files broken on purpose in each way real files break, each result opened
by both pdf-lib and pdf.js), and translation (against a stand-in for the
model that drops, merges and reorders passages and obeys instructions in the
text: answers kept by id, the allowance, Cancel closing the model's stream,
and the Word files and PDFs read back for French, Russian, Hindi, Arabic,
Hebrew and Chinese). Others cover PPTX parsing, editing and rendering,
Google Slides and video links, usage limits, the watermark, billing, the AI client, the
legal pages' business details, and the analytics consent wrapper.
Every tool has also been driven through the real UI in Chromium,
with outputs checked by independent readers.

`npm run test:render` runs HTML to PDF's worker side with real Chromium
(Playwright for Python, and its Chromium): the address rules, the proxy
every connection goes through, and jobs against hostile local sites
(redirects and subresources to private and metadata addresses, DNS
rebinding, `file:` links, endless redirects, pages that never finish, huge
pages, popups, downloads, service workers, websockets, WebRTC), then the
worker end to end with grants signed by the web app's code.

`npm run test:browser` drives the Sample Finder in Chrome (`playwright-core`,
the system Chrome at `/usr/bin/google-chrome`, or `CHROME_PATH`) against
`next dev` started with a preload (`tests/fakes/samples-net.cjs`) that
answers YouTube oEmbed, MusicBrainz and TikTok from `tests/fixtures`, so it
runs offline; nothing in the app knows about it.

Bugs these caught before shipping include: column detection defeated by
shared baselines; text form fields created with no widget; table columns
mistaken for a page gutter; and every pdf.js tool failing when the CDN was
unreachable (which led to self-hosting).

## SaaS layer

- **Auth** — Supabase email/password with session middleware + route guards.
- **Dashboard** — upload / list / delete documents, with per-plan limits.
- **Billing** — Paystack, in rand (Free / Pro / Team). Monthly card
  subscriptions, or pay once for a month or a year (card, Apple Pay, Instant
  EFT, Capitec Pay, Scan to Pay). Team owners add up to 4 members by email.
  Plans are resolved from paid-until dates on every request, so expiry needs no
  scheduled job. Only the server (service role) can write plan or billing data.
- **Storage** — a private Supabase Storage bucket locked down with row-level
  security per user.

| Plan | Price | Cloud documents | Limits |
| ---- | ----- | --------------- | ------ |
| Free | R0    | 5 (with an account) | 50 MB files, batches of 10, 1 edit a day (marked), AI answers: 3 a day as a guest, 10 with an account; translation: 15,000 characters a day as a guest, 60,000 with an account |
| Pro  | R49/mo  | Unlimited | 500 MB files, batches of 200, unlimited edits, 40 AI answers a day (600 a month), 400,000 characters translated a day |
| Team | R199/mo | Unlimited | As Pro, for 5 people (owner + 4 seats) |

Paying for a year up front costs 10 months.

Prices are charged in rand. Visitors elsewhere see an estimate in their own
currency (from Vercel's `x-vercel-ip-country` header and daily exchange rates
from open.er-api.com, with a built-in fallback table) plus the rand amount
billed. Add `?currency=EUR` (any supported code) to a page to preview another
currency.

## Security

What protects user data, and how each part is tested. To report a
vulnerability, see [SECURITY.md](SECURITY.md); the public summary is at
`/security`.

- **Database (Supabase).** Row Level Security is on for every table, and every
  policy is scoped to `auth.uid()`. From the browser (the public anon key) a
  signed-in user can write only their profile's name and their own document
  rows, and visitors without a session have no privilege on any table (so
  nothing is readable even if RLS is ever switched off on one). Plans, billing columns, team seats, payment events and usage
  counters are written only by the server with the service role. Functions
  that read plans or count usage are `SECURITY DEFINER` with a fixed
  `search_path` and can't be called from the browser.
- **Tester codes.** Only a SHA-256 hash of each code is stored
  (`access_codes`), and browsers can't read it. Codes are made, listed and
  revoked only in the SQL editor; `redeem_tester_code` runs only with the
  service role, for the signed-in user, with a row lock so a code can't be
  used more times than allowed. A user can read only their own
  `tester_access` row and can't write it. Tester time never changes billing
  columns.
- **Tables, views and functions added later** (say, by hand in the SQL
  editor) are private by default: an event trigger switches RLS on for each
  new table (and refuses to switch it off), makes new views check RLS as the
  reader, and takes EXECUTE on new functions away from browsers; browsers get
  no privilege on anything new until it is granted on purpose.
  [`supabase/audit.sql`](supabase/audit.sql) lists anything a browser could
  still reach; run it in the SQL editor after any change by hand.
- **Stored files.** The `documents` bucket is private, PDFs only. A file can
  be uploaded or read only when the user owns a document row for it, a row
  can't be pointed at another file, and a row can only be deleted after its
  file, so the Free 5-document limit also limits stored files.
- **Payments.** The Paystack webhook checks an HMAC-SHA512 signature
  (constant-time) and the amount paid; events are applied once.
- **Secrets.** Only `NEXT_PUBLIC_*` values reach the browser, and the code
  may use only the names listed in `PUBLIC_VARS` (`lib/secret-scan.cjs`).
  There is no admin password anywhere. `.env*` files are git-ignored except
  `.env.example`.
- **Web pages to PDF.** The media worker opens pages for HTML to PDF in
  Chromium, and every connection the page makes (redirects, pictures,
  frames, workers, websockets) goes through the worker's own proxy, which
  resolves the name, refuses loopback, private, link-local and metadata,
  CGNAT, multicast and reserved addresses (IPv6 forms too) and connects to
  the address it checked, keeping a name's first answer for the job (no DNS
  rebinding). Only http and https; no downloads, popups, service workers,
  websockets, WebRTC or permissions; a fresh context with no cookies per
  job; caps on time, requests, bytes, pages and PDF size. Tested against
  hostile local sites (`npm run test:render`).
- **Downloads and imports.** Links users paste are fetched by the server only
  from allow-listed hosts (`video.twimg.com`, Google Slides), checked again on
  every redirect. The Sample Finder's server calls go to fixed addresses
  (YouTube's oEmbed with a rebuilt watch link, musicbrainz.org with escaped
  searches and checked ids, a TikTok post page) and never follow a redirect
  off those hosts. X download links
  are signed with their own key, expire, and are refunded only if they never
  sent the file. The allowance is checked before the server asks Google or a
  video platform, and each ask also counts against a per-minute limit. A
  download link answers at most 10 requests (`/api/media/file`, HEAD and
  Range ones included), each counted against 120 a minute, and a Slides
  import is given back only when Google itself failed (busy, 5xx or no
  answer at all), at most a day's allowance of times. So used-up or broken
  links can't make the server fetch without end.
- **Cross-site requests.** Routes that spend an allowance or change an
  account refuse requests from other sites' pages (`Sec-Fetch-Site`,
  `Origin`) and bodies that aren't JSON (`lib/cross-site.ts`), so another
  site can't use up a guest's free edit, AI answers or downloads. An email
  link with a token hash works in any browser, so `/auth/callback` only
  keeps it (an HttpOnly cookie) and signs in when Continue on
  `/auth/confirm` posts from this site, for the link that page showed
  (`lib/auth-callback.ts`): another site can't open an attacker's link in
  your browser and sign you in to the attacker's account, nor swap it in
  while your own link waits.
- **Limits per address** (guests' allowances, tester code tries) count the
  address Vercel's edge saw, or the one a declared proxy appended
  (`TRUSTED_PROXY_HOPS`), never one the visitor wrote into
  `X-Forwarded-For` (`clientIp` in `lib/usage.ts`), so a new made-up
  address per request doesn't get a new allowance.
- **Untrusted files** are parsed in the browser; PowerPoint text is sanitised
  before it is shown as HTML.
- **Headers.** HSTS, `nosniff`, `X-Frame-Options`, a Referrer and Permissions
  policy (`next.config.ts`), and on every page a Content-Security-Policy with
  a fresh nonce (`lib/csp.ts`, set in `proxy.ts`): only the site's own
  scripts run, so injected `<script>` tags, `onerror=` handlers and
  `javascript:` links don't, and `fetch` reaches only this site, Supabase,
  the media worker and (after consent) Google Analytics. It also blocks
  plugins, `<base>` changes, off-site form posts and framing.

**How it's tested** (all in CI, `.github/workflows/ci.yml`):

- `scripts/test-rls.sh` runs [`tests/rls/rls.test.sql`](tests/rls/rls.test.sql)
  on Postgres 16, against `supabase/schema.sql`, against the schema plus
  every migration, and with each migration run again on an up-to-date
  schema (so an old copy of a function or policy can't undo a fix). It plays what anyone holding the anon key could try (read
  other users' rows and files, give themselves a paid plan, forge billing
  events, call the usage functions, keep files past the plan limit, read or
  redeem tester codes themselves, or reach any tester table beyond reading
  their own `tester_access` row) and fails if any of it works. It also
  redeems one code from two connections at once and checks it is used only
  as often as allowed, and two codes for one person at once and checks both
  count. Run it locally against any Postgres you can throw away:
  `PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:rls`.
  The same tests run `supabase/audit.sql` (it must find nothing), add a
  table, a `SECURITY DEFINER` function and a view the way someone would in
  the SQL editor and check they come out private, and plant each mistake
  with the event trigger off to check the audit names it.
- Every `npm run build` (on Vercel too) first runs `scripts/check-env.mjs`,
  which stops the build if a `NEXT_PUBLIC_` variable is named like a secret
  (password, pass, pw, token, API key, JWT, database, a server-only name in
  any case) or holds one (a service_role or `sb_secret_` key, Paystack,
  OpenAI, Resend or other secret keys, a private key, a connection string
  with a password, also base64 or hex encoded, or a server-only value), and
  `scripts/check-source.mjs`, which stops it for a hard-coded credential in
  the code (`password === "…"`, `ADMIN_PASSWORD = "…"`), a key pasted into
  app code or `public/`, or a `NEXT_PUBLIC_` name not on the list.
  `next.config.ts` runs both for a plain `next build`. After the build,
  `scripts/check-bundle-secrets.mjs` fails it if a secret pattern or a
  server-only value (including passwords, `*_KEY` variables and the password
  in a connection string) is in `.next/static`, a prerendered page or
  `public/`. CI builds with fake values in every secret and runs both, then
  starts the build and checks it from outside with `scripts/check-live.mjs`.
- CI scans the repository and its whole history with gitleaks
  (`.gitleaks.toml`), and packs the browser extension, which searches what it
  ships for secrets.
- React refuses to send a server secret to the browser
  (`lib/server-secrets.ts`): every value the build checks count as secret, not
  only the known keys. Modules that read secrets import `server-only`.
- [`scripts/routes.mjs`](scripts/routes.mjs) lists every page and route as
  public or private; `npm test` fails when a new one is in neither list.
- `npm run check:live -- https://pdfwizard.xyz` checks the live site from
  outside: secrets in its scripts, headers, exposed files, every private page
  and closed route signed out, and what the public Supabase key can read or
  write (every table, function and bucket it can find). With a test account
  it also checks what any signed-up user can read. GitHub runs it weekly and
  after each push to `main` (`.github/workflows/live-check.yml`). See
  [SECURITY.md](SECURITY.md#why-the-mybroadband-style-hacks-dont-apply-here).
- `npm test` covers webhook signatures, billing replay, token signing and
  refunds, the PPTX sanitiser, URL allow-lists, the build and source checks,
  the CSP and the proxy's paths, the route list and the live checker
  (against a made-up safe and unsafe site).

The free plan's edit watermark and daily edit count are checked in the
browser, where the file is made, so they are a soft limit. Everything that
costs money or stores data (AI answers, downloads, cloud documents, team
seats, plans) is enforced on the server or in the database.

**Settings to keep:** see the [Owner-only checklist](#owner-only-checklist).

## Owner-only checklist

Only the site owner can do these; code can't. Do them once, and again when
someone leaves or a key changes.

1. Turn on two-factor sign-in (an authenticator app or passkey, not SMS) for
   Vercel, Supabase, Paystack, Cloudflare, GitHub, Google (Analytics and
   Search Console), Ollama and the domain registrar.
2. Never put a secret in a `NEXT_PUBLIC_` variable: those are copied into
   every visitor's browser. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the anon (or
   `sb_publishable_`) key, never the service_role or `sb_secret_` key. The
   build stops if one is wrong; fix the variable, don't work around it.
3. Vercel → Project → Settings → Environment Variables: mark
   `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`, `OLLAMA_API_KEY`,
   `MEDIA_WORKER_SECRET`, `MEDIA_SIGNING_SECRET` and `USAGE_HASH_SALT` as
   **Sensitive**, and give Preview deployments test keys (Paystack
   `sk_test_`). Set `MEDIA_SIGNING_SECRET` in production. Settings →
   Deployment Protection: turn on Vercel Authentication for Preview
   deployments.
4. Rotate a key the moment it's exposed (a screenshot, a chat, a commit, a
   `NEXT_PUBLIC_` variable): [SECURITY.md → If a key leaks](SECURITY.md#if-a-key-leaks)
   has the steps for each key.
5. Supabase → Authentication:
   1. Email sign-in: keep **Confirm email** on (team seats depend on it),
      and turn on **Secure password change**.
   2. Passwords: minimum length **10**, letters and digits required, and
      **leaked-password protection** on (Pro plan).
   3. Rate limits: keep the defaults or lower; at most one email per
      address every 60 seconds.
   4. URL Configuration: Site URL `https://pdfwizard.xyz`; Redirect URLs only
      `https://pdfwizard.xyz/auth/callback` (plus a preview pattern only if
      you use one).
   5. Optional: CAPTCHA protection with Cloudflare Turnstile, at the same
      time as setting `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in Vercel.
   6. Custom SMTP from your own domain, so reset emails don't come from the
      shared sender.
6. Supabase → SQL editor: run each file in `supabase/migrations/` you
   haven't run yet, once, in date order (the newest is
   `20261113000000_subscription_starts.sql`). Then run
   [`supabase/audit.sql`](supabase/audit.sql): it should return no rows. Run
   it again whenever you change anything by hand (a table, a bucket, a
   function, a policy). Security Advisor should show no "RLS disabled" table.
   Turn off `pg_graphql` if you don't use it.
7. Optional, for the Live check: create an ordinary account used only for
   it (sign up, confirm the email, never upload anything private), and add
   its email and password as the GitHub Actions secrets `CHECK_LIVE_EMAIL`
   and `CHECK_LIVE_PASSWORD`. The check then also proves that a signed-up
   user sees only their own rows and files. It can't sign in while
   Supabase's CAPTCHA is on.
8. Cloudflare (DNS): turn on **DNSSEC** and add the DS record at the
   registrar; add **CAA** records for the certificate authorities Vercel
   uses (`letsencrypt.org`) plus `iodef` `mailto:security@pdfwizard.xyz`;
   SPF, DKIM and DMARC for the mail domain; registrar lock on.
9. Paystack: webhook URL `https://pdfwizard.xyz/api/billing/webhook` only.
   Webhooks are verified with `PAYSTACK_SECRET_KEY`, so a new secret key goes
   into Vercel straight away. Two-factor on, least-privilege team roles,
   test keys outside production.
10. GitHub (the repository is public): Settings → Code security: secret
    scanning with push protection, Dependabot alerts and security updates,
    private vulnerability reporting. Protect `main`: require a pull request
    and the CI checks `app`, `secrets`, `build`, `database` and
    `media-worker`; block force pushes. Actions → General: read-only workflow permissions, and
    approval for workflows from forks. Add the variable `SITE_URL` =
    `https://pdfwizard.xyz` for the Live check workflow.
11. Media worker host: `MEDIA_ALLOWED_ORIGINS=https://pdfwizard.xyz`, and
    `YTDLP_PROXY` credentials only in that host's secret store. Before
    turning on HTML to PDF, run the worker where it can't reach anything
    private (no cloud metadata service, no internal network), and check
    `/api/media/health` says whether Chromium's sandbox is on
    ([media-worker/README.md](media-worker/README.md#html-to-pdf-web-pages-html-files-pasted-html)).
12. After changing any of these: `npm run check:live -- https://pdfwizard.xyz`.

---

## Architecture

```
pdf-wizard/
├── app/
│   ├── page.tsx                 ← Marketing landing (wizard themed)
│   ├── tools/                   ← Tools hub + dynamic /tools/[slug] pages
│   ├── pricing/                 ← Public pricing
│   ├── privacy, terms, refunds, contact/ ← Legal pages (details from env)
│   ├── security/                ← Public security summary
│   ├── login, signup, auth/     ← Auth screens + callbacks
│   ├── forgot-password/         ← Asks for a password reset link
│   ├── dashboard/               ← Document library (auth-gated)
│   ├── editor/[id]/             ← The PDF editor
│   ├── settings/billing/        ← Plan, renewal, team seats
│   ├── settings/password/       ← New password (reset links land here)
│   ├── redeem/                  ← Tester links land here (/redeem#CODE)
│   ├── api/billing/             ← checkout · verify · webhook · manage · team
│   ├── api/access/redeem/       ← Redeems a tester code (server checks)
│   ├── sitemap.ts, robots.ts    ← SEO
│   └── icon.svg, error, loading ← Polish
├── components/
│   ├── tools/
│   │   ├── ToolWorkbench.tsx     ← Dropzone + options + run + download
│   │   ├── EditorLaunch.tsx      ← Uploads a PDF into the editor
│   │   ├── PageOrganizer.tsx     ← Page grid for Organize PDF, Delete and Extract pages
│   │   ├── CropTool.tsx          ← Crop PDF: page preview, the box, margins, trim
│   │   ├── CompareTool.tsx       ← Compare PDFs: two files, the changes, side by side and overlay
│   │   ├── TranslateTool.tsx     ← Translate PDF: languages, what's sent, progress, the files
│   │   ├── WebToPdf.tsx          ← HTML to PDF: address, file or pasted HTML, settings, the worker's job
│   │   └── processors.ts         ← Per-tool fields + run() wiring
│   ├── editor/
│   │   ├── PdfEditor.tsx         ← Shell: toolbar, sidebar, save/export, shortcuts
│   │   ├── Toolbar.tsx           ← Tool palette + contextual style controls
│   │   ├── PageView.tsx          ← Page render, creation gestures, form overlays
│   │   ├── AnnotationView.tsx    ← Draw/drag/resize a single annotation
│   │   ├── ThumbnailSidebar.tsx  ← Page navigator, drag-reorder, page ops
│   │   ├── PropertiesPanel.tsx   ← Contextual property editor
│   │   └── SignaturePad.tsx      ← Draw-your-signature modal
│   ├── ToolGrid.tsx, WizardLogo.tsx
│   └── ui/                       ← Button, Input, Dialog, Toast
├── lib/
│   ├── pdf/parse.ts              ← Layout-aware parsing + serializers
│   ├── pdf/toolkit.ts            ← All tool processing (merge/split/compress/…)
│   ├── pdf/compress/             ← Compression: image sizing, re-encoding, clean-up
│   ├── pdf/bake.ts               ← Flatten annotations, links, form fields
│   ├── pdf/forms.ts              ← Detect / fill / flatten existing AcroForms
│   ├── pdf/operations.ts         ← pdf-lib page ops
│   ├── pdf/pages/                ← Page tools: the page list (plan.ts) and the save, in a worker
│   ├── pdf/crop/                 ← Crop PDF: the box, page boxes, pictures, white-margin trim
│   ├── pdf/compare/              ← Compare PDFs: words, diff, page pairs, pixels, report, marked copies
│   ├── pdf/redact/               ← Redact PDF: marks, presets, pictures, clean-up, the search and check after
│   ├── pdf/translate/            ← Translate PDF: the Word file and the PDF, in a worker
│   ├── translate/                ← Translate PDF: languages, passages, requests to the route
│   ├── web-pdf.ts, web-pdf-route.ts ← HTML to PDF: options, address checks, the grant
│   ├── ai/                       ← Ollama client, chat and translation prompts and checks
│   ├── pdf/images-to-pdf/        ← Pictures to PDF: formats, browser and TIFF decoding, in a worker
│   ├── pdf/text-to-pdf/          ← Text and Markdown to PDF: fonts, layout, in a worker
│   ├── pdf/render.ts, worker.ts  ← pdf.js render helper + worker config
│   ├── editor/                   ← Annotation model, history, factory
│   ├── tools.tsx                 ← Tool registry (metadata + icons)
│   ├── samples/                  ← Sample Finder: title parsing, catalog, MusicBrainz, cache
│   ├── supabase/                 ← browser · server · middleware clients
│   ├── billing.ts                ← Plan resolution + Paystack event handling
│   ├── paystack.ts, plans.ts, types.ts
├── tests/                        ← End-to-end pipeline tests (npm test)
└── supabase/schema.sql           ← Tables, RLS, storage bucket + policies
    supabase/migrations/          ← Upgrades for existing projects
    tests/rls/                    ← RLS / privilege tests (scripts/test-rls.sh)
```

---

## Quick start

```bash
npm install
```

1. **Supabase** — create a project, run [`supabase/schema.sql`](supabase/schema.sql)
   in the SQL editor (creates tables, RLS, the private `documents` bucket and
   the usage counters), and enable Email auth. Under Authentication → URL
   Configuration set the Site URL to your domain and add
   `https://<your-domain>/**` to the Redirect URLs (sign-up and password
   reset emails link to `/auth/callback`). Under Authentication → Email
   Templates → Reset Password, make the link
   `<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Reset password</a>`
   (the app's address already has a `?`), so a reset link works in any
   browser, a phone's mail app too. The default link only works in the
   browser that asked for it. A link like this opens a short page with a
   Continue button first (`/auth/confirm`), so a link someone else sends
   can't sign you in to their account; nothing in the template changes for
   that.
2. **Paystack** — see [Billing setup](#billing-setup-paystack).
3. **Env** — copy `.env.example` to `.env.local` and fill in the values.
4. **Run** — `npm run dev`, then open <http://localhost:3000>.

---

## Tech stack

Next.js 16 (App Router) · React 19.3 · TypeScript · Tailwind CSS · Supabase
(Auth + Postgres + Storage) · Paystack · Ollama · pdf-lib · pdf.js · Tesseract.js ·
ffmpeg.wasm · mediabunny · JSZip · Radix UI · lucide-react · yt-dlp (media worker)

## Production notes

- Security headers (HSTS, nosniff, frame options, permissions policy) are set
  in `next.config.ts`, and the pages' nonce-based CSP in `proxy.ts`. See
  [Security](#security).
- Tool pages are statically generated with per-page metadata; `sitemap.xml` and
  `robots.txt` are generated automatically.
- **Roadmap:** saved signatures, version history, shared team workspaces;
  Word → PDF, which needs a server-side renderer such as LibreOffice.

## Deploy to Vercel

**The app deploys and runs with zero environment variables.** Import the repo
into Vercel and hit Deploy — the marketing site and every browser-only tool
work immediately, because they never touch a backend.

Accounts, the cloud document library, the editor, and billing are gated behind
configuration and degrade cleanly when it is absent: protected routes redirect
to `/login`, which explains what is missing, and the billing API returns `503`
rather than crashing.

To enable the full product, add these in **Project → Settings → Environment
Variables** and redeploy:

| Variable | Needed for |
| -------- | ---------- |
| `NEXT_PUBLIC_SUPABASE_URL` | accounts, dashboard, editor |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | accounts, dashboard, editor. The **anon** (or `sb_publishable_`) key: the build stops if this is the service_role or `sb_secret_` key |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Optional. Cloudflare Turnstile on log in, sign-up and Forgot password. Set it together with Supabase's CAPTCHA protection (see [Owner-only checklist](#owner-only-checklist)) |
| `SUPABASE_SERVICE_ROLE_KEY` | billing (records payments, plans, team seats) and usage counters shared by every server instance |
| `PAYSTACK_SECRET_KEY` | checkout, subscription management, webhook signatures |
| `PAYSTACK_PLAN_PRO`, `PAYSTACK_PLAN_TEAM` | monthly subscriptions (`PLN_…` codes) |
| `OLLAMA_API_KEY` | AI Assistant (Chat with PDF) on Ollama Cloud. Create one at ollama.com/settings/keys |
| `OLLAMA_HOST` | Optional. Your own Ollama server (HTTPS, behind a proxy that checks the key). Default `https://ollama.com` |
| `OLLAMA_MODEL` | Optional. Default `deepseek-v4.1-flash` on Ollama Cloud, `deepseek-v4.1-flash:cloud` on your own server |
| `OLLAMA_THINK` | Optional. Reasoning level: `low` (default for DeepSeek V4.1 Flash), `medium`, `high`, `max`, `false` |
| `OLLAMA_CONTEXT_TOKENS` | Optional. Context window to ask the model for (`num_ctx`, at least 8192). Unset: the model's default |
| `MEDIA_WORKER_URL`, `MEDIA_WORKER_SECRET` | YouTube downloads, Word and Excel to PDF, and HTML to PDF — see [`media-worker/README.md`](media-worker/README.md) |
| `NEXT_PUBLIC_ENABLE_HTML_TO_PDF` | Optional. `1` shows HTML to PDF (hidden by default) once the media worker is redeployed with Chromium; set it with `MEDIA_WORKER_URL` and `MEDIA_WORKER_SECRET`, then redeploy |
| `WEB_PDF_GLOBAL_DAILY_LIMIT` | Optional. Web pages saved as PDF per day across the whole site (default 3000) |
| `MEDIA_SIGNING_SECRET` | Recommended. Signs and encrypts X, TikTok and Instagram download links (with keys derived from it). Falls back to `MEDIA_WORKER_SECRET`, then the service-role key; with none of them, links only work on the server instance that made them |
| `USAGE_HASH_SALT` | Recommended. Secret salt for hashing guest IPs in usage counters. Falls back to one derived from `SUPABASE_SERVICE_ROLE_KEY` or `MEDIA_SIGNING_SECRET` |
| `TRUSTED_PROXY_HOPS` | Only when hosted outside Vercel: how many proxies in front of the app append to `X-Forwarded-For` (`1` for one nginx or load balancer). The visitor's address is that many entries from the right; anything further left is ignored. Unset: forwarding headers aren't trusted and every guest shares one allowance. Ignored on Vercel |
| `AI_GUEST_DAILY_LIMIT` | Optional. Guest AI answers per day (default 3; `0` requires an account) |
| `AI_LIMIT_<TIER>_DAY`, `AI_LIMIT_<TIER>_MONTH` | Optional. AI answers per day / month for `GUEST`, `FREE`, `PRO`, `TEAM` (defaults 3/10/40/40 a day; Pro 600 a month; month `0` = no cap) |
| `AI_LIMIT_<TIER>_UNANSWERED` | Optional. Unanswered AI questions a day that are given back (default: the tier's daily allowance; `0` = none) |
| `AI_BURST_PER_MINUTE` | Optional. AI requests per minute per user or guest (default 6) |
| `AI_GLOBAL_DAILY_LIMIT` | Optional. AI answers per day across the whole site (default 3000) |
| `OLLAMA_TRANSLATE_MODEL` | Optional. The model Translate PDF uses, on the same host with the same key. Default: `OLLAMA_MODEL`'s |
| `TRANSLATE_LIMIT_<TIER>_DAY` | Optional. Characters translated per day for `GUEST`, `FREE`, `PRO`, `TEAM` (defaults 15000/60000/400000/400000; guest `0` requires an account) |
| `TRANSLATE_LIMIT_<TIER>_UNANSWERED` | Optional. Translation requests a day whose undelivered part is given back (default 10) |
| `TRANSLATE_BURST_PER_MINUTE` | Optional. Translation requests per minute per user or guest (default 30) |
| `TRANSLATE_GLOBAL_DAILY_LIMIT` | Optional. Translation requests per day across the whole site, each up to 3,000 characters (default 3000) |
| `NEXT_PUBLIC_LEGAL_NAME` | Legal pages: the person or company responsible (POPIA "responsible party", shown as the Information Officer) |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Legal and contact pages: where privacy, refund and copyright requests go |
| `NEXT_PUBLIC_BUSINESS_ADDRESS` | Legal and contact pages: physical address (Paystack and POPIA expect one) |
| `NEXT_PUBLIC_CONTACT_PHONE` | Optional. Contact page phone number |
| `NEXT_PUBLIC_SECURITY_EMAIL` | Optional. Where security reports go, on `/security` and in `/.well-known/security.txt` (default `security@pdfwizard.xyz`) |
| `NEXT_PUBLIC_BUSINESS_NAME` | Optional. Trading name on the legal pages and footer (default `PDF Wizard`) |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Optional. Google Analytics 4 (`G-…`). Unset: no analytics, no cookie banner. Set it for Production only |
| `NEXT_PUBLIC_ENABLE_OFFICE_CONVERT` | Optional. `1` shows Word to PDF and Excel to PDF and lets their pages upload to the media worker (hidden by default); needs `MEDIA_WORKER_URL`, `MEDIA_WORKER_SECRET` and the worker rebuilt with LibreOffice. Redeploy after changing |
| `NEXT_PUBLIC_ENABLE_YOUTUBE` | Optional. `1` brings back the YouTube tools (they are paused and hidden by default); needs the media worker |
| `MUSICBRAINZ_CONTACT` | Optional. The https page MusicBrainz is told to contact about the Sample Finder's requests (its User-Agent). Default: the site's `/contact` page. Never a personal email |
| `SAMPLES_MB_DISABLED` | Optional. `1` makes the Sample Finder answer from its hand-checked list only, sending nothing to MusicBrainz |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | Optional. Search Console HTML-tag token, if you don't verify by DNS |
| `NEXT_PUBLIC_BING_SITE_VERIFICATION` | Optional. Bing Webmaster Tools `msvalidate.01` token |

Optional:

- `NEXT_PUBLIC_SITE_URL` — canonical URL for metadata, `sitemap.xml`, and
  the Paystack return URL. Falls back to Vercel's deployment URL automatically, so it
  is only needed for a custom domain.
- `NEXT_PUBLIC_PDFJS_WORKER_SRC` — self-hosted pdf.js worker path for
  CSP-restricted deployments.

Then run [`supabase/schema.sql`](supabase/schema.sql) in your Supabase project
(on an existing project, run the files in [`supabase/migrations/`](supabase/migrations)
you haven't run yet, once each, in date order)
and set up Paystack as below.

## Legal pages, analytics and search

`/privacy`, `/terms`, `/refunds` and `/contact` are written for this product
and read the business details from the `NEXT_PUBLIC_*` variables above
(`lib/business.ts`). In development a missing detail shows as a yellow
placeholder; in production it is simply left out, so set them before
applying to Paystack. Change `LEGAL_UPDATED` in `lib/business.ts` whenever you
change a policy.

**Before relying on them, have a South African attorney review the pages.**
They are a careful starting point, not legal advice. Check in particular:

- the promises they make on your behalf, and change any you don't want: reply
  within 2 working days; delete accounts within 30 days of closing; a full
  refund within 7 days of a first payment if no paid feature was used;
  refunds sent within 5 working days; 30 days' notice of price changes;
  liability capped at 12 months' fees;
- the Information Regulator's contact details on `/privacy`
  (inforegulator.org.za, POPIAComplaints@inforegulator.org.za);
- that you have accepted each provider's data processing terms (Vercel,
  Supabase, Paystack, Ollama, Google, the media worker host, your email
  sender): the privacy policy relies on them for transfers outside South
  Africa;
- the ECT Act asks for your legal status too; while unregistered you can set
  `NEXT_PUBLIC_LEGAL_NAME="Your Name (sole proprietor)"`.

**Google Analytics 4.** Set `NEXT_PUBLIC_GA_MEASUREMENT_ID` (Production
only) and redeploy. Consent Mode v2 defaults (all denied) are set in `<head>`;
a small banner asks, and `gtag.js` loads only after **Accept** (Consent Mode
"basic"). The choice is kept in the browser; **Cookie settings** in the footer
reopens the banner, and declining later deletes the `_ga` cookies. In GA:

- keep Enhanced measurement → Page views → **Page changes based on browser
  history events** on (the default): client-side navigations are counted by
  it, and the app sends no page views of its own, so each is counted once;
- set Data retention to 14 months, leave Google signals off, add
  `paystack.com` and `checkout.paystack.com` to *List unwanted referrals*, and
  mark `sign_up` and `purchase` as key events.

Events: `sign_up`, `begin_checkout` and `purchase` (ZAR; `transaction_id` is
the Paystack reference, sent once per reference from the return page), and
`tool_used` (`tool`) and `file_download` (`file_extension`, `tool`; never the
file name). Nothing is sent without consent. Renewals happen without the
visitor on the site, so they are not reported (that would need the GA
Measurement Protocol from the webhook).

**Search Console.** Prefer a Domain property verified by a DNS TXT record.
For a URL-prefix property, set `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` to the
token from the HTML-tag method. Then submit `sitemap.xml` (it uses
`NEXT_PUBLIC_SITE_URL`, so set that to the custom domain first). Bing can
import the site from Search Console, or use
`NEXT_PUBLIC_BING_SITE_VERIFICATION`.

## Billing setup (Paystack)

Paystack accounts in South Africa charge in ZAR only.

1. **Plans** — Paystack → Products → Plans → Create plan:
   *Pro*, R49, interval Monthly; *Team*, R199, interval Monthly. Copy each
   plan code (`PLN_…`) into `PAYSTACK_PLAN_PRO` and `PAYSTACK_PLAN_TEAM`.
2. **Keys** — Settings → API Keys & Webhooks: copy the secret key into
   `PAYSTACK_SECRET_KEY` (test key `sk_test_…` first, live key when you go
   live). No public key is needed: checkout runs on Paystack's hosted page.
3. **Webhook** — on the same page set the Webhook URL to
   `https://<your-domain>/api/billing/webhook` (test and live each have one).
   Requests are verified with the secret key; there is no separate webhook secret.
4. **Channels** — Settings → Preferences → Payment channels: enable Card, plus
   any of Apple Pay, EFT, Capitec Pay and Scan to Pay (QR) for once-off
   payments. Subscriptions are card-only.

The webhook handles `charge.success`, `subscription.create`,
`subscription.not_renew`, `subscription.disable`, `invoice.payment_failed` and
`invoice.update`. Each delivery is applied once (`billing_events` records them).
Only payments started by this site's checkout change a plan: checkout signs
its metadata with a key derived from the secret key (see
[SECURITY.md](SECURITY.md#payments)). A `subscription.create` that arrives
before its first charge, or a cancel or invoice event that arrives before
its `subscription.create`, gets a 503, so Paystack sends it again. A
subscription's code is only stored from a `subscription.create` paid with
the same card as its signed first charge: on a project set up before this,
run
[`supabase/migrations/20261113000000_subscription_starts.sql`](supabase/migrations/20261113000000_subscription_starts.sql)
before deploying (without it a new subscription's first charge isn't applied
and Paystack keeps sending it).

A checkout started before this was deployed, or before a change of
`PAYSTACK_SECRET_KEY`, isn't signed with the key in use when it is paid, so
its payment isn't applied on its own. Deploy and change keys when few people
are paying, then look in the logs from around then for `paystack event
ignored charge.success`, find each payment in Paystack and apply it by hand.
Renewals still apply while a subscription waits for its create, if paid with
the card of its first charge. A create logged as `not paid with its first
charge's card` whose card (last four digits in Paystack) is the one the
account's first payment used is the account's own: store its code by hand.

## Tester access (free Pro or Team for testers)

Give chosen testers Pro or Team for free, for a limited time, with a code or
a link. Codes are made only in the Supabase SQL editor: there is no admin
page, and no code or secret is in the site.

On a project set up before this, run
[`supabase/migrations/20261019000000_tester_access.sql`](supabase/migrations/20261019000000_tester_access.sql)
once in the SQL editor, after the migrations before it (`supabase/schema.sql`
already includes it), then [`supabase/audit.sql`](supabase/audit.sql): it
should still return no rows. Browsers get one thing from it on purpose: a
signed-in user may read their own `tester_access` row.

**Make a code** (Supabase → SQL editor → New query):

```sql
-- Pro for 30 days, for one person:
select * from create_tester_code(note => 'Thabo');

-- Team for 14 days, for up to 3 people:
select * from create_tester_code(plan => 'team', days => 14, max_uses => 3, note => 'Design studio');
```

The result shows the code (`K7QM-8XRP-2D4N-W9HC`) and its link
(`https://pdfwizard.xyz/redeem#K7QM-8XRP-2D4N-W9HC`). Copy them then: only a
hash is kept, so they can't be shown again. Options: `plan` (`'pro'` or
`'team'`), `days` (tester time each person gets, 1 to 365), `max_uses`
(how many people), `note` (who it's for), `code_valid_days` (how long the
code can be used, default 30) and `site_url` (the link's address, default
`https://pdfwizard.xyz`).

**See codes and who used them:**

```sql
select * from list_tester_codes();
select u.email, t.team_until, t.pro_until from tester_access t join auth.users u on u.id = t.user_id
 order by greatest(t.team_until, t.pro_until) desc;
```

**Revoke a code** (by the `ref` from the list, or by the code):

```sql
select * from revoke_tester_code('3f2a9c1b');
-- and end the tester time of its plan (Pro or Team) for everyone who used it:
select * from revoke_tester_code('3f2a9c1b', end_access => true);
```

**How testers use it.** They open the link, sign up or log in (they come
back to the same page), and press **Activate Pro**. Or, signed in: Billing →
**Have a tester code?**, and paste the code. Pro (or Team) works everywhere
at once, Billing and the header show "Pro (tester) until 17 Nov 2026", and it
ends by itself on that date, back to Free or to their paid plan. Nothing is
charged and there is nothing to cancel. Buying a plan meanwhile works as
usual, and paid time starts when they pay. A Team tester can give seats to
4 people while it lasts.

Each code adds its own plan's days. Team time runs first and Pro time after
it, so a Pro code never adds Team time and a Team code doesn't use up Pro
days. Tester time starts after time they already have of that plan or
higher (earlier tester time, a prepaid term, or a subscription that won't
renew), and the page says from when. If their plan renews, or they have a
seat in someone's Team (for a Pro code), the code would add nothing: it is
refused, says so, and isn't used.

Each code works once per person. The code sits after the `#`, which browsers
never send to a server, and the page takes it out of the address bar at once,
so it stays out of logs, referrers and analytics. Codes are checked only on
the server, 20 tries a day per account and 50 per network address. Share a
link privately: anyone who has it can use it until `max_uses` is reached.

## Third-party licences

The open-source libraries the app ships to browsers, with their licences and
sources, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
