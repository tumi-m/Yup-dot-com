# Security policy

## Reporting a vulnerability

Email **security@pdfwizard.xyz** with:

- what you found and where (URL, API route or file),
- the steps to reproduce it,
- what an attacker could do with it.

Please don't open a public GitHub issue for a vulnerability.

We reply within **3 working days**, keep you updated at least every
**14 days** until it's fixed, and tell you when the fix is live. Issues that
expose other people's data or payments are fixed first. We're happy to credit
you once it's fixed, if you'd like.

## Scope

In scope:

- pdfwizard.xyz and its API routes (`/api/*`, `/auth/*`)
- the code in this repository, including `supabase/schema.sql` (database
  rules) and `media-worker/`
- access to other accounts' documents, files, profiles, plans or team seats
- getting a paid plan or extra usage without paying
- server secrets reaching the browser, and server-side request forgery
  through the download and import routes
- cross-site scripting, including through crafted PDF or PowerPoint files

Out of scope:

- denial of service, load or spam testing
- social engineering, phishing, or physical attacks
- vulnerabilities in Supabase, Paystack, Vercel, Ollama, Google or X
  themselves (report those to them)
- missing headers or best practices with no demonstrated impact
- self-XSS and issues that need a compromised device

## Testing rules

- Use your own accounts. Don't read, change or delete other people's data;
  if you reach any by accident, stop and tell us.
- Don't make real payments to test billing; describe the issue instead.
- Keep request volumes low.

## How security is checked

See [Security in the README](README.md#security) for the whole list. In
short: database access rules are tested on every push
(`scripts/test-rls.sh`), every build stops if a secret would reach the
browser, and the live site is checked from outside every week.

## Why the MyBroadband-style hacks don't apply here

In October 2026 MyBroadband reported a South African site, built with an AI
tool, that was hacked six days after launch: its admin password was in the
page's code, readable with the browser's developer tools. The same week a
dashboard's login screen turned out to be a front, with the data sent along
with the page, and UpGuard found about 16,000 Supabase projects whose tables
anyone could read. Here is what stops each of those on PDF Wizard, and what
checks it automatically.

**A password or key in the page.** There is no admin login or admin
password. Server secrets (Supabase service role, Paystack, Ollama, media and
usage secrets) are read only by server code: those modules import
`server-only`, so a client component that imports one fails the build.
Only `NEXT_PUBLIC_` variables reach the browser, and:

- `scripts/check-env.mjs` runs before every build (npm `prebuild`, so on
  Vercel too) and stops it when a `NEXT_PUBLIC_` variable holds a Supabase
  JWT whose role isn't `anon`, an `sb_secret_` key, a Paystack
  `sk_live_`/`sk_test_` key, a private key or the value of a server-only
  variable, when a server-only name has a `NEXT_PUBLIC_` prefix, or when
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` isn't the anon or publishable key.
  `next.config.ts` runs the same check for a plain `next build`.
- `scripts/check-bundle-secrets.mjs` runs after every build (npm
  `postbuild`) and searches everything a browser can download
  (`.next/static`, prerendered pages, `public/`) for those patterns and for
  the actual values of the server-only variables, and fails the build on a
  hit. CI also builds with fake values in every secret and runs it with
  `--canary`.
- Pages render at request time, so they aren't files a build check can
  read. React refuses to send a server secret to the browser
  (`lib/server-secrets.ts`, `experimental.taint`): a page that tries fails
  instead. CI starts the build and checks the rendered pages from outside.

**Data sent with a login screen.** The dashboard, billing, password and
editor pages check the session on the server (in `proxy.ts` and again in
each page) and redirect to `/login` before anything renders. Their data is
read with the visitor's own token, so Row Level Security decides what comes
back.

**Tables anyone can read.** Row Level Security is on for every table, every
policy is scoped to the signed-in user, and the `anon` role (the public key
every browser has) has no privilege on any table, so even a table with RLS
switched off by mistake returns nothing. `scripts/test-rls.sh` checks this
on every push (and that no migration undoes it when run again).

**An injected script stealing the session.** Every page has a
Content-Security-Policy with a fresh nonce: an injected `<script>`, an
`onerror=` handler or a `javascript:` link doesn't run, and `fetch` can't
reach other sites. The session cookie is `Secure` and lasts 30 days.

### Checking the live site

```bash
npm run check:live -- https://pdfwizard.xyz
```

`scripts/check-live.mjs` needs Node 20 and nothing else. It fetches the
site's pages and every script they load and looks for secret keys; checks
the security headers on a page, an API response, a static file and the 404
page; expects 404 for `/.env`, `/.git/config`, source files and source
maps; expects the private pages to redirect to `/login` when signed out
(as pages and as RSC requests) with no private data; reads the Supabase URL
and public key from the site's own scripts and asks for every table and
view, calls every `SECURITY DEFINER` function and lists the documents
bucket, expecting no rows or "permission denied"; checks that Supabase's
"Confirm email" is on; and checks `/.well-known/security.txt`. It prints a
short report and exits with 1 if anything failed.

GitHub runs it every Monday, on demand (Actions → Live check → Run
workflow) and six minutes after each push to `main`, against the
repository variable `SITE_URL`. It needs no secrets. If it fails, read the
failing line: it names the URL, table or header.

## If a key leaks

A key that was in a screenshot, a chat, a commit, a public file or a
`NEXT_PUBLIC_` variable is leaked. Rotate it at once; deleting the file or
the commit doesn't un-leak it.

1. **Supabase service role** (`SUPABASE_SERVICE_ROLE_KEY`): Supabase →
   Project Settings → API Keys. With the new keys, create a new secret key,
   put it in Vercel, redeploy, then delete the old one. With the legacy JWT
   keys, move to the new keys and disable the legacy ones (or roll the JWT
   secret, which also changes the anon key and signs everyone out).
2. **Paystack** (`PAYSTACK_SECRET_KEY`): Paystack → Settings → API Keys &
   Webhooks → generate a new secret key, then update Vercel and redeploy
   straight away: the same key checks webhook signatures.
3. **Ollama** (`OLLAMA_API_KEY`): ollama.com → Settings → Keys: delete it,
   create a new one, update Vercel.
4. **Media worker** (`MEDIA_WORKER_SECRET`): make a new one
   (`openssl rand -hex 32`) and set it on the worker host and in Vercel
   together.
5. **`MEDIA_SIGNING_SECRET`, `USAGE_HASH_SALT`**: make new ones, set them in
   Vercel, redeploy. Download links being used at that moment stop working
   and guests' daily counts start again.
6. Then redeploy, run `npm run check:live -- https://pdfwizard.xyz`, and look
   through Supabase's and Paystack's logs for use you don't recognise.
