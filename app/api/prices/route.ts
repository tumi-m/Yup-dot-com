import { NextResponse } from "next/server";
import { getPriceDisplay } from "@/lib/local-prices";

/**
 * Local-currency price strings for client-only UI (the upgrade dialog), so
 * statically rendered tool pages needn't become dynamic. Display only:
 * checkout always charges rand.
 */
export async function GET(request: Request) {
  const display = await getPriceDisplay(new URL(request.url).searchParams.get("currency"));
  return NextResponse.json(display, {
    headers: { "Cache-Control": "private, max-age=3600", Vary: "x-vercel-ip-country" },
  });
}
