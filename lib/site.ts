/**
 * Canonical site URL, used for metadata, sitemap, robots, and Stripe redirects.
 *
 * Prefers an explicit NEXT_PUBLIC_SITE_URL, then falls back to the deployment
 * URL Vercel injects, so a fresh deploy produces correct absolute URLs with no
 * configuration at all.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.NEXT_PUBLIC_VERCEL_URL ??
    process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

  return "http://localhost:3000";
}
