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
work with or without an account.

| Tool | What it does |
| ---- | ------------ |
| **Merge PDF** | Combine multiple PDFs into one (drag to reorder). |
| **Split PDF** | Extract page ranges, or split every page into its own file. |
| **Rotate PDF** | Rotate all pages 90° / 180° / 270°. |
| **Compress PDF** | Shrink file size by recompressing pages (never returns a bigger file). |
| **PDF → JPG** | Render each page to a JPG/PNG, downloaded as a zip. |
| **JPG → PDF** | Combine images into a PDF (fit-to-image or A4). |
| **PDF → Word** | Editable DOCX with real heading styles, lists, and tables. |
| **PDF → Excel** | Every detected table as its own sheet; numbers stay summable. |
| **PDF → Text** | Extract text in true reading order (multi-column aware). |
| **PDF → Markdown** | Layout-aware conversion keeping headings, lists & tables. |
| **Extract Tables** | Detect tables by column structure, export each as CSV. |
| **PDF → RAG Chunks** | Retrieval-sized JSON chunks with heading breadcrumbs. |
| **OCR PDF** | Make scans searchable (invisible text layer) or extract text. 7 languages, on-device. |
| **AI Assistant** | Summarize a PDF and ask questions; answers cite pages. *Guests get 3 answers/day; needs an API key.* |
| **Protect PDF** | Encrypt with a password; choose print/copy permissions. |
| **Unlock PDF** | Remove a password you know. |
| **PDF → PPTX** | Each page becomes a picture slide (the text isn't editable). |
| **PPTX → PDF** | Renders PowerPoint slides in the browser as image-based pages with a selectable text layer; hidden slides are skipped and the file is never uploaded. |
| **Edit PPTX** | Edit slide text, reorder, duplicate or delete slides, then save as PPTX or PDF. In the browser. |
| **Google Slides → PDF / PPTX** | Download a deck from its link. The deck must be shared as "Anyone with the link"; private decks get a message saying so. PPTX can go straight into Edit PPTX. |
| **YouTube to MP4** | 360p–720p free; **1080p with Pro**. Separate 720p and 1080p pages. *Needs the media worker.* |
| **YouTube to MP3** | Audio only, extracted by the worker's ffmpeg. *Needs the media worker.* |
| **YouTube Playlist** | Lists a playlist (up to 200), downloads the picked videos as MP4 or MP3 two at a time (each counts toward the daily quota), and exports the list as CSV or TXT. *Needs the media worker.* |
| **X (Twitter) to MP4 / MP3** | Save a post's video, or just its audio. Works with no extra setup. |
| **Page Numbers** | Insert page numbers with position & format options. |
| **Watermark** | Stamp diagonal text across every page. |
| **Edit PDF** | Full editor: whiteout, shapes, notes, links, form fields. |
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

| Tier | Files | Batch | Edits/day | AI answers | Cloud library |
| ---- | ----- | ----- | --------- | ---------- | ------------- |
| Guest (no account) | 50 MB | 10 | 1, marked | 3 a day | — (saved on device) |
| Free account | 50 MB | 10 | 1, marked | 10 a day | 5 documents |
| Pro | 500 MB | 200 | Unlimited | 40 a day, 600 a month | Unlimited |
| Team | 500 MB | 200 | Unlimited | 40 a day per member | Unlimited |

Limits live in `lib/limits.ts` and `lib/usage.ts`; the upsell UI in
`components/upsell/`. File and batch limits are enforced in the browser (tools
run there). Daily allowances (AI answers, edits, video downloads, Slides
imports) are counted on the server in Supabase (`usage_counters`, through
functions only the service role can call), keyed by user id or, for guests,
by a salted SHA-256 of their IP (raw IPs are never stored). Without
`SUPABASE_SERVICE_ROLE_KEY` they are counted in server memory instead (fine for
local dev, not for Vercel). AI also has a burst limit (6 a minute) and a
site-wide daily cap; an answer that never arrives is given back. An edit is
one distinct document saved or downloaded per UTC day; the same unchanged
document again is free.

## Video & Audio downloads

**X (Twitter)** works on the web app alone. `/api/media/info` resolves the post
through X's public embed endpoint (with FxTwitter and vxTwitter as fallbacks),
`/api/media/file` streams the MP4 from `video.twimg.com` with a proper filename,
and MP3 is converted in the browser with ffmpeg.wasm (self-hosted under
`/vendor`). These endpoints are unofficial and can change without notice.

**YouTube** needs a separate container ([`media-worker/`](media-worker/README.md):
yt-dlp + Deno + ffmpeg), because YouTube's HD tracks must be merged and its
stream URLs only work from the IP that requested them.

For both, the web app checks the plan (1080p is Pro) and the daily quota
(guest 5, free account 10, Pro 200), then signs a short-lived token for exactly
one download. Open `/api/media/health` after deploying to see what's missing.
Read the worker README's **Things to know before launch** section: YouTube
blocks cloud IPs, and there are legal points too.

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
shortcuts, and toasts. Structural operations bake current annotations first,
then transform the bytes and re-render.

## Tests

```bash
npm test
```

The suites in `tests/` run the real pipeline against generated files. For PDFs:
structure extraction, multi-column reading order, table-vs-gutter
disambiguation, baking every annotation type, the form detect/fill/flatten
round-trip, protect/unlock (verified by pdf.js as an independent reader), the
OCR text layer, and Word/Excel output (verified with python-docx and
openpyxl). Others cover PPTX parsing, editing and rendering, Google Slides
and video links, usage limits, the watermark, billing, the AI client, the
legal pages' business details, and the analytics consent wrapper.
Every tool has also been driven through the real UI in Chromium,
with outputs checked by independent readers.

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
| Free | R0    | 5 (with an account) | 50 MB files, batches of 10, 1 edit a day (marked), AI answers: 3 a day as a guest, 10 with an account |
| Pro  | R49/mo  | Unlimited | 500 MB files, batches of 200, unlimited edits, 40 AI answers a day (600 a month) |
| Team | R199/mo | Unlimited | As Pro, for 5 people (owner + 4 seats) |

Paying for a year up front costs 10 months.

Prices are charged in rand. Visitors elsewhere see an estimate in their own
currency (from Vercel's `x-vercel-ip-country` header and daily exchange rates
from open.er-api.com, with a built-in fallback table) plus the rand amount
billed. Add `?currency=EUR` (any supported code) to a page to preview another
currency.

---

## Architecture

```
pdf-wizard/
├── app/
│   ├── page.tsx                 ← Marketing landing (wizard themed)
│   ├── tools/                   ← Tools hub + dynamic /tools/[slug] pages
│   ├── pricing/                 ← Public pricing
│   ├── privacy, terms, refunds, contact/ ← Legal pages (details from env)
│   ├── login, signup, auth/     ← Auth screens + callbacks
│   ├── dashboard/               ← Document library (auth-gated)
│   ├── editor/[id]/             ← The PDF editor
│   ├── settings/billing/        ← Plan, renewal, team seats
│   ├── api/billing/             ← checkout · verify · webhook · manage · team
│   ├── sitemap.ts, robots.ts    ← SEO
│   └── icon.svg, error, loading ← Polish
├── components/
│   ├── tools/
│   │   ├── ToolWorkbench.tsx     ← Dropzone + options + run + download
│   │   ├── EditorLaunch.tsx      ← Uploads a PDF into the editor
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
│   ├── pdf/bake.ts               ← Flatten annotations, links, form fields
│   ├── pdf/forms.ts              ← Detect / fill / flatten existing AcroForms
│   ├── pdf/operations.ts         ← pdf-lib page ops
│   ├── pdf/render.ts, worker.ts  ← pdf.js render helper + worker config
│   ├── editor/                   ← Annotation model, history, factory
│   ├── tools.tsx                 ← Tool registry (metadata + icons)
│   ├── supabase/                 ← browser · server · middleware clients
│   ├── billing.ts                ← Plan resolution + Paystack event handling
│   ├── paystack.ts, plans.ts, types.ts
├── tests/                        ← End-to-end pipeline tests (npm test)
└── supabase/schema.sql           ← Tables, RLS, storage bucket + policies
    supabase/migrations/          ← Upgrades for existing projects
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
   `https://<your-domain>/**` to the Redirect URLs (sign-up emails link to
   `/auth/callback`).
2. **Paystack** — see [Billing setup](#billing-setup-paystack).
3. **Env** — copy `.env.example` to `.env.local` and fill in the values.
4. **Run** — `npm run dev`, then open <http://localhost:3000>.

---

## Tech stack

Next.js 16 (App Router) · React 19.3 · TypeScript · Tailwind CSS · Supabase
(Auth + Postgres + Storage) · Paystack · Ollama · pdf-lib · pdf.js · Tesseract.js ·
ffmpeg.wasm · JSZip · Radix UI · lucide-react · yt-dlp (media worker)

## Production notes

- Security headers (HSTS, nosniff, frame options, permissions policy) are set in
  `next.config.ts`.
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
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | accounts, dashboard, editor |
| `SUPABASE_SERVICE_ROLE_KEY` | billing (records payments, plans, team seats) and usage counters shared by every server instance |
| `PAYSTACK_SECRET_KEY` | checkout, subscription management, webhook signatures |
| `PAYSTACK_PLAN_PRO`, `PAYSTACK_PLAN_TEAM` | monthly subscriptions (`PLN_…` codes) |
| `OLLAMA_API_KEY` | AI Assistant (Chat with PDF) on Ollama Cloud. Create one at ollama.com/settings/keys |
| `OLLAMA_HOST` | Optional. Your own Ollama server (HTTPS, behind a proxy that checks the key). Default `https://ollama.com` |
| `OLLAMA_MODEL` | Optional. Default `deepseek-v4.1-flash` on Ollama Cloud, `deepseek-v4.1-flash:cloud` on your own server |
| `OLLAMA_THINK` | Optional. Reasoning level: `low` (default for DeepSeek V4.1 Flash), `medium`, `high`, `max`, `false` |
| `OLLAMA_CONTEXT_TOKENS` | Optional. Context window to ask the model for (`num_ctx`, at least 8192). Unset: the model's default |
| `MEDIA_WORKER_URL`, `MEDIA_WORKER_SECRET` | YouTube downloads — see [`media-worker/README.md`](media-worker/README.md) |
| `MEDIA_SIGNING_SECRET` | Signs X download links. Falls back to `MEDIA_WORKER_SECRET`; set one of them in production |
| `USAGE_HASH_SALT` | Recommended. Secret salt for hashing guest IPs in usage counters. Falls back to one derived from `SUPABASE_SERVICE_ROLE_KEY` or `MEDIA_SIGNING_SECRET` |
| `AI_GUEST_DAILY_LIMIT` | Optional. Guest AI answers per day (default 3; `0` requires an account) |
| `AI_LIMIT_<TIER>_DAY`, `AI_LIMIT_<TIER>_MONTH` | Optional. AI answers per day / month for `GUEST`, `FREE`, `PRO`, `TEAM` (defaults 3/10/40/40 a day; Pro 600 a month; month `0` = no cap) |
| `AI_BURST_PER_MINUTE` | Optional. AI requests per minute per user or guest (default 6) |
| `AI_GLOBAL_DAILY_LIMIT` | Optional. AI answers per day across the whole site (default 3000) |
| `NEXT_PUBLIC_LEGAL_NAME` | Legal pages: the person or company responsible (POPIA "responsible party", shown as the Information Officer) |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Legal and contact pages: where privacy, refund and copyright requests go |
| `NEXT_PUBLIC_BUSINESS_ADDRESS` | Legal and contact pages: physical address (Paystack and POPIA expect one) |
| `NEXT_PUBLIC_CONTACT_PHONE` | Optional. Contact page phone number |
| `NEXT_PUBLIC_BUSINESS_NAME` | Optional. Trading name on the legal pages and footer (default `PDF Wizard`) |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Optional. Google Analytics 4 (`G-…`). Unset: no analytics, no cookie banner. Set it for Production only |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | Optional. Search Console HTML-tag token, if you don't verify by DNS |
| `NEXT_PUBLIC_BING_SITE_VERIFICATION` | Optional. Bing Webmaster Tools `msvalidate.01` token |

Optional:

- `NEXT_PUBLIC_SITE_URL` — canonical URL for metadata, `sitemap.xml`, and
  the Paystack return URL. Falls back to Vercel's deployment URL automatically, so it
  is only needed for a custom domain.
- `NEXT_PUBLIC_PDFJS_WORKER_SRC` — self-hosted pdf.js worker path for
  CSP-restricted deployments.

Then run [`supabase/schema.sql`](supabase/schema.sql) in your Supabase project
(on an existing project, run the files in [`supabase/migrations/`](supabase/migrations))
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
