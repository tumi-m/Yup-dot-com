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
| **PDF → Text** | Extract all selectable text to a `.txt` file. |
| **Page Numbers** | Insert page numbers with position & format options. |
| **Watermark** | Stamp diagonal text across every page. |
| **Edit PDF** | Full editor: text, highlights, drawings, page ops. |
| **Fill & Sign** | Fill forms and place a drawn signature. |

Each tool has its own SEO-optimised, statically-generated page at
`/tools/<slug>` and is registered in [`lib/tools.tsx`](lib/tools.tsx).

---

## Editor

The editor renders each page to a canvas with **pdf.js**, then overlays an
annotation layer. Annotations are stored in **PDF points with a top-left
origin** so they're zoom-independent. On export, `pdf-lib` flattens them into
the document (text, highlights, freehand strokes, signature images). Structural
operations (rotate, delete, reorder, merge) bake current annotations first, then
transform the bytes and re-render.

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
│   ├── editor/                   ← PdfEditor, PageView, AnnotationView, SignaturePad
│   ├── ToolGrid.tsx, WizardLogo.tsx
│   └── ui/                       ← Button, Input, Dialog
├── lib/
│   ├── pdf/toolkit.ts            ← All tool processing (merge/split/compress/…)
│   ├── pdf/operations.ts         ← pdf-lib page ops + annotation baking
│   ├── pdf/render.ts             ← pdf.js render helper
│   ├── tools.tsx                 ← Tool registry (metadata + icons)
│   ├── supabase/                 ← browser · server · middleware clients
│   ├── stripe.ts, plans.ts, types.ts
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
- The `pdf.js` worker is loaded from a version-pinned CDN. If your deployment
  blocks outbound CDN requests, self-host the worker in `/public` instead.
- **Roadmap (needs server-side infra):** Office conversions (PDF↔Word/Excel/PPT),
  OCR, password protect/unlock, and AI summarise/chat.

## Deploy

Deploys cleanly to Vercel. Add the env vars from `.env.example` and point your
Stripe webhook at the deployed URL.
