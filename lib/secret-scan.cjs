// @ts-check
"use strict";
/**
 * What counts as a server secret. Shared by the build checks
 * (scripts/check-env.mjs before a build, scripts/check-bundle-secrets.mjs
 * after it), next.config.ts, the live check (scripts/check-live.mjs) and
 * lib/server-secrets.ts. Plain CommonJS with no imports, so all of them can
 * load it.
 *
 * Messages never include a secret's value, only its name and kind, so build
 * logs stay safe to share.
 */

/** Server-only variables: never under a NEXT_PUBLIC_ name, never in a file a browser can download. */
const SERVER_ONLY_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_PLAN_PRO",
  "PAYSTACK_PLAN_TEAM",
  "OLLAMA_API_KEY",
  "OLLAMA_HOST",
  "USAGE_HASH_SALT",
  "MEDIA_WORKER_URL",
  "MEDIA_WORKER_SECRET",
  "MEDIA_SIGNING_SECRET",
];

/** The keys and salts among them: React refuses to send these to a browser (lib/server-secrets.ts). */
const SECRET_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYSTACK_SECRET_KEY",
  "OLLAMA_API_KEY",
  "USAGE_HASH_SALT",
  "MEDIA_WORKER_SECRET",
  "MEDIA_SIGNING_SECRET",
];

/** Any other variable whose name says it holds a secret (a CI token, a key added later). */
const SECRET_NAME = /SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|SERVICE_ROLE|API_KEY|SALT|CREDENTIAL/;
/** Names that must never carry a NEXT_PUBLIC_ prefix, whatever their value. */
const SERVER_NAME = /SECRET|PASSWORD|PASSWD|PRIVATE|SERVICE_ROLE|SALT/;

const PUBLIC_PREFIX = "NEXT_PUBLIC_";

/** @type {[string, RegExp][]} */
const PATTERNS = [
  ["a Supabase secret key (sb_secret_…)", /sb_secret_[A-Za-z0-9_-]{8,}/g],
  ["a Paystack or Stripe secret key (sk_live_… / sk_test_…)", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g],
  ["a private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:\s|\\[nr])*[A-Za-z0-9+/]{40}/g],
];
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/**
 * The payload of a JWT, or null.
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
function jwtPayload(token) {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** First characters of a match, enough to find it, too few to use it. */
function redact(/** @type {string} */ s) {
  return s.length > 14 ? `${s.slice(0, 12)}…` : s;
}

/**
 * Secrets in a piece of text: each pattern above, and any JWT whose role
 * isn't "anon" (the anon key is meant to be public; a service_role key
 * bypasses every RLS rule).
 * @param {string} text
 * @returns {{ kind: string, sample: string }[]}
 */
function findSecrets(text) {
  /** @type {{ kind: string, sample: string }[]} */
  const found = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ kind, sample: redact(m[0]) });
  }
  for (const m of text.matchAll(JWT)) {
    const role = jwtPayload(m[0])?.role;
    if (typeof role === "string" && role !== "anon") {
      found.push({ kind: `a Supabase key with role "${role}"`, sample: redact(m[0]) });
    }
  }
  return found;
}

/**
 * The public Supabase key: the "anon" JWT, or a new sb_publishable_ key.
 * @param {string} value
 */
function isPublicSupabaseKey(value) {
  const v = value.trim();
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(v)) return true;
  return jwtPayload(v)?.role === "anon";
}

/**
 * Values of the server-only and secret-looking variables that are set, to
 * search for in what browsers download.
 * @param {Record<string, string | undefined>} env
 * @returns {[string, string][]}
 */
function serverValues(env) {
  /** @type {[string, string][]} */
  const out = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = (raw ?? "").trim();
    if (!value || name.startsWith(PUBLIC_PREFIX)) continue;
    const listed = SERVER_ONLY_VARS.includes(name);
    const named = SECRET_NAME.test(name.toUpperCase()) && !/_(URL|HOST|PATH|FILE|DIR)$/i.test(name);
    if (!listed && !named) continue;
    // Too short or too plain to be a secret ("1", "true", a port).
    if (value.length < (listed ? 8 : 12) || /^(\d+|true|false)$/i.test(value)) continue;
    out.push([name, value]);
  }
  return out;
}

/**
 * What's wrong with the build environment, as short messages. Empty when
 * nothing is.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function envProblems(env) {
  /** @type {string[]} */
  const problems = [];
  const secrets = serverValues(env);
  for (const [name, raw] of Object.entries(env)) {
    const value = (raw ?? "").trim();
    if (!name.startsWith(PUBLIC_PREFIX) || !value) continue;
    const bare = name.slice(PUBLIC_PREFIX.length);
    if (SERVER_ONLY_VARS.includes(bare) || SERVER_NAME.test(bare.toUpperCase())) {
      problems.push(`${name}: ${bare} is server-only. Rename it without NEXT_PUBLIC_ (that prefix puts the value in every visitor's browser).`);
      continue;
    }
    const found = findSecrets(value)[0];
    if (found) {
      problems.push(`${name} holds ${found.kind}. NEXT_PUBLIC_ values go to every visitor's browser.`);
      continue;
    }
    const same = secrets.find(([, v]) => v === value);
    if (same) {
      problems.push(`${name} has the same value as ${same[0]}, which is server-only.`);
      continue;
    }
    if (name === "NEXT_PUBLIC_SUPABASE_ANON_KEY" && !isPublicSupabaseKey(value)) {
      problems.push(
        `${name} isn't Supabase's public key. Use the "anon" key or the sb_publishable_ key (Supabase → Project Settings → API Keys), never the service_role or sb_secret_ key.`
      );
    }
  }
  return problems;
}

module.exports = {
  SERVER_ONLY_VARS,
  SECRET_VARS,
  envProblems,
  findSecrets,
  isPublicSupabaseKey,
  jwtPayload,
  serverValues,
};
