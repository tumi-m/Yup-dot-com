/**
 * RFC 9116's older location, /security.txt, sends tools on to
 * /.well-known/security.txt. A route rather than a next.config redirect, so
 * the answer carries the same security headers as every other response.
 */
export function GET() {
  return new Response(null, { status: 308, headers: { Location: "/.well-known/security.txt" } });
}
