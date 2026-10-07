import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getAccount, type Account } from "@/lib/profile";
import { isAdminConfigured } from "@/lib/billing-store";
import { paystackConfigFromEnv, type PaystackConfig } from "@/lib/paystack";

export const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Common guard for the signed-in billing routes: Supabase (with the service
 * role, which records payments) and Paystack must be configured, and the
 * caller signed in.
 */
export async function billingContext(
  opts: { paystack?: boolean } = { paystack: true }
): Promise<{ account: Account; paystack: PaystackConfig } | NextResponse> {
  if (!isSupabaseConfigured() || !isAdminConfigured()) {
    return json({ error: "Billing is unavailable on this deployment." }, 503);
  }
  const paystack = paystackConfigFromEnv();
  if (opts.paystack !== false && !paystack) {
    return json({ error: "Payments aren't set up yet." }, 503);
  }
  const account = await getAccount();
  if (!account) return json({ error: "Sign in first." }, 401);
  return { account, paystack: paystack ?? { secretKey: "" } };
}
