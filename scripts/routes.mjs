/**
 * Every page and route in app/, sorted by who may see it. The live check
 * (scripts/check-live.mjs) asks for each one signed out, and
 * tests/routes.test.mts fails when a page or route is in neither list, so a
 * new /admin page can't go live unchecked.
 *
 * Private pages must redirect to /login (or answer 401, 403 or 404) before
 * anything renders: no data shipped with a login screen. Closed routes must
 * not answer a signed-out GET with 2xx. [id] and [slug] are filled in with
 * made-up values.
 */

/** Pages anyone may see. */
export const PUBLIC_PAGES = [
  "/",
  "/contact",
  "/edit/[id]", // the no-account editor: the document stays in the browser
  "/forgot-password",
  "/login",
  "/pricing",
  "/privacy",
  "/refunds",
  "/security",
  "/signup",
  "/terms",
  "/tools",
  "/tools/[slug]",
];

/** Pages for signed-in users only (each under a prefix lib/supabase/middleware.ts guards). */
export const PRIVATE_PAGES = ["/dashboard", "/editor/[id]", "/settings/billing", "/settings/password"];

/** Routes that answer anyone. */
export const PUBLIC_ROUTES = [
  "/.well-known/security.txt",
  "/api/ai/chat", // GET: the visitor's own answers left today
  "/api/prices",
  "/icon.svg",
  "/opengraph-image",
  "/robots.txt",
  "/security.txt",
  "/sitemap.xml",
];

/** Routes a signed-out GET must not get 2xx from (they need an account, a signature, POST, or the owner). */
export const CLOSED_ROUTES = [
  "/api/billing/checkout",
  "/api/billing/manage",
  "/api/billing/team",
  "/api/billing/verify",
  "/api/billing/webhook",
  "/api/media/file",
  "/api/media/health",
  "/api/media/info",
  "/api/media/link",
  "/api/media/playlist",
  "/api/media/refund",
  "/api/slides/export",
  "/api/usage/edit",
  "/auth/callback",
  "/auth/signout",
];
