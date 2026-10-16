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

See [Security in the README](README.md#security): database access rules are
tested on every push (`scripts/test-rls.sh`), and every build is checked for
server secrets in browser files (`scripts/check-bundle-secrets.mjs`).
