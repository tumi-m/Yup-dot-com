// The Free plan's 50 MB file limit wasn't applied to the cloud library: the
// dashboard didn't check it and the documents bucket allows Pro's 500 MB, so
// a Free account could store a 60 MB file. The dashboard now checks it before
// uploading, and the database refuses larger rows and files on Free
// (behaviour: tests/rls/rls.test.sql, which needs Postgres). This keeps the
// pieces in step with lib/limits.ts.
import { readFileSync } from "node:fs";
import { LIMITS } from "../lib/limits.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const schema = read("supabase/schema.sql");
const migration = read("supabase/migrations/20261018000000_free_file_size.sql");
const fn = (sql: string, name: string) => {
  const m = sql.match(new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`));
  return m ? m[0] : "";
};

for (const name of ["documents_limit", "documents_file_size"]) {
  const body = fn(schema, name);
  const sizes = [...body.matchAll(/> (\d+)/g)].map((m) => Number(m[1]));
  check(`${name}: Free's limit is lib/limits.ts's`, sizes.length > 0 && sizes.every((n) => n === LIMITS.free.maxFileBytes), sizes);
  check(`${name}: only on Free`, /effective_plan\([^)]*\) = 'free'/.test(body));
  check(`${name}: the migration matches schema.sql`, body !== "" && fn(migration, name) === body);
}
check("the file check is a trigger on stored files",
  /create trigger documents_file_size\s+before insert or update on storage\.objects/.test(schema) &&
    /create trigger documents_file_size\s+before insert or update on storage\.objects/.test(migration));
const bucket = schema.match(/set file_size_limit = (\d+)/);
check("the bucket allows Pro's limit", Number(bucket?.[1]) === LIMITS.pro.maxFileBytes, bucket?.[1]);

// The dashboard checks the size before it adds the document.
const dashboard = read("components/DashboardClient.tsx");
const sizeCheck = dashboard.indexOf("file.size > limitsFor(plan).maxFileBytes");
check("the dashboard checks the plan's file size before uploading",
  sizeCheck > 0 && sizeCheck < dashboard.indexOf(".insert(") && /reason="file-size"/.test(dashboard));

// The RLS tests cover it.
const rls = read("tests/rls/rls.test.sql");
check("the RLS tests try a 60 MB row and file on Free",
  /D: a 60 MB document on Free/.test(rls) && /D: a 60 MB file, whatever its row/.test(rls));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Free file size checks passed.");
