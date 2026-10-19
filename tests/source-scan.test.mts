/**
 * scripts/check-source.mjs (runs before every build): the code itself must
 * not put a secret in the browser. Runs the script on this repository (it
 * must pass) and on made-up projects with the mistakes from the 2026
 * "vibe-coded site" story: an admin password compared in a client
 * component, a key pasted into a lib file or public/, and a NEXT_PUBLIC_
 * variable that isn't on the public list.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "\n" + extra : ""}`);
};

const repo = new URL("..", import.meta.url).pathname;
const run = (dir: string) => {
  const r = spawnSync(process.execPath, [join(repo, "scripts", "check-source.mjs"), dir], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const self = run(repo);
check("this repository passes", self.code === 0 && /Source check: \d+ files/.test(self.out), self.out);

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "source-check-"));
  const all: Record<string, string> = {
    "app/page.tsx": `export default function Page() { return <main>{process.env.NEXT_PUBLIC_SITE_URL}</main>; }\n`,
    "components/login-form.tsx": `"use client";\nexport function LoginForm() {\n  const [password, setPassword] = useState("");\n  return <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />;\n}\n`,
    "lib/site.ts": `export const site = { name: "PDF Wizard", url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000" };\n`,
    "public/robots.txt": "User-agent: *\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const cases: [string, Record<string, string>, RegExp][] = [
  [
    "the article's mistake: an admin password checked in a client component",
    { "components/admin-gate.tsx": `"use client";\nexport function AdminGate({ input }: { input: string }) {\n  if (input === "x") return null;\n  const ok = adminPassword === "Hunter2-PdfWizard!";\n  return ok ? <Admin /> : <Login />;\n}\n` },
    /components\/admin-gate\.tsx:4: adminPassword compared with a fixed string/,
  ],
  [
    "a password kept in a constant",
    { "lib/admin.ts": `export const ADMIN_PASSWORD = "Tumelo@2026";\n` },
    /lib\/admin\.ts:1: ADMIN_PASSWORD set to a fixed string/,
  ],
  [
    "an API key in a config object",
    { "lib/ai-config.ts": `export const ai = { model: "gpt", apiKey: "AIzaSyD4-abc123XYZ987" };\n` },
    /lib\/ai-config\.ts:1: apiKey set to a fixed string/,
  ],
  [
    "a Paystack secret key pasted into code",
    { "lib/pay.ts": `const key = "sk_live_${"4f9a0c1e".repeat(5)}";\nexport default key;\n` },
    /lib\/pay\.ts: a Paystack or Stripe secret key/,
  ],
  [
    "a service_role key, base64-encoded to hide it",
    {
      "lib/db.ts": `export const k = atob("${Buffer.from(
        `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ iss: "supabase", role: "service_role" })).toString("base64url")}.c2lnbmF0dXJl`
      ).toString("base64")}");\n`,
    },
    /lib\/db\.ts: a Supabase key with role "service_role" \(base64-encoded\)/,
  ],
  [
    "a key in a file under public/",
    { "public/config.json": JSON.stringify({ db: "postgresql://postgres:SuperSecretPw123@db.abc.supabase.co:5432/postgres" }) },
    /public\/config\.json: a password in a connection string/,
  ],
  [
    "a NEXT_PUBLIC_ variable that isn't on the public list",
    { "app/admin/page.tsx": `export default function Admin() { return <p>{process.env.NEXT_PUBLIC_ADMIN_CODE}</p>; }\n` },
    /app\/admin\/page\.tsx: uses NEXT_PUBLIC_ADMIN_CODE, which isn't on the list/,
  ],
];

const clean = project({});
const ok = run(clean);
check("a clean made-up project passes (password fields, autocomplete, listed variables)", ok.code === 0, ok.out);
rmSync(clean, { recursive: true, force: true });

for (const [name, files, expected] of cases) {
  const dir = project(files);
  const r = run(dir);
  check(`fails: ${name}`, r.code === 1 && expected.test(r.out) && /Build stopped/.test(r.out), r.out);
  check(`  and doesn't print the value`, !/Hunter2-PdfWizard|Tumelo@2026|SuperSecretPw123|4f9a0c1e4f9a0c1e4f9a/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
