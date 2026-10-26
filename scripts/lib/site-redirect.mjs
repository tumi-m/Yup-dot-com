/**
 * Where the live check should look when the address it was given redirects:
 * the site's own other address (pdfwizard.xyz → www.pdfwizard.xyz, or the
 * reverse) on the same scheme, or null for anything else, which is checked
 * as it is.
 */
export function mainAddress(site, location) {
  if (!location) return null;
  let from, to;
  try {
    from = new URL(site);
    to = new URL(location, from);
  } catch {
    return null;
  }
  const bare = (host) => host.toLowerCase().replace(/^www\./, "");
  if (to.origin === from.origin || to.protocol !== from.protocol || to.port !== from.port) return null;
  return bare(to.hostname) === bare(from.hostname) ? to.origin : null;
}
