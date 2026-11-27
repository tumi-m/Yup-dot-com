import { headers } from "next/headers";
import { jsonLdHtml } from "@/lib/structured-data";

/** Structured data for search engines, with the Content-Security-Policy nonce the other scripts carry. */
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLdHtml(data) }} />;
}
