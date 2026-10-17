import { siteUrl } from "./site";

/**
 * Refuses requests that another website's page sent. Guests' daily
 * allowances (the free edit, AI answers, downloads, slide imports) are keyed
 * by IP, so without this any site a guest visits could spend them: a
 * cross-site POST with a text/plain body needs no CORS preflight. Account
 * holders' SameSite=Lax cookies aren't sent cross-site, but their routes get
 * the same check.
 *
 * Refused: `Sec-Fetch-Site: cross-site`; an `Origin` that isn't this site
 * (by host: X-Forwarded-Host, then Host, as Next.js checks server actions,
 * or the configured site URL, which a Codespace's forwarded port needs);
 * and, with `json`, any body type but application/json, which another site
 * can't send without a preflight we never allow.
 */
export function refuseCrossSite(request: Request, { json = true }: { json?: boolean } = {}): Response | null {
  const h = request.headers;
  let foreign = h.get("sec-fetch-site") === "cross-site";
  const origin = h.get("origin");
  if (!foreign && origin !== null) {
    const from = hostOf(origin);
    const self = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || new URL(request.url).host;
    foreign = !from || (from !== self && from !== hostOf(siteUrl()));
  }
  const type = (h.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (foreign || (json && type !== "application/json")) {
    return Response.json({ error: "Request refused." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    // "null" (a sandboxed frame or a file) is no site's origin.
    return null;
  }
}
