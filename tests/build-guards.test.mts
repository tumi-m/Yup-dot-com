/**
 * The build guards that keep server secrets out of the browser:
 * - lib/secret-scan.cjs: what counts as a secret;
 * - scripts/check-env.mjs (prebuild): no secret in a NEXT_PUBLIC_ variable;
 * - scripts/check-bundle-secrets.mjs (postbuild): no secret pattern or
 *   server-only value in what browsers download.
 * The scripts run for real, against a made-up .next and public/ folder.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scan = createRequire(import.meta.url)("../lib/secret-scan.cjs") as typeof import("../lib/secret-scan.cjs");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJlX2Zvcl90ZXN0cw`;
const ANON = jwt({ iss: "supabase", ref: "testproj", role: "anon" });
const SERVICE = jwt({ iss: "supabase", ref: "testproj", role: "service_role" });
const SK_LIVE = "sk_live_" + "4f9a0c1e".repeat(5);
const SB_SECRET = "sb_secret_" + "Q2xvdWRzZWNyZXRrZXk";
const PEM = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" + "A".repeat(40);

// ---------- What counts as a secret ----------
{
  const kinds = (text: string) => scan.findSecrets(text).map((f) => f.kind);
  check("the anon key is public", kinds(`const k="${ANON}"`).length === 0);
  check("a service_role key is a secret", kinds(`const k="${SERVICE}"`).some((k) => /service_role/.test(k)));
  check("sb_secret_ keys are secrets", kinds(`x="${SB_SECRET}"`).length === 1);
  check("Paystack sk_live_ keys are secrets", kinds(`x="${SK_LIVE}"`).length === 1);
  check("and sk_test_ keys", kinds(`x="sk_test_${"ab12".repeat(10)}"`).length === 1);
  check("pk_live_ keys are public", kinds(`x="pk_live_${"ab12".repeat(10)}"`).length === 0);
  check("a private key is a secret", kinds(`x="${PEM}"`).length === 1);
  check("a PEM header a library uses to parse keys is not", kinds(`x="-----BEGIN PRIVATE KEY-----"`).length === 0);
  check("placeholders and bare prefixes are not", kinds(`"sk_test_xxx" "sb_secret_" startsWith("sk_live_")`).length === 0);
  check("keys cut in two, escaped, joined, base64 or hex encoded are found",
    [
      `x="sk_li"+"ve_${"4f9a0c1e".repeat(5)}"`,
      `x="${SERVICE.slice(0, 20)}"+"${SERVICE.slice(20)}"`,
      `x="${SERVICE.replace(/\./g, "\\u002e")}"`,
      `x=["sk","live","${"4f9a0c1e".repeat(5)}"].join("_")`,
      `x=atob("${Buffer.from(SK_LIVE).toString("base64")}")`,
      `x="${Buffer.from(SK_LIVE).toString("hex")}"`,
      `x="\\u0073k_live_${"4f9a0c1e".repeat(3)}"`,
    ].every((t) => kinds(t).length > 0),
  );
  check("and other services' keys and private key bodies",
    kinds(`"sk-ant-api03-${"Ab1_".repeat(8)}"`).length === 1 && kinds(`"ghp_${"A1b2".repeat(9)}"`).length === 1 &&
      kinds(`"AKIA${"ABCD1234".repeat(2)}"`).length === 1 && kinds(`"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"`).length === 1);
  check("connection strings with a password, not placeholders",
    kinds(`"postgresql://postgres:SuperSecretPw123@db.x.supabase.co"`).length === 1 &&
      kinds(`"postgresql://postgres:[YOUR-PASSWORD]@db.x.supabase.co" "redis://localhost:6379" "postgres://postgres:postgres@localhost"`).length === 0);
  check("images, fonts and hashes in a bundle are not",
    kinds(`a="data:image/png;base64,${Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) % 256)).toString("base64")}";h="${"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}"`).length === 0);
  const sample = scan.findSecrets(`x="${SK_LIVE}"`)[0]?.sample ?? "";
  check("a match is reported without the usable key", sample.length <= 13 && !sample.includes(SK_LIVE.slice(12)), sample);
  check("a role=anon JWT or sb_publishable_ is the public Supabase key",
    scan.isPublicSupabaseKey(ANON) && scan.isPublicSupabaseKey("sb_publishable_abc123") && !scan.isPublicSupabaseKey(SERVICE));
}

// ---------- Build environment ----------
{
  const problems = (env: Record<string, string>) => scan.envProblems(env);
  const fine = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, PAYSTACK_SECRET_KEY: SK_LIVE };
  check("a normal environment passes", problems(fine).length === 0, problems(fine).join("; "));
  check("the publishable key and pk_ keys pass",
    problems({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abc123", NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: "pk_live_" + "ab12".repeat(10) }).length === 0);
  const swapped = problems({ ...fine, NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE });
  check("the service_role key as the anon key fails", swapped.length === 1 && /NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(swapped[0]) && /service_role/.test(swapped[0]), swapped.join("; "));
  check("an sb_secret_ key as the anon key fails", problems({ NEXT_PUBLIC_SUPABASE_ANON_KEY: SB_SECRET }).length === 1);
  check("a Paystack secret key in any NEXT_PUBLIC_ variable fails", problems({ NEXT_PUBLIC_PAYMENTS: SK_LIVE }).length === 1);
  check("a private key in a NEXT_PUBLIC_ variable fails", problems({ NEXT_PUBLIC_CERT: PEM.replace(/\\n/g, "\n") }).length === 1);
  check("a server-only name with NEXT_PUBLIC_ fails, whatever its value", problems({ NEXT_PUBLIC_PAYSTACK_SECRET_KEY: "x" }).length === 1);
  check("so does any NEXT_PUBLIC_ name that says secret", problems({ NEXT_PUBLIC_WEBHOOK_SECRET: "x" }).length === 1);
  check("a NEXT_PUBLIC_ value equal to a server-only one fails",
    problems({ MEDIA_SIGNING_SECRET: "a-long-random-string-1", NEXT_PUBLIC_SIGNING: "a-long-random-string-1" }).length === 1);
  check("an anon key that isn't Supabase's public key fails", problems({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "your-anon-key" }).length === 1);
  check("no message holds a secret's value", !swapped.join(" ").includes(SERVICE.split(".")[1]));

  // The article's mistake and its cousins: whatever the name or encoding.
  const blocked = (env: Record<string, string>) => problems({ ...fine, ...env }).length === 1;
  check("NEXT_PUBLIC_ADMIN_PASS / _PW / _TOKEN fail, whatever their value",
    blocked({ NEXT_PUBLIC_ADMIN_PASS: "Hunter2-PdfWizard!" }) && blocked({ NEXT_PUBLIC_ADMIN_PW: "x" }) && blocked({ NEXT_PUBLIC_ADMIN_TOKEN: "tok_123" }));
  check("an API key, JWT secret or database URL under NEXT_PUBLIC_ fails",
    blocked({ NEXT_PUBLIC_OPENAI_API_KEY: "x" }) && blocked({ NEXT_PUBLIC_SUPABASE_JWT_KEY: "x" }) && blocked({ NEXT_PUBLIC_DATABASE_URL: "x" }));
  check("a server-only name in lower case fails", blocked({ NEXT_PUBLIC_media_worker_url: "https://worker.example" }));
  check("an OpenAI, Resend or webhook key in any NEXT_PUBLIC_ value fails",
    blocked({ NEXT_PUBLIC_A: "sk-proj-" + "Ab1".repeat(10) }) && blocked({ NEXT_PUBLIC_B: "re_AbCdEf12_3456789abcdefghijk" }) && blocked({ NEXT_PUBLIC_C: "whsec_" + "Ab12".repeat(8) }));
  check("a connection string with a password fails", blocked({ NEXT_PUBLIC_DB: "postgresql://postgres:SuperSecretPw123@db.x.supabase.co:5432/postgres" }));
  check("a service_role key in base64 fails", blocked({ NEXT_PUBLIC_SB: Buffer.from(SERVICE).toString("base64") }));
  check("a JWT that isn't the anon key fails", blocked({ NEXT_PUBLIC_K: jwt({ iss: "supabase", aud: "authenticated", sub: "u1" }) }));
  const used = new Set(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_ADMIN_CODE"]);
  check("a NEXT_PUBLIC_ variable the code uses but isn't listed fails",
    scan.envProblems({ ...fine, NEXT_PUBLIC_ADMIN_CODE: "4821" }, used).some((p) => /NEXT_PUBLIC_ADMIN_CODE is used by the code/.test(p)));
  const leftover = { ...fine, NEXT_PUBLIC_APP_URL: "https://pdfwizard.xyz", NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: "pk_live_" + "ab12".repeat(10) };
  check("a leftover NEXT_PUBLIC_ variable nothing uses only warns",
    scan.envProblems(leftover, used).length === 0 && scan.envWarnings(leftover, used).length === 2, scan.envProblems(leftover, used).join("; "));
  check("Vercel's NEXT_PUBLIC_VERCEL_* variables are fine",
    scan.envProblems({ ...fine, NEXT_PUBLIC_VERCEL_URL: "pdf-wizard-abc.vercel.app", NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" }, used).length === 0 &&
      scan.envWarnings({ NEXT_PUBLIC_VERCEL_ENV: "production" }, used).length === 0);
  check("a server copy of the public key isn't treated as a secret",
    problems({ ...fine, SUPABASE_ANON_KEY: ANON }).length === 0 && !scan.serverValues({ SUPABASE_ANON_KEY: ANON }).length);
}

// ---------- Values searched for and tainted ----------
{
  const values = scan.serverValues({
    ADMIN_PASSWORD: "Tumelo@2026",
    DATABASE_URL: "postgresql://postgres:LongDbPassw0rd@db.x.supabase.co:5432/postgres",
    RESEND_KEY: "re_123abcDE_4567890abcdefghij",
    SUPABASE_JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
    PAYSTACK_PLAN_PRO: "PLN_abc123def",
    OLLAMA_HOST: "https://ollama.com",
    TOKEN_HEADER: "authorization",
    PWD: "/vercel/path0",
    npm_package_scripts_check_secrets: "node scripts/check-bundle-secrets.mjs",
  });
  const names = (taint: boolean) => values.filter(([, , t]) => t === taint).map(([n]) => n).sort().join(",");
  check("short passwords, *_KEY names and connection strings are secrets (searched and tainted)",
    names(true) === "ADMIN_PASSWORD,DATABASE_URL,DATABASE_URL (its password),RESEND_KEY,SUPABASE_JWT_SECRET", names(true));
  check("server settings are searched for but not tainted, and plain words, paths and npm's variables are skipped",
    names(false) === "OLLAMA_HOST,PAYSTACK_PLAN_PRO", names(false));
}

// ---------- The scripts, for real ----------
const root = new URL("..", import.meta.url).pathname;
const run = (script: string, cwd: string, env: Record<string, string>, args: string[] = []) => {
  const r = spawnSync(process.execPath, [join(root, "scripts", script), ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

{
  const empty = mkdtempSync(join(tmpdir(), "env-check-"));
  const ok = run("check-env.mjs", empty, { NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
  check("prebuild: passes with the anon key", ok.code === 0, ok.out);
  const bad = run("check-env.mjs", empty, { NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE });
  check("prebuild: stops the build with the service_role key", bad.code === 1 && /Build stopped/.test(bad.out) && /NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(bad.out), bad.out);
  check("prebuild: and doesn't print it", !bad.out.includes(SERVICE.split(".")[1]));
  writeFileSync(join(empty, ".env.local"), "NEXT_PUBLIC_PAYSTACK_SECRET_KEY=sk_test_x\n");
  const dotenv = run("check-env.mjs", empty, {});
  check("prebuild: reads .env files like next build does", dotenv.code === 1 && /NEXT_PUBLIC_PAYSTACK_SECRET_KEY/.test(dotenv.out), dotenv.out);
  rmSync(empty, { recursive: true, force: true });
}

{
  const dir = mkdtempSync(join(tmpdir(), "bundle-check-"));
  const chunk = join(dir, ".next", "static", "chunks", "app.js");
  mkdirSync(join(dir, ".next", "static", "chunks"), { recursive: true });
  mkdirSync(join(dir, ".next", "server", "app"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  const env = { NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: "service_value_7Hk2", PAYSTACK_SECRET_KEY: "paystack_value_9Qz1", MEDIA_SIGNING_SECRET: "signing_value_3Vb8" };
  const clean = `const url="https://x.supabase.co",key="${ANON}";`;
  writeFileSync(chunk, clean);
  writeFileSync(join(dir, "public", "robots.txt"), "User-agent: *\n");
  writeFileSync(join(dir, ".next", "server", "app", "index.html"), "<html>hi</html>");

  let r = run("check-bundle-secrets.mjs", dir, env, ["--canary"]);
  check("postbuild: a clean build passes", r.code === 0 && /no server secret/.test(r.out), r.out);

  writeFileSync(chunk, clean + `const pay="${SK_LIVE}";`);
  r = run("check-bundle-secrets.mjs", dir, env);
  check("postbuild: an sk_live_ key in client code fails the build", r.code === 1 && /chunks\/app\.js: a Paystack/.test(r.out), r.out);

  writeFileSync(chunk, clean);
  writeFileSync(join(dir, "public", "config.json"), JSON.stringify({ k: env.PAYSTACK_SECRET_KEY }));
  r = run("check-bundle-secrets.mjs", dir, env);
  check("postbuild: a server-only value in public/ fails the build", r.code === 1 && /public\/config\.json: the value of PAYSTACK_SECRET_KEY/.test(r.out), r.out);
  rmSync(join(dir, "public", "config.json"));

  writeFileSync(join(dir, ".next", "server", "app", "index.html"), `<script>self.__next_f.push(["${SERVICE}"])</script>`);
  r = run("check-bundle-secrets.mjs", dir, env);
  check("postbuild: a service_role key in a prerendered page fails the build", r.code === 1 && /index\.html: a Supabase key with role "service_role"/.test(r.out), r.out);
  writeFileSync(join(dir, ".next", "server", "app", "index.html"), "<html>hi</html>");

  writeFileSync(chunk, `const url="https://x.supabase.co";`);
  r = run("check-bundle-secrets.mjs", dir, env);
  check("postbuild: a search that can't find the public key doesn't pass", r.code === 1 && /Positive control/.test(r.out), r.out);

  r = run("check-bundle-secrets.mjs", dir, { NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON }, ["--canary"]);
  check("--canary: refuses to run without fake secrets", r.code === 2, r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
