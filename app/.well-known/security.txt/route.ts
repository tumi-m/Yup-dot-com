import { SECURITY_EMAIL } from "@/lib/business";
import { securityTxt } from "@/lib/security-txt";
import { siteUrl } from "@/lib/site";

// Rebuilt daily, so Expires always stays about a year away.
export const revalidate = 86400;

export function GET() {
  return new Response(securityTxt({ site: siteUrl(), email: SECURITY_EMAIL }), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
