/**
 * POST /api/render/link: authorises one PDF of a web page, an HTML file or
 * pasted HTML, made by the media worker (media-worker/render.py).
 *
 * As /api/media/link: other sites' pages are refused, the plan and the
 * daily allowance are checked here and spent once a link is made, a
 * per-minute limit counts every try, and the answer is a short-lived token
 * the worker verifies itself. The token names exactly one page (its address,
 * or the size and SHA-256 of the HTML, which the browser sends to the worker
 * itself) with its options and the plan's page limit, so the browser can't
 * change any of them. The address is looked up here too, so a private or
 * missing site is turned away before anything is spent; the worker checks
 * again, on every request the page makes.
 */
import "server-only";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import { refuseCrossSite } from "./cross-site";
import { limitsFor, type Tier } from "./limits";
import { signToken, WORKER_CONFIG_HELP, type WorkerConfig } from "./media-server";
import { newGrantRef } from "./media-refund";
import {
  WEB_PDF_BURST_MESSAGE,
  WEB_PDF_BUSY_MESSAGE,
  WEB_PDF_BUCKET,
  claimWebPdfLink,
  consumeWebPdf,
  dailyLeft,
  usageSubject,
  type UsageStore,
} from "./usage";
import { blockedAddress, grantOptions, MAX_HTML_BYTES, PAGE_URL_MESSAGE, webPageUrl, type WebPdfOptions } from "./web-pdf";

export const WEB_PDF_OFF = "Saving web pages as PDF isn't switched on for this site yet.";

export interface WebPdfDeps {
  enabled: boolean;
  config: () => WorkerConfig;
  resolveTier: () => Promise<{ user: { id: string } | null; tier: Tier }>;
  /** A site's addresses; empty when it has none. Tests pass their own. */
  lookup?: (host: string) => Promise<string[]>;
  store?: UsageStore;
  env?: NodeJS.ProcessEnv;
}

const optionsSchema = z.object({
  size: z.enum(["a4", "letter", "fit"]),
  orientation: z.enum(["portrait", "landscape"]),
  margins: z.enum(["none", "small", "large"]),
  background: z.boolean(),
  media: z.enum(["screen", "print"]),
});

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("url"), url: z.string().min(1).max(2000), options: optionsSchema }),
  z.object({
    mode: z.literal("html"),
    bytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    options: optionsSchema,
  }),
]);

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * What a grant says, in the short keys media-worker/render.py reads: k the
 * kind, m url or html, u the address or n and d the HTML's size and SHA-256,
 * o the options, x the most pages, and s, c, t who, which and when.
 */
export function webPdfGrant(
  page: { u: string } | { n: number; d: string },
  options: WebPdfOptions,
  pages: number,
  ref: { s: string; c: string; t: number }
): Record<string, unknown> {
  return { k: "render", m: "u" in page ? "url" : "html", ...page, o: grantOptions(options), x: pages, ...ref };
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return Response.json({ error, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

/** Every address the name has, or [] when it has none. Throws when DNS gave no answer in time. */
async function systemLookup(host: string): Promise<string[]> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000));
  try {
    const found = await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
    return found.map((a) => a.address);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw err;
  }
}

export async function handleWebPdfLink(request: Request, deps: WebPdfDeps): Promise<Response> {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  // Off: as if the route weren't there.
  if (!deps.enabled) return fail(404, "Not found.");
  const config = deps.config();
  if (!config.ok) {
    console.error(`HTML to PDF disabled: ${WORKER_CONFIG_HELP[config.reason]}`);
    return fail(503, WEB_PDF_OFF);
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, "Invalid request.");
  const body = parsed.data;

  let page: { u: string } | { n: number; d: string };
  let host: string | null = null;
  if (body.mode === "url") {
    const checked = webPageUrl(body.url);
    if ("problem" in checked) return fail(400, PAGE_URL_MESSAGE[checked.problem], { reason: checked.problem });
    page = { u: checked.url };
    const name = new URL(checked.url).hostname;
    host = name.startsWith("[") ? null : /^\d+\.\d+\.\d+\.\d+$/.test(name) ? null : name;
  } else {
    if (body.bytes > MAX_HTML_BYTES) return fail(413, `HTML up to ${MAX_HTML_BYTES / 1024 / 1024} MB can be saved.`, { reason: "too-big" });
    page = { n: body.bytes, d: body.sha256 };
  }

  const { user, tier } = await deps.resolveTier();
  const subject = usageSubject(request, user, undefined, deps.env);
  const limits = limitsFor(tier);
  const paid = tier === "pro" || tier === "team";
  const spent = () =>
    fail(429, paid ? "You've used today's web pages." : "You've used today's free web pages.", { upgrade: !paid, reason: "quota" });
  if ((await dailyLeft(subject, WEB_PDF_BUCKET, limits.webPdfsPerDay, deps.store)) <= 0) return spent();
  if (!(await claimWebPdfLink(subject, deps.store))) {
    return fail(429, WEB_PDF_BURST_MESSAGE, { reason: "burst" }, { "Retry-After": "60" });
  }

  if (host) {
    // A missing or private site is said now, before the day's allowance is spent.
    let addresses: string[] | null;
    try {
      addresses = await (deps.lookup ?? systemLookup)(host);
    } catch {
      // No answer in time: the worker looks it up again and decides.
      addresses = null;
    }
    if (addresses && !addresses.length) return fail(400, PAGE_URL_MESSAGE["not-found"], { reason: "not-found" });
    if (addresses?.some(blockedAddress)) return fail(400, PAGE_URL_MESSAGE.private, { reason: "private" });
  }

  const made = Math.floor(Date.now() / 1000);
  // Spent here, so a race at the limit is still refused.
  const claim = await consumeWebPdf(subject, tier, { env: deps.env, store: deps.store });
  if (!claim.ok) return claim.reason === "quota" ? spent() : fail(503, WEB_PDF_BUSY_MESSAGE, { reason: "busy" });
  const token = signToken(webPdfGrant(page, body.options, limits.webPdfPages, { s: subject, c: newGrantRef(), t: made }), config.secret);
  return Response.json({ workerUrl: config.url, token, remaining: claim.remaining, pages: limits.webPdfPages }, { headers: NO_STORE });
}
