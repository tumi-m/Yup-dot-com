# PDF Wizard 🧙 — A PDF Editor SaaS

> Cast spells on your PDFs. Merge, split, compress, convert, edit, and sign
> documents right in your browser — free, fast, and private.

**PDF Wizard** is a full-stack PDF toolkit + editor SaaS built with Next.js 15,
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
| **Compress PDF** | Shrink file size by recompressing pages. |
| **PDF → JPG** | Render each page to a JPG/PNG, downloaded as a zip. |
| **JPG → PDF** | Combine images into a PDF (fit-to-image or A4). |
| **PDF → Text** | Extract text in true reading order (multi-column aware). |
| **PDF → Markdown** | Layout-aware conversion keeping headings, lists & tables. |
| **Extract Tables** | Detect tables by column structure, export each as CSV. |
| **PDF → RAG Chunks** | Retrieval-sized JSON chunks with heading breadcrumbs. |
| **Page Numbers** | Insert page numbers with position & format options. |
| **Watermark** | Stamp diagonal text across every page. |
| **Edit PDF** | Full editor: whiteout, shapes, notes, links, form fields. |
| **Fill & Sign** | Fill existing PDF forms and place a drawn signature. |

Each tool has its own SEO-optimised, statically-generated page at
`/tools/<slug>` and is registered in [`lib/tools.tsx`](lib/tools.tsx).

---

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

Four end-to-end suites run the real pipeline against generated PDFs — structure
extraction, multi-column reading order, baking every annotation type, and the
form detect/fill/flatten round-trip. They caught two genuine bugs during
development (column detection defeated by shared baselines, and text form fields
silently created with no widget).

---

## SaaS layer

- **Auth** — Supabase email/password with session middleware + route guards.
- **Dashboard** — upload / list / delete documents, with per-plan limits.
- **Billing** — Stripe subscriptions (Free / Pro / Team): checkout, customer
  portal, and a webhook that syncs plan changes.
- **Storage** — a private Supabase Storage bucket locked down with row-level
  security per user.

| Plan | Price | Documents | Watermark |
| ---- | ----- | --------- | --------- |
| Free | $0    | 5         | Yes       |
| Pro  | $12   | Unlimited | No        |
| Team | $39   | Unlimited | No        |

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

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · Supabase
(Auth + Postgres + Storage) · Stripe · pdf-lib · pdf.js · JSZip · Radix UI ·
lucide-react

## Production notes

- Security headers (HSTS, nosniff, frame options, permissions policy) are set in
  `next.config.ts`.
- Tool pages are statically generated with per-page metadata; `sitemap.xml` and
  `robots.txt` are generated automatically.
- The `pdf.js` worker is loaded from a version-pinned CDN by default. Behind a
  strict CSP, self-host it and set `NEXT_PUBLIC_PDFJS_WORKER_SRC`
  (e.g. `/pdf.worker.min.mjs`).
- **Roadmap (needs server-side infra):** Office conversions (PDF↔Word/Excel/PPT),
  OCR for scanned documents, password protect/unlock, and AI summarise/chat.

## Deploy

Deploys cleanly to Vercel. Add the env vars from `.env.example` and point your
Stripe webhook at the deployed URL.
