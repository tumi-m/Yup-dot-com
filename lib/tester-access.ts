/**
 * Tester access: free Pro or Team time that the owner gives chosen testers
 * with a code, made in the Supabase SQL editor (create_tester_code, see
 * supabase/schema.sql). Shared by the browser and the server, so nothing
 * here is secret and nothing uses Node APIs. Every check that matters runs
 * in the database, called by the server (lib/tester-redeem.ts).
 *
 * A link is https://pdfwizard.xyz/redeem#K7QM-8XRP-2D4N-W9HC. The code sits
 * in the fragment, which browsers never send to a server, so it can't reach
 * server logs, referrers or analytics; it is moved into sessionStorage and
 * out of the address bar before anything else on the page runs.
 */
import { PLANS, formatBillingDate, type PaidPlanId } from "./plans";

/** 32 symbols without 0, O, 1 or I: 16 of them carry 80 random bits. */
export const TESTER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[2-9A-HJ-NP-Z]{16}$/;
/** Longer input than this is not a code; it isn't even looked at. */
export const TESTER_CODE_MAX_INPUT = 100;

/**
 * A code as typed or pasted: letters and digits only, upper case. The same
 * rule as tester_code_normalize() in the database.
 */
export function normalizeTesterCode(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > TESTER_CODE_MAX_INPUT) return "";
  return raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** Whether `raw` has a code's shape (16 symbols from the alphabet, any spacing). */
export function isTesterCode(raw: unknown): boolean {
  return CODE_RE.test(normalizeTesterCode(raw));
}

/** "K7QM-8XRP-2D4N-W9HC", or null when `raw` isn't shaped like a code. */
export function formatTesterCode(raw: unknown): string | null {
  const c = normalizeTesterCode(raw);
  return CODE_RE.test(c) ? c.match(/.{4}/g)!.join("-") : null;
}

// ---------------------------------------------------------------------------
// The /redeem link
// ---------------------------------------------------------------------------

/** Where /redeem keeps a code until it is used (this tab only). */
export const TESTER_CODE_KEY = "pdfw-tester-code";
/** The same, when sessionStorage is blocked. */
const MEMORY_KEY = "__pdfwTesterCode";

/** Sent on window when a new code has been taken from the address bar. */
export const TESTER_CODE_EVENT = "pdfw:tester-code";

/**
 * Runs inline in <head> on every page (app/layout.tsx), before the page's
 * scripts, analytics or anything else. On /redeem it moves the fragment into
 * sessionStorage and takes it out of the address bar. Its listeners, added
 * before analytics loads and so run before analytics' own, do the same when
 * a link is opened in a tab that is already on /redeem (only the fragment
 * changes, nothing reloads), and tell the page. A fragment that names an
 * element on the page (the skip link's #main) is left alone, and elsewhere
 * it does nothing.
 * Kept as plain ES5 in a string so it can run before React;
 * tests/tester-access.test.mts runs this exact text.
 */
export const REDEEM_FRAGMENT_SCRIPT =
  "(function(){function take(){try{var h=location.hash;" +
  "if(location.pathname!=='/redeem'||!h||h.length<2)return;" +
  "var c=h.slice(1,201);try{c=decodeURIComponent(c)}catch(e){}if(document.getElementById(c))return;" +
  "history.replaceState(history.state,'',location.pathname+location.search);" +
  `try{sessionStorage.setItem('${TESTER_CODE_KEY}',c)}catch(e){window['${MEMORY_KEY}']=c}` +
  `window.dispatchEvent(new Event('${TESTER_CODE_EVENT}'))}catch(e){}}` +
  "take();window.addEventListener('popstate',take);window.addEventListener('hashchange',take)})();";

/** The browser objects /redeem reads the code from (a fake in tests). */
export interface CodeWindow {
  location: { hash: string; pathname: string; search: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void };
  sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  document?: { getElementById(id: string): unknown };
  [MEMORY_KEY]?: string;
}

/** An in-page anchor (like the skip link's #main), not a code. */
const isAnchor = (w: CodeWindow, raw: string) => !!w.document?.getElementById(raw);

function storage(w: CodeWindow) {
  try {
    return w.sessionStorage ?? null;
  } catch {
    return null; // blocked storage throws on access
  }
}

/**
 * The code /redeem was opened with, as typed in the link (it may not be a
 * valid code: the page says so). Reads the fragment if REDEEM_FRAGMENT_SCRIPT
 * didn't run (say, after a client-side navigation), saves it and clears the
 * address bar the same way; otherwise reads what was saved. Null when there
 * is none.
 */
export function takeTesterCode(w: CodeWindow): string | null {
  const store = storage(w);
  const hash = w.location.hash;
  let raw = hash && hash.length > 1 ? hash.slice(1, 201) : "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep it as it is
  }
  if (raw && !isAnchor(w, raw)) {
    w.history.replaceState(w.history.state, "", w.location.pathname + w.location.search);
    try {
      store?.setItem(TESTER_CODE_KEY, raw);
    } catch {
      w[MEMORY_KEY] = raw;
    }
    return raw;
  }
  let saved: string | null = null;
  try {
    saved = store?.getItem(TESTER_CODE_KEY) ?? null;
  } catch {
    saved = null;
  }
  return saved ?? w[MEMORY_KEY] ?? null;
}

/** Forgets the saved code: it has been used, or the server turned it down. */
export function forgetTesterCode(w: CodeWindow): void {
  try {
    storage(w)?.removeItem(TESTER_CODE_KEY);
  } catch {
    // nothing saved
  }
  delete w[MEMORY_KEY];
}

// ---------------------------------------------------------------------------
// Tester time
// ---------------------------------------------------------------------------

/**
 * A user's row in public.tester_access (they may read their own). Tester
 * time is kept per plan: Team time runs first, then Pro time, so a Team
 * code adds Team days only and a Pro code never adds Team time.
 */
export interface TesterAccess {
  /** ISO time Team tester time ends, or null. */
  teamUntil: string | null;
  /** ISO time Pro tester time ends, or null. It runs once Team time is over. */
  proUntil: string | null;
}

/** A stretch of tester time: its plan and when it ends. */
export interface TesterTime {
  plan: PaidPlanId;
  /** ISO time it ends. */
  until: string;
}

const after = (iso: string | null, now: Date) => iso !== null && Date.parse(iso) > now.getTime();

/** The tester plan at `now`, until the instant each part ends, not at it (as own_plan()). */
export function testerPlan(t: TesterAccess | null | undefined, now: Date): PaidPlanId | null {
  if (!t) return null;
  if (after(t.teamUntil, now)) return "team";
  if (after(t.proUntil, now)) return "pro";
  return null;
}

/** Whether any tester time is running at `now`. */
export function testerActive(t: TesterAccess | null | undefined, now: Date): boolean {
  return testerPlan(t, now) !== null;
}

/** Tester time still to come, in order: Team, then Pro (only the part after Team). */
export function testerTimes(t: TesterAccess | null | undefined, now: Date): TesterTime[] {
  if (!t) return [];
  const times: TesterTime[] = [];
  const team = after(t.teamUntil, now);
  if (team) times.push({ plan: "team", until: t.teamUntil! });
  if (after(t.proUntil, now) && (!team || Date.parse(t.proUntil!) > Date.parse(t.teamUntil!))) {
    times.push({ plan: "pro", until: t.proUntil! });
  }
  return times;
}

/** The tester time that ended last (to say when it ended), or null. */
export function lastTesterTime(t: TesterAccess | null | undefined): TesterTime | null {
  if (!t) return null;
  const team = t.teamUntil ? Date.parse(t.teamUntil) : -Infinity;
  const pro = t.proUntil ? Date.parse(t.proUntil) : -Infinity;
  if (team === -Infinity && pro === -Infinity) return null;
  return pro > team ? { plan: "pro", until: t.proUntil! } : { plan: "team", until: t.teamUntil! };
}

const isTime = (v: unknown): v is string | null => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));

/** A row as read from the database ({team_until, pro_until}), or null when it isn't one. */
export function parseTesterAccess(row: unknown): TesterAccess | null {
  if (!row || typeof row !== "object") return null;
  const { team_until = null, pro_until = null } = row as Record<string, unknown>;
  if (!isTime(team_until) || !isTime(pro_until) || (team_until === null && pro_until === null)) return null;
  return { teamUntil: team_until, proUntil: pro_until };
}

/** "Pro (tester)" */
export function testerPlanName(plan: PaidPlanId): string {
  return `${PLANS[plan].name} (tester)`;
}

/** "Pro (tester) until 17 Nov 2026" */
export function testerLabel(t: TesterTime): string {
  return `${testerPlanName(t.plan)} until ${formatBillingDate(t.until)}`;
}

// ---------------------------------------------------------------------------
// Answers from POST /api/access/redeem
// ---------------------------------------------------------------------------

/**
 * Why a code was turned down. "invalid" covers unknown and revoked codes
 * alike. "covered": a plan that renews (or a Team seat) already gives what
 * the code gives, so it wasn't used.
 */
export type RedeemError = "invalid" | "expired" | "used-up" | "already-redeemed" | "covered";

export const REDEEM_ERRORS: Record<RedeemError, string> = {
  invalid: "That code doesn't work. Check it and try again.",
  expired: "That code has expired.",
  "used-up": "That code has been used up.",
  "already-redeemed": "You've already used that code.",
  covered: "Your plan already includes this, so the code would add nothing. It hasn't been used.",
};

/** The "covered" answer, naming the code's plan when it is known. */
export function coveredMessage(plan: unknown): string {
  return plan === "pro" || plan === "team"
    ? `Your plan already includes ${PLANS[plan].name}, so this code would add nothing. It hasn't been used.`
    : REDEEM_ERRORS.covered;
}

export const REDEEM_TOO_MANY = "Too many tries today. Try again tomorrow.";
export const REDEEM_UNAVAILABLE = "Couldn't check the code just now. Try again.";

/** What a successful answer carries: what the code gives, and when. */
export interface RedeemResult {
  plan: PaidPlanId;
  /** Days the code gives. */
  days: number;
  /** ISO time this tester time ends. */
  until: string;
  /** ISO time it starts, when that is later than now (after time the user already has). */
  starts: string | null;
}

export function parseRedeemResult(data: unknown): RedeemResult | null {
  if (!data || typeof data !== "object") return null;
  const { plan, days, until, starts = null } = data as Record<string, unknown>;
  if (plan !== "pro" && plan !== "team") return null;
  if (typeof until !== "string" || Number.isNaN(Date.parse(until))) return null;
  if (!Number.isInteger(days) || (days as number) <= 0) return null;
  if (starts !== null && (typeof starts !== "string" || Number.isNaN(Date.parse(starts)))) return null;
  return { plan, days: days as number, until, starts };
}
