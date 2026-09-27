# PDF Wizard 🧙 — A PDF Editor SaaS

> Cast spells on your PDFs. Merge, split, compress, convert, edit, and sign
> documents right in your browser — free, fast, and private.

**PDF Wizard** is a full-stack PDF toolkit + editor SaaS built with Next.js 16,
Supabase, Stripe, and a fully client-side PDF engine (`pdf-lib` + `pdf.js`). It
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

1. **No account wall, anywhere a first task happens.** The homepage hero is a
   drop zone: drop a file, pick what to do ("Edit", "Compress", "PDF to
   Word"…), and the file is handed to that tool without a second upload.
2. **The full editor works as a guest.** Edit PDF and Fill & Sign open
   instantly in an on-device editor (`/edit/[id]`, IndexedDB) that survives a
   reload and exports with **no watermark**.
3. **Keep going.** Every success screen offers the next step for the same file
   (compress → protect, OCR → Word…) — no download/re-upload round trip.
4. **Upsell only after value**, always dismissible, never blocking:
   a quiet card on success screens; one friendly nudge after a guest's third
   task of the day (at most once a day); an upgrade prompt when a real limit is
   reached (file size, batch size, AI answers); and a cloud-save offer after a
   guest saves their first edit.

| Tier | Files | Batch | AI answers/day | Cloud library |
| ---- | ----- | ----- | -------------- | ------------- |
| Guest (no account) | 50 MB | 10 | 3 | — (saved on device) |
| Free account | 50 MB | 10 | 15 | 5 documents |
| Pro / Team | 500 MB | 200 | 300 | Unlimited |

Limits live in `lib/limits.ts`; the upsell UI in `components/upsell/`. Tool
limits are enforced in the browser (tools run there); the AI allowance is
enforced on the server, keyed by user id or, for guests, by IP. A failed AI
request refunds its slot. Set `AI_GUEST_DAILY_LIMIT=0` to require an account
for AI.

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
- the browser tools make **zero third-party requests**;
- an upgrade can never pair a new pdf.js API with a stale cached worker
  (pdf.js refuses to run on a mismatch).

`public/vendor` is generated and git-ignored.

## AI Assistant

`/tools/chat-with-pdf` parses the PDF in the browser and sends only its
page-tagged text to `POST /api/ai/chat`, which streams the answer back as
NDJSON. The document is placed first behind a prompt-cache breakpoint, so
follow-up questions reuse it instead of paying for it again. Guard rails:
a daily allowance per tier (guests included), a clear error for documents too
long to answer from (never silent truncation), and server-side refusal
fallbacks. Returns `503` until `ANTHROPIC_API_KEY` is set.

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

Eight end-to-end suites run the real pipeline against generated PDFs:
structure extraction, multi-column reading order, table-vs-gutter
disambiguation, baking every annotation type, the form detect/fill/flatten
round-trip, protect/unlock (verified by pdf.js as an independent reader), the
OCR text layer, and Word/Excel output (verified with python-docx and
openpyxl). Every tool has also been driven through the real UI in Chromium,
with outputs checked by independent readers.

Bugs these caught before shipping include: column detection defeated by
shared baselines; text form fields created with no widget; table columns
mistaken for a page gutter; and every pdf.js tool failing when the CDN was
unreachable (which led to self-hosting).

## SaaS layer

- **Auth** — Supabase email/password with session middleware + route guards.
- **Dashboard** — upload / list / delete documents, with per-plan limits.
- **Billing** — Stripe subscriptions (Free / Pro / Team): checkout, customer
  portal, and a webhook that syncs plan changes.
- **Storage** — a private Supabase Storage bucket locked down with row-level
  security per user.

| Plan | Price | Cloud documents | Limits |
| ---- | ----- | --------------- | ------ |
| Free | $0    | 5 (with an account) | 50 MB files, batches of 10, 3–15 AI answers/day |
| Pro  | $12   | Unlimited | 500 MB files, batches of 200, 300 AI answers/day |
| Team | $39   | Unlimited | As Pro; team features are *coming soon* |

No plan adds a watermark.

---

## Architecture

```
pdf-wizard/
├── app/
│   ├── page.tsx                 ← Marketing landing (wizard themed)
│   ├── tools/                   ← Tools hub + dynamic /tools/[slug] pages
│   ├── pricing/                 ← Public pricing
│   ├── login, signup, auth/     ← Auth screens + callbacks
│   ├── dashboard/               ← Document library (auth-gated)
│   ├── editor/[id]/             ← The PDF editor
│   ├── settings/billing/        ← Plan management + Stripe portal
│   ├── api/stripe/              ← checkout · portal · webhook
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
│   ├── stripe.ts, plans.ts, types.ts
├── tests/                        ← End-to-end pipeline tests (npm test)
└── supabase/schema.sql           ← Tables, RLS, storage bucket + policies
```

---

## Quick start

```bash
npm install
```

1. **Supabase** — create a project, run [`supabase/schema.sql`](supabase/schema.sql)
   in the SQL editor (creates tables, RLS, and the private `documents` bucket),
   and enable Email auth.
2. **Stripe** — create recurring Pro and Team prices, and a webhook pointing at
   `/api/stripe/webhook` subscribed to `customer.subscription.*` events. Locally:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```
3. **Env** — copy `.env.example` to `.env.local` and fill in the values.
4. **Run** — `npm run dev`, then open <http://localhost:3000>.

---

## Tech stack

Next.js 16 (App Router) · React 19.3 · TypeScript · Tailwind CSS · Supabase
(Auth + Postgres + Storage) · Stripe · pdf-lib · pdf.js · JSZip · Radix UI ·
lucide-react

## Production notes

- Security headers (HSTS, nosniff, frame options, permissions policy) are set in
  `next.config.ts`.
- Tool pages are statically generated with per-page metadata; `sitemap.xml` and
  `robots.txt` are generated automatically.
- **Roadmap:** saved signatures, version history, and team workspaces
  (listed as *coming soon* on the pricing page); Office → PDF conversion,
  which needs a server-side renderer such as LibreOffice.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Stripe webhook (plan sync) |
| `STRIPE_SECRET_KEY` | checkout & billing portal |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` | paid plans |
| `ANTHROPIC_API_KEY` | AI Assistant (Chat with PDF) |
| `AI_GUEST_DAILY_LIMIT` | Optional. Guest AI answers per day (default 3; `0` requires an account) |

Optional:

- `NEXT_PUBLIC_SITE_URL` — canonical URL for metadata, `sitemap.xml`, and
  Stripe redirects. Falls back to Vercel's deployment URL automatically, so it
  is only needed for a custom domain.
- `NEXT_PUBLIC_PDFJS_WORKER_SRC` — self-hosted pdf.js worker path for
  CSP-restricted deployments.

Then run [`supabase/schema.sql`](supabase/schema.sql) in your Supabase project
and point a Stripe webhook at `https://<your-domain>/api/stripe/webhook`
subscribed to `customer.subscription.*`.
