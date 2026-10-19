import { handleRedeem } from "@/lib/tester-redeem";
import { getCurrentUser, createAdminClient } from "@/lib/supabase/server";
import { isAdminConfigured } from "@/lib/billing-store";
import { usageStore, usageSubject } from "@/lib/usage";

export const dynamic = "force-dynamic";

/** Redeems a tester code for the signed-in user. See lib/tester-redeem.ts. */
export async function POST(request: Request) {
  if (!isAdminConfigured()) {
    return Response.json({ error: "Tester codes aren't set up on this deployment." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return handleRedeem(request, {
    getUser: getCurrentUser,
    redeem: (args) => createAdminClient().rpc("redeem_tester_code", args),
    consume: (subject, bucket, limit, window) => usageStore().consume(subject, bucket, limit, window),
    ipSubject: (req) => usageSubject(req, null),
  });
}
