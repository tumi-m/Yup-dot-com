// @ts-check
"use strict";
/**
 * What counts as a server secret. Shared by the build checks
 * (scripts/check-env.mjs and scripts/check-source.mjs before a build,
 * scripts/check-bundle-secrets.mjs after it), next.config.ts, the live check
 * (scripts/check-live.mjs), the extension packer and lib/server-secrets.ts.
 * Plain CommonJS that needs only Node, so all of them can load it.
 *
 * Messages never include a secret's value, only its name and kind, so build
 * logs stay safe to share.
 *
 * Pattern searches can't catch every way of hiding a key (split into pieces,
 * reversed, encrypted). They catch keys pasted as they are, base64 or hex
 * encoded, \u-escaped, or cut in two with "+". What a pattern can't see is
 * covered by searching for the actual values of this build's server
 * variables, by React refusing to send them to the browser, and by the
 * allow-list of NEXT_PUBLIC_ names the code may use.
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

/** The keys and salts among them. */
const SECRET_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYSTACK_SECRET_KEY",
  "OLLAMA_API_KEY",
  "USAGE_HASH_SALT",
  "MEDIA_WORKER_SECRET",
  "MEDIA_SIGNING_SECRET",
];

/**
 * The only NEXT_PUBLIC_ variables the code may use (the part after the
 * prefix). Each is copied into every visitor's browser, so a new one goes
 * here only if it is meant to be public. Vercel's own NEXT_PUBLIC_VERCEL_*
 * variables (deployment URL, git commit) are allowed too.
 */
const PUBLIC_VARS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SITE_URL",
  "GA_MEASUREMENT_ID",
  "GOOGLE_SITE_VERIFICATION",
  "BING_SITE_VERIFICATION",
  "ENABLE_YOUTUBE",
  "TURNSTILE_SITE_KEY",
  "PDFJS_WORKER_SRC",
  "BUSINESS_NAME",
  "BUSINESS_ADDRESS",
  "LEGAL_NAME",
  "CONTACT_EMAIL",
  "CONTACT_PHONE",
  "SECURITY_EMAIL",
];
const PUBLIC_VAR_PREFIXES = ["VERCEL_"];

const PUBLIC_PREFIX = "NEXT_PUBLIC_";

/**
 * Names that say a variable holds a secret: never under NEXT_PUBLIC_, and
 * their values are searched for in what browsers download.
 */
const SECRET_NAME =
  /SECRET|PASSWORD|PASSWD|PASSPHRASE|PASSCODE|(?:^|_)PASS(?:_|$)|(?:^|_)PW(?:_|$)|PRIVATE|TOKEN|SERVICE_ROLE|API_?KEY|ACCESS_KEY|SALT|CREDENTIAL|JWT|DATABASE_URL|(?:^|_)DB_(?:URL|PASS)|POSTGRES|CONNECTION_STRING/;
/** Names that may hold a key: searched for unless the value is a public key. */
const KEY_NAME = /(?:^|_)KEY(?:_|$)/;
/** Environment variables that are never secrets (npm's, the shell's). */
const IGNORED_NAME = /^(?:npm_|PWD$|OLDPWD$|HOME$|PATH$|SHELL$|TERM$|TERM_PROGRAM|LANG$|LANGUAGE$|LC_[A-Z]+$|HOSTNAME$|_$)/i;

/** @type {[string, RegExp][]} */
const PATTERNS = [
  ["a Supabase secret key (sb_secret_…)", /sb_secret_[A-Za-z0-9_-]{8,}/g],
  ["a Paystack or Stripe secret key (sk_live_… / sk_test_…)", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g],
  ["a webhook signing secret (whsec_…)", /\bwhsec_[A-Za-z0-9+/=]{16,}/g],
  ["an OpenAI key (sk-proj-… / sk-…)", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g],
  ["an LLM API key (sk-ant-…)", /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/g],
  ["a Resend key (re_…)", /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}/g],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["a private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:\s|\\[nr])*[A-Za-z0-9+/]{40}/g],
  // The base64 body of a private key without its BEGIN line (PKCS#8, PKCS#1 RSA, EC).
  ["a private key (without its header)", /MII[A-Za-z0-9+/]{2,3}IBADANBgkqhkiG9w0BAQEFAASC|MII[A-Za-z0-9+/]{2}IBAAKC[AQg]Q[A-Za-z0-9+/]{20}|MHcCAQEE[A-Za-z0-9+/]{40}/g],
  // A password inside a connection string. Placeholders ([YOUR-PASSWORD], <password>, ${…}) aren't.
  ["a password in a connection string", /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/"'`]*:(?![[<{$*]|password@|postgres@|your)[^\s@/"'`]{3,}@/gi],
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
 * @param {string} text
 * @param {string} how
 * @param {{ kind: string, sample: string }[]} found
 */
function matchPatterns(text, how, found) {
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ kind: kind + how, sample: redact(m[0]) });
  }
  for (const m of text.matchAll(JWT)) {
    const role = jwtPayload(m[0])?.role;
    if (typeof role === "string" && role !== "anon") {
      found.push({ kind: `a Supabase key with role "${role}"${how}`, sample: redact(m[0]) });
    }
  }
}

/** Mostly printable text: what a decoded secret looks like (and decoded images, fonts or hashes don't). */
function printable(/** @type {string} */ s) {
  if (s.length < 16) return false;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9) ok++;
  }
  return ok / s.length > 0.95;
}

/**
 * Secrets in a piece of text: each pattern above, and any JWT whose role
 * isn't "anon" (the anon key is meant to be public; a service_role key
 * bypasses every RLS rule). Also looks inside base64 and hex strings,
 * \u/\x escapes, strings cut in two with "+", and ["a","b"].join("") arrays.
 * @param {string} text
 * @returns {{ kind: string, sample: string }[]}
 */
function findSecrets(text) {
  /** @type {{ kind: string, sample: string }[]} */
  const found = [];
  matchPatterns(text, "", found);

  // "sk_li" + "ve_…", sk_live_…, ["sk","live","…"].join("_")
  let joined = text.replace(/(["'`])\s*\+\s*(["'`])/g, "");
  joined = joined.replace(/\\u\{?([0-9a-fA-F]{4})\}?|\\x([0-9a-fA-F]{2})/g, (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)));
  joined = joined.replace(/\[((?:\s*(["'`])[^"'`\n]{0,200}\2\s*,?){2,20})\]\.join\(\s*(["'`])([^"'`\n]{0,5})\3\s*\)/g, (_, items, _q, _q2, sep) =>
    JSON.stringify([...items.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((m) => m[2]).join(sep))
  );
  if (joined !== text) matchPatterns(joined, " (in pieces or escaped)", found);

  // base64 / base64url and hex strings, decoded. Long blobs (images, fonts,
  // WebAssembly) are skipped: a key is a few hundred bytes to a few kB.
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{40,8000}={0,2}/g)) {
    if (!/[A-Z]/.test(m[0]) || !/[a-z]/.test(m[0])) continue;
    const decoded = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    if (printable(decoded)) matchPatterns(decoded, " (base64-encoded)", found);
  }
  for (const m of text.matchAll(/\b(?:[0-9a-f]{2}){20,4000}\b/gi)) {
    const decoded = Buffer.from(m[0], "hex").toString("latin1");
    if (printable(decoded)) matchPatterns(decoded, " (hex-encoded)", found);
  }

  // A full PEM key also matches the header-less pattern: report it once.
  const pem = found.some((f) => f.kind.startsWith("a private key") && !f.kind.includes("without its header"));
  const seen = new Set();
  return found.filter((f) => {
    if (pem && f.kind.includes("without its header")) return false;
    const key = f.sample;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/** A key that is public by design (Supabase anon/publishable, Paystack or Stripe pk_). */
function isPublicKey(/** @type {string} */ value) {
  return isPublicSupabaseKey(value) || /^pk_(?:live|test)_[A-Za-z0-9]+$/.test(value.trim());
}

/** Too short or too plain to be a secret ("1", "true", a port, a word like "authorization"). */
function plainValue(/** @type {string} */ value) {
  return value.length < 8 || /^(?:\d+|true|false|yes|no|on|off|none|null|undefined)$/i.test(value) || /^[a-z]+(?:[_-][a-z]+)*$/.test(value);
}

/** user:password@ inside a URL value, or null. */
function urlPassword(/** @type {string} */ value) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/i.exec(value);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Values of the server-only and secret-looking variables that are set, to
 * search for in what browsers download: [name, value, taint]. `taint` says
 * React should also refuse to send it to the browser: every secret, but not
 * plain settings such as a server's address or a Paystack plan code.
 * @param {Record<string, string | undefined>} env
 * @returns {[string, string, boolean][]}
 */
function serverValues(env) {
  /** @type {[string, string, boolean][]} */
  const out = [];
  const publicValues = new Set(
    Object.entries(env)
      .filter(([n]) => n.toUpperCase().startsWith(PUBLIC_PREFIX))
      .map(([, v]) => (v ?? "").trim())
      .filter(Boolean)
  );
  for (const [name, raw] of Object.entries(env)) {
    const value = (raw ?? "").trim();
    const upper = name.toUpperCase();
    if (!value || upper.startsWith(PUBLIC_PREFIX) || IGNORED_NAME.test(name)) continue;
    const listed = SERVER_ONLY_VARS.includes(upper);
    const secret = SECRET_VARS.includes(upper) || SECRET_NAME.test(upper);
    const key = KEY_NAME.test(upper);
    const password = urlPassword(value);
    if (!listed && !secret && !key && !password) continue;

    if (password) {
      // A connection string: the whole URL and its password on its own.
      out.push([name, value, true]);
      if (!plainValue(password)) out.push([`${name} (its password)`, password, true]);
      continue;
    }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /_(?:URL|HOST|PATH|FILE|DIR)$/.test(upper);
    if (url && !listed) continue;
    if (listed && !secret) {
      // A setting rather than a secret (OLLAMA_HOST, MEDIA_WORKER_URL, plan codes).
      if (value.length >= 8 && !/^(?:\d+|true|false)$/i.test(value)) out.push([name, value, false]);
      continue;
    }
    if (plainValue(value)) continue;
    // A copy of a public key under a server name (SUPABASE_ANON_KEY) isn't a secret.
    if (!secret && (isPublicKey(value) || publicValues.has(value))) continue;
    out.push([name, value, true]);
  }
  return out;
}

/** @param {string} bare */
function isAllowedPublicName(bare) {
  return PUBLIC_VARS.includes(bare) || PUBLIC_VAR_PREFIXES.some((p) => bare.startsWith(p) && !SECRET_NAME.test(bare));
}

/**
 * What's wrong with the build environment, as short messages. Empty when
 * nothing is.
 * @param {Record<string, string | undefined>} env
 * @param {Set<string> | null} [used] NEXT_PUBLIC_ names the code uses (publicVarsInSource)
 * @returns {string[]}
 */
function envProblems(env, used = null) {
  /** @type {string[]} */
  const problems = [];
  const secrets = serverValues(env);
  for (const [name, raw] of Object.entries(env)) {
    const value = (raw ?? "").trim();
    if (!name.toUpperCase().startsWith(PUBLIC_PREFIX) || !value) continue;
    const bare = name.slice(PUBLIC_PREFIX.length);
    const upper = bare.toUpperCase();
    if (SERVER_ONLY_VARS.includes(upper) || SECRET_NAME.test(upper)) {
      problems.push(`${name}: ${bare} is server-only. Rename it without NEXT_PUBLIC_ (that prefix puts the value in every visitor's browser).`);
      continue;
    }
    const found = findSecrets(value)[0];
    if (found) {
      problems.push(`${name} holds ${found.kind}. NEXT_PUBLIC_ values go to every visitor's browser.`);
      continue;
    }
    const token = value.match(JWT)?.find((t) => jwtPayload(t) && jwtPayload(t)?.role !== "anon");
    if (token) {
      problems.push(`${name} holds a JWT that isn't Supabase's anon key. NEXT_PUBLIC_ values go to every visitor's browser.`);
      continue;
    }
    const same = secrets.find(([, v, taint]) => taint && v === value);
    if (same) {
      problems.push(`${name} has the same value as ${same[0]}, which is server-only.`);
      continue;
    }
    if (name === "NEXT_PUBLIC_SUPABASE_ANON_KEY" && !isPublicSupabaseKey(value)) {
      problems.push(
        `${name} isn't Supabase's public key. Use the "anon" key or the sb_publishable_ key (Supabase → Project Settings → API Keys), never the service_role or sb_secret_ key.`
      );
      continue;
    }
    if (used?.has(name) && !isAllowedPublicName(bare)) {
      problems.push(`${name} is used by the code but isn't on the list of public variables (PUBLIC_VARS in lib/secret-scan.cjs).`);
    }
  }
  return problems;
}

/**
 * NEXT_PUBLIC_ variables that are set but that nothing in the code uses:
 * Next.js leaves them out of the bundle, so they're harmless, but likely
 * left over.
 * @param {Record<string, string | undefined>} env
 * @param {Set<string>} used
 * @returns {string[]}
 */
function envWarnings(env, used) {
  return Object.entries(env)
    .filter(([name, v]) => name.toUpperCase().startsWith(PUBLIC_PREFIX) && (v ?? "").trim())
    .map(([name]) => name)
    .filter((name) => !isAllowedPublicName(name.slice(PUBLIC_PREFIX.length)) && !used.has(name))
    .map((name) => `${name} is set but the code doesn't use it, so it isn't sent to browsers. Remove it if it's left over.`);
}

// ---------- Source code ----------

/** Folders and files Next.js bundles for the browser (and the server). */
const APP_SOURCE = ["app", "components", "lib", "proxy.ts", "middleware.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.ts"];
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Source files under `dir` (relative paths), skipping node_modules and
 * build output.
 * @param {string} root
 * @param {string[]} [entries]
 * @param {RegExp} [match]
 * @returns {string[]}
 */
function sourceFiles(root, entries = APP_SOURCE, match = SOURCE_FILE) {
  const fs = require("node:fs");
  const path = require("node:path");
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(path.join(root, rel))) {
        if (name === "node_modules" || name === ".next" || name === ".git") continue;
        walk(path.posix.join(rel, name));
      }
    } else if (match.test(rel)) out.push(rel);
  };
  entries.forEach(walk);
  return out;
}

/**
 * NEXT_PUBLIC_ names the app's code uses, with the files that use them.
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
function publicVarsInSource(root) {
  const fs = require("node:fs");
  const path = require("node:path");
  /** @type {Map<string, string[]>} */
  const used = new Map();
  for (const file of sourceFiles(root)) {
    if (file === "lib/secret-scan.cjs") continue;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(/\bNEXT_PUBLIC_[A-Za-z0-9_]+/g)) {
      used.set(m[0], [...new Set([...(used.get(m[0]) ?? []), file])]);
    }
  }
  return used;
}

/** Last words of a name that hold a credential: adminPassword, ADMIN_PW, apiKey, accessCode. */
function credentialName(/** @type {string} */ ident) {
  const words = ident
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words[words.length - 1] ?? "";
  const two = words.slice(-2).join(" ");
  return (
    ["password", "passwd", "passcode", "passphrase", "pass", "pwd", "pw", "pin", "secret", "token", "apikey"].includes(last) ||
    ["api key", "access code", "admin code", "secret key", "master key", "private key", "auth code", "admin key"].includes(two)
  );
}

/** A quoted string (4-200 characters) as the named groups q and v. */
const STRING = String.raw`(?<q>["'\x60])(?<v>(?:(?!\k<q>)[^\\\n]|\\.){4,200})\k<q>`;
/** A name, or the last part of a.b.c, as the named group id. */
const IDENT = String.raw`(?<id>[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)(?:\(\))?`;
const CREDENTIAL_PATTERNS = [
  [new RegExp(String.raw`${IDENT}\s*(?:===?|!==?)\s*${STRING}`, "g"), "compared with a fixed string"],
  [new RegExp(String.raw`${STRING}\s*(?:===?|!==?)\s*${IDENT}`, "g"), "compared with a fixed string"],
  [new RegExp(String.raw`\b(?:const|let|var)\s+${IDENT}\s*(?::\s*string\s*)?=\s*${STRING}`, "g"), "set to a fixed string"],
  [new RegExp(String.raw`(?:^|[{,\s])${IDENT}\s*:\s*${STRING}`, "gm"), "set to a fixed string"],
];

/**
 * Hard-coded credentials in code that can reach the browser: a name like
 * password, adminPass, ADMIN_PW or apiKey compared with, or set to, a
 * string literal. That is how the AI-built site in the 2026 MyBroadband
 * story kept its admin password: in the page, readable with dev tools.
 * @param {string} text
 * @returns {{ line: number, what: string }[]}
 */
function credentialLiterals(text) {
  /** @type {{ line: number, what: string }[]} */
  const found = [];
  const lineOf = (/** @type {number} */ i) => text.slice(0, i).split("\n").length;
  // Real values have a digit, a capital or a symbol; UI words like
  // "current-password" or "owner" don't, and neither do templates.
  const secretish = (/** @type {string} */ s) => !/\s/.test(s) && !/^[a-z]+(?:[_-][a-z]+)*$/.test(s) && !s.includes("${");
  for (const [re, what] of /** @type {[RegExp, string][]} */ (CREDENTIAL_PATTERNS)) {
    for (const m of text.matchAll(re)) {
      // password.value, pw.trim(): the name that matters is before those.
      const parts = (m.groups?.id ?? "").split(/\??\./);
      while (parts.length > 1 && /^(?:value|current|trim|toLowerCase|toUpperCase|normalize)$/.test(parts[parts.length - 1])) parts.pop();
      const ident = parts.pop() ?? "";
      if (!credentialName(ident) || !secretish(m.groups?.v ?? "")) continue;
      found.push({ line: lineOf(m.index ?? 0), what: `${ident} ${what}` });
    }
  }
  return found;
}

/**
 * What scripts/check-source.mjs and next.config.ts stop a build for in the
 * code itself: NEXT_PUBLIC_ names not on the public list, hard-coded
 * credentials, and secret keys in app code, public/ or extension/.
 * @param {string} root
 * @returns {{ problems: string[], files: number }}
 */
function sourceProblems(root) {
  const fs = require("node:fs");
  const path = require("node:path");
  /** @type {string[]} */
  const problems = [];
  for (const [name, files] of publicVarsInSource(root)) {
    if (!isAllowedPublicName(name.slice(PUBLIC_PREFIX.length))) {
      problems.push(`${files[0]}: uses ${name}, which isn't on the list of public variables (PUBLIC_VARS in lib/secret-scan.cjs). Every NEXT_PUBLIC_ value the code names is sent to every visitor.`);
    }
  }
  const code = sourceFiles(root);
  for (const file of code) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (file !== "lib/secret-scan.cjs") {
      for (const { line, what } of credentialLiterals(text)) {
        problems.push(`${file}:${line}: ${what}. A password or key in the code can be read in the browser; check it on the server against a value it keeps secret.`);
      }
    }
    for (const { kind, sample } of findSecrets(text)) problems.push(`${file}: ${kind} (${sample})`);
  }
  // public/vendor is third-party code copied in at build time; the post-build
  // scan reads it with everything else browsers download.
  const assets = sourceFiles(root, ["public", "extension"], /\.(?:[cm]?js|json|html?|txt|css|svg|map|xml|webmanifest)$/).filter((f) => !f.startsWith("public/vendor/"));
  for (const file of assets) {
    for (const { kind, sample } of findSecrets(fs.readFileSync(path.join(root, file), "latin1"))) problems.push(`${file}: ${kind} (${sample})`);
  }
  return { problems, files: code.length + assets.length };
}

module.exports = {
  PUBLIC_VARS,
  SECRET_VARS,
  SERVER_ONLY_VARS,
  credentialLiterals,
  envProblems,
  envWarnings,
  findSecrets,
  isAllowedPublicName,
  isPublicSupabaseKey,
  jwtPayload,
  publicVarsInSource,
  serverValues,
  sourceFiles,
  sourceProblems,
};
