/**
 * Cloud library files keep to the plan's file size: Free up to 50 MB, Pro
 * and Team up to 500 MB. The browser checks before uploading, and the
 * database refuses a bigger Free document or file (tests/rls checks the SQL
 * itself on Postgres; this keeps its numbers in step with lib/limits.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { formatLimitBytes, LIMITS } from "../lib/limits.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const free = LIMITS.free.maxFileBytes;
const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
// A new project runs schema.sql; an existing one ends on the newest migration that sets the rule.
for (const path of ["supabase/schema.sql", `supabase/migrations/${migrations.findLast((f) => src(`supabase/migrations/${f}`).includes("documents_file_size"))}`]) {
  const sql = src(path);
  const sizeChecks = [...sql.matchAll(/(?:size_bytes|v_size) > (\d+)/g)].map((m) => Number(m[1]));
  check(`${path}: Free documents and files are capped at ${formatLimitBytes(free)}`,
    sizeChecks.length === 2 && sizeChecks.every((n) => n === free), sizeChecks.join(","));
  check(`${path}: storage checks every write of a file`, /before insert or update on storage\.objects\s+for each row execute function public\.documents_file_size\(\)/.test(sql));
  const messages = [...sql.matchAll(/'Files up to ([^']+) on your plan\.'/g)].map((m) => m[1]);
  check(`${path}: says the limit as the app does`, messages.length === 2 && messages.every((m) => m === formatLimitBytes(free)), messages.join(","));
}
const bucket = Number(/set file_size_limit = (\d+)/.exec(src("supabase/schema.sql"))?.[1]);
check("the bucket allows the Pro and Team file size", bucket === LIMITS.pro.maxFileBytes && bucket === LIMITS.team.maxFileBytes, String(bucket));

// Every page that adds a file to the cloud library checks the plan's file size first.
const uploaders = readdirSync(new URL("../components/", import.meta.url), { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ f, code: src(`components/${f}`) }))
  .filter(({ code }) => /\.from\("documents"\)\s*\.insert\(/.test(code));
check("the library uploads are found", uploaders.length >= 2, uploaders.map((u) => u.f).join(","));
for (const { f, code } of uploaders) {
  const insert = code.search(/\.from\("documents"\)\s*\.insert\(/);
  const sizeCheck = code.search(/\.size > (?:limits\.)?maxFileBytes/);
  check(`${f}: checks the file size before uploading`, sizeCheck !== -1 && sizeCheck < insert);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
