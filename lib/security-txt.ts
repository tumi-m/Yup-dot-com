/**
 * /.well-known/security.txt (RFC 9116): how a researcher who never opens the
 * repository finds where to report a problem. Built from the site URL and
 * SECURITY_EMAIL (lib/business.ts), so it follows a change of domain.
 */
export interface SecurityTxtInput {
  site: string;
  email: string;
  now?: Date;
}

/** RFC 9116 asks for an Expires under a year away; it moves forward every day the file is rebuilt. */
const VALID_DAYS = 360;

export function securityTxt({ site, email, now = new Date() }: SecurityTxtInput): string {
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
