/**
 * Minimal Paystack client (https://paystack.com/docs/api/). Server-only: it
 * authenticates with the secret key. `fetch` is injectable for tests.
 */
import { CURRENCY, type PaidPlanId } from "./plans";

export const PAYSTACK_API = "https://api.paystack.co";

/**
 * Channels for once-off payments in South Africa: card, Apple Pay, Instant
 * EFT (Ozow), Capitec Pay, and QR (Scan to Pay / SnapScan). Subscriptions
 * renew by charging a saved card, so they are card-only.
 */
export const ONCE_OFF_CHANNELS = ["card", "apple_pay", "eft", "capitec_pay", "qr"] as const;
export const SUBSCRIPTION_CHANNELS = ["card"] as const;

export class PaystackError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PaystackError";
  }
}

export interface PaystackConfig {
  secretKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function paystackConfigFromEnv(): PaystackConfig | null {
  const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim();
  return secretKey ? { secretKey } : null;
}

/** PLN_… codes for our plans, from the environment. */
export function planCodes(env: Record<string, string | undefined> = process.env): Record<PaidPlanId, string | null> {
  return {
    pro: env.PAYSTACK_PLAN_PRO?.trim() || null,
    team: env.PAYSTACK_PLAN_TEAM?.trim() || null,
  };
}

export function planForCode(
  code: string | null | undefined,
  codes: Record<PaidPlanId, string | null> = planCodes()
): PaidPlanId | null {
  if (!code) return null;
  if (codes.pro && code === codes.pro) return "pro";
  if (codes.team && code === codes.team) return "team";
  return null;
}

async function call<T>(cfg: PaystackConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const f = cfg.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await f(`${cfg.baseUrl ?? PAYSTACK_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new PaystackError("Payment provider unreachable.", 502);
  }
  const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || !json?.status) {
    throw new PaystackError(json?.message || `Paystack error ${res.status}`, res.status >= 500 ? 502 : res.status);
  }
  return json.data as T;
}

export interface InitializeInput {
  email: string;
  /** In cents. Ignored by Paystack when `plan` is set (the plan's amount wins). */
  amount: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
  channels: readonly string[];
  plan?: string;
}

export function initializeTransaction(cfg: PaystackConfig, input: InitializeInput) {
  return call<{ authorization_url: string; access_code: string; reference: string }>(
    cfg,
    "POST",
    "/transaction/initialize",
    {
      email: input.email,
      amount: String(input.amount),
      currency: CURRENCY,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: JSON.stringify(input.metadata),
      channels: input.channels,
      ...(input.plan ? { plan: input.plan } : {}),
    }
  );
}

export function verifyTransaction(cfg: PaystackConfig, reference: string) {
  return call<Record<string, unknown>>(cfg, "GET", `/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Hosted page where the customer updates their card or cancels. */
export function subscriptionManageLink(cfg: PaystackConfig, subscriptionCode: string) {
  return call<{ link: string }>(cfg, "GET", `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`);
}

/** Our references: unguessable, and safe in a URL. */
export function newReference(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `pw_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** References come back in our callback URL; accept only our own shape. */
export function isOurReference(ref: unknown): ref is string {
  return typeof ref === "string" && /^pw_[0-9a-f]{24}$/.test(ref);
}
