/**
 * /.well-known/security.txt (RFC 9116): how a researcher who never opens the
 * repository finds where to report a problem. Written into public/ before
 * every build (scripts/write-security-txt.mjs), from the site URL and the
 * security address, so it follows a change of domain. Plain JavaScript so the
 * build script can use it without compiling.
 */

/** RFC 9116 asks for an Expires under a year away; every build moves it forward. */
const VALID_DAYS = 360;

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** NEXT_PUBLIC_SECURITY_EMAIL when it's a valid address, else security@pdfwizard.xyz (as lib/business.ts). */
export function securityEmail(env = process.env) {
  const v = (env.NEXT_PUBLIC_SECURITY_EMAIL ?? "").replace(/\s+/g, " ").trim().slice(0, 254);
  return v && EMAIL_RE.test(v) ? v : "security@pdfwizard.xyz";
}

/** The site's address, as lib/site.ts works it out at build time. */
export function buildSiteUrl(env = process.env) {
  if (env.NEXT_PUBLIC_SITE_URL) return env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}

/**
 * @param {{ site: string, email: string, now?: Date }} input
 * @returns {string}
 */
export function securityTxt({ site, email, now = new Date() }) {
  const base = site.replace(/\/+$/, "");
  const expires = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + VALID_DAYS * 86_400_000);
  return [
    `Contact: mailto:${email}`,
    `Expires: ${expires.toISOString().replace(".000Z", "Z")}`,
    `Preferred-Languages: en`,
    `Canonical: ${base}/.well-known/security.txt`,
    `Policy: ${base}/security`,
    "",
  ].join("\n");
}
