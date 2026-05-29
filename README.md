# Yup — A PDF Editor SaaS

> Edit, annotate, sign, merge, and reorganise PDFs right in your browser. No installs, no nonsense.

**Yup** is a full-stack PDF editor SaaS built with Next.js 15, Supabase, Stripe,
and a fully client-side PDF engine (`pdf-lib` + `pdf.js`). Upload a document,
mark it up, sign it, rearrange the pages, and export — all without anything
leaving the browser except the final saved file.

---

## Features

- **Annotate & text** — drop text anywhere, with adjustable size and colour.
- **Highlight & draw** — colour highlights and freehand drawing.
- **Fill & sign** — draw a signature and place it on any page.
- **Page operations** — merge, reorder, rotate, and delete pages.
- **SaaS layer** — Supabase email/password auth, a document dashboard, and
  Stripe subscription billing (Free / Pro / Team) with plan-based limits.
- **Private storage** — documents live in a private Supabase Storage bucket,
  locked down with row-level security per user.

---

## Architecture

```
yup/
├── app/
│   ├── page.tsx                 ← Marketing landing page
│   ├── pricing/                 ← Public pricing page
│   ├── login, signup/           ← Auth screens
│   ├── auth/                    ← OAuth/email callback + signout
│   ├── dashboard/               ← Document library (auth-gated)
│   ├── editor/[id]/             ← The PDF editor
│   ├── settings/billing/        ← Plan management + Stripe portal
│   └── api/stripe/              ← checkout · portal · webhook
├── components/
│   ├── editor/
│   │   ├── PdfEditor.tsx        ← Editor shell: tools, page ops, save/export
│   │   ├── PageView.tsx         ← Renders a page + the annotation overlay
│   │   ├── AnnotationView.tsx   ← A single draggable annotation
│   │   └── SignaturePad.tsx     ← Draw-your-signature modal
│   ├── DashboardClient.tsx      ← Upload / list / delete documents
│   ├── PricingCards.tsx         ← Plan cards + checkout
│   └── ui/                      ← Button, Input, Dialog primitives
├── lib/
│   ├── pdf/operations.ts        ← pdf-lib: merge/split/rotate/delete + bake
│   ├── pdf/render.ts            ← pdf.js render helper
│   ├── supabase/                ← browser · server · middleware clients
│   ├── stripe.ts                ← Stripe client + plan/price mapping
│   ├── plans.ts                 ← Plan definitions and limits
│   └── types.ts                 ← Shared types + annotation model
└── supabase/schema.sql          ← Tables, RLS, storage bucket + policies
```

### How editing works

The editor renders each page to a canvas with **pdf.js**, then overlays an
absolutely-positioned annotation layer. Annotations are stored in **PDF points
with a top-left origin** so they're independent of zoom. On export, `pdf-lib`
flattens (“bakes”) every annotation into the document — text, highlights,
freehand strokes, and signature images. Structural operations (rotate, delete,
reorder, merge) bake the current annotations first, then transform the bytes and
re-render.

---

## Quick start

### 1. Install

```bash
npm install
```

### 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql). This
   creates the tables, RLS policies, and the private `documents` storage bucket.
3. Under **Authentication → Providers**, enable Email. (Disable “Confirm email”
   for the smoothest local dev experience.)

### 3. Set up Stripe

1. Create two recurring prices (Pro and Team) in the Stripe dashboard.
2. Add a webhook endpoint pointing at `/api/stripe/webhook` and subscribe to
   `customer.subscription.*` events. Locally, use the Stripe CLI:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

### 4. Configure env

Copy `.env.example` to `.env.local` and fill in the values.

### 5. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

---

## Plans

| Plan | Price | Documents | Watermark |
| ---- | ----- | --------- | --------- |
| Free | $0    | 5         | Yes       |
| Pro  | $12   | Unlimited | No        |
| Team | $39   | Unlimited | No        |

Limits are enforced in the dashboard and the export watermark is applied for
free-tier users in `lib/pdf/operations.ts`.

---

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · Supabase
(Auth + Postgres + Storage) · Stripe · pdf-lib · pdf.js · Radix UI · lucide-react

## Deploy

Deploys cleanly to Vercel. Add the environment variables from `.env.example`
in the project settings, and point your Stripe webhook at the deployed URL.
