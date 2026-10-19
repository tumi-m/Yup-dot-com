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
Only `NEXT_PUBLIC_` variables reach the browser, and the code may use only
the ones listed in `PUBLIC_VARS` (`lib/secret-scan.cjs`). Before every build
(npm `prebuild`, so on Vercel too; `next.config.ts` does the same for a plain
`next build`):

- `scripts/check-env.mjs` stops the build when a `NEXT_PUBLIC_` variable is
  named like a secret (`NEXT_PUBLIC_ADMIN_PASSWORD`, `_PASS`, `_PW`,
  `_TOKEN`, `_API_KEY`, `_JWT…`, `_DATABASE_URL`, or a server-only name in
  any case), holds one (a Supabase JWT whose role isn't `anon`, an
  `sb_secret_` key, Paystack, OpenAI, Resend or other secret keys, a private
  key, a connection string with a password, also base64 or hex encoded), has
  the value of a server-only variable, or when
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` isn't the anon or publishable key.
- `scripts/check-source.mjs` stops it when the code itself holds a
  credential: a name like `password`, `adminPass`, `ADMIN_PW`, `token` or
  `apiKey` compared with, or set to, a fixed string (the article's mistake),
  a secret key pasted into app code, `public/` or `extension/`, or a
  `NEXT_PUBLIC_` name that isn't on the list.

After the build, `scripts/check-bundle-secrets.mjs` searches everything a
browser can download (`.next/static`, prerendered pages, `public/`) for those
patterns and for the actual values of the server variables (the known keys,
anything named like a password, token, salt or key, and the password inside a
connection string), and fails the build on a hit. CI also builds with fake
values in every secret and runs it with `--canary`, and scans the whole
repository and its history with gitleaks.

Pages render at request time, so they aren't files a build check can read.
React refuses to send any of those secret values to the browser
(`lib/server-secrets.ts`, `experimental.taint`): a page that tries fails
instead. CI starts the build and checks the rendered pages from outside.

Pattern searches can't catch a key someone deliberately hides (reversed or
encrypted). That case is covered by the value search and React's refusal,
which compare the real values, not their shape.

**Data sent with a login screen.** The dashboard, billing, password and
editor pages check the session on the server (in `proxy.ts`, for every page
path, and again in each page) and redirect to `/login` before anything
renders. Their data is read with the visitor's own token, so Row Level
Security decides what comes back. `scripts/routes.mjs` lists every page and
route as public or private, a new one in neither list fails the tests, and
the live check asks for every private page and closed route signed out.

**Tables anyone can read.** Row Level Security is on for every table, every
policy is scoped to the signed-in user, and the `anon` role (the public key
every browser has) has no privilege on any table, so even a table with RLS
switched off by mistake returns nothing. Tables, views and functions added
later, by hand, are private too: an event trigger switches RLS on for each
new table and won't let it be switched off, new views check RLS as the
reader, and browsers can't use anything new until it is granted on purpose.
`scripts/test-rls.sh` checks all of this on every push (and that no migration
undoes it when run again). For anything changed by hand in the dashboard,
run `supabase/audit.sql` in the SQL editor: it lists every table without RLS,
view that skips it, privilege the public key has, callable `SECURITY DEFINER`
function, public bucket and storage policy for visitors, and should return
nothing.

**An injected script stealing the session.** Every page has a
Content-Security-Policy with a fresh nonce, including paths that end in
`.png`: an injected `<script>`, an `onerror=` handler or a `javascript:` link
doesn't run, and `fetch` can't reach other sites. The session cookie is
`Secure` and lasts 30 days.

### Checking the live site

```bash
npm run check:live -- https://pdfwizard.xyz
```

`scripts/check-live.mjs` needs Node 20 and nothing else. It fetches the
site's pages and every script they load and looks for secret keys; checks
the security headers on a page, an API response, a static file, a redirect
and the 404 page (also for a path ending in `.png`); expects 404 for `/.env`,
`/.git/config`, source files and source maps; asks for every private page
and closed route in `scripts/routes.mjs` signed out (as pages and as RSC
requests, and with `.png` added) and expects a redirect to `/login` or a
refusal with no private data; reads the Supabase URL and public key from the
site's own scripts and tries every table and view it can find (in
`supabase/*.sql` and in the API's own listing) for reads and for writes sent
so they change nothing, calls every `SECURITY DEFINER` function and every
function the API lists read-only, and tries every bucket it can find or
guess; checks that Supabase's "Confirm email" is on; and checks
`/.well-known/security.txt`. With a test account (the secrets
`CHECK_LIVE_EMAIL` and `CHECK_LIVE_PASSWORD`) it repeats the database checks
signed in and fails on any row or file that isn't the account's own. It
prints a short report, with warnings for anything it couldn't check (for
example when the API won't list its schema), and exits with 1 if anything
failed. What it can't see from outside (a table or bucket nothing names),
`supabase/audit.sql` covers.

GitHub runs it every Monday, on demand (Actions → Live check → Run
workflow) and six minutes after each push to `main`, against the
repository variable `SITE_URL`. If it fails, read the failing line: it names
the URL, table, function, bucket or header.

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
