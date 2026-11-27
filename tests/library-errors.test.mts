// The dashboard's upload showed Supabase's words: "TypeError: Failed to
// fetch" when the database couldn't be reached, "Failed to fetch" for
// storage, and "Not authenticated." when the session check couldn't reach
// Supabase (the person was signed in all along). The errors here are the
// ones supabase-js itself makes from each answer.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { LIBRARY_OFFLINE, LIBRARY_SIGNED_OUT, libraryError } from "../lib/library-error.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
console.error = () => {}; // supabase-js logs every failed fetch

type Answer = { status: number; body: unknown } | "offline";
function supabase(answer: Answer) {
  return createClient("http://127.0.0.1:54321", "anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (async () => {
        if (answer === "offline") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    },
  });
}
const DOC = { id: "00000000-0000-4000-8000-000000000001", owner_id: "u", name: "a", storage_path: "u/a.pdf", size_bytes: 1, page_count: 1 };
const insert = async (a: Answer) => libraryError((await supabase(a).from("documents").insert(DOC).select("*").single()).error);
const upload = async (a: Answer) => libraryError((await supabase(a).storage.from("documents").upload("u/a.pdf", new Blob(["%PDF"]))).error);
const user = async (a: Answer) => {
  const { data, error } = await supabase(a).auth.getUser("token");
  return data.user ? null : libraryError(error);
};

check("no connection: the database step says so", (await insert("offline")) === LIBRARY_OFFLINE, await insert("offline"));
check("no connection: the file step says so", (await upload("offline")) === LIBRARY_OFFLINE, await upload("offline"));
check("no connection: the session check isn't 'Not authenticated'", (await user("offline")) === LIBRARY_OFFLINE, await user("offline"));
check("a session Supabase no longer accepts: log in again",
  (await user({ status: 403, body: { code: 403, error_code: "bad_jwt", msg: "invalid JWT" } })) === LIBRARY_SIGNED_OUT);
check("nobody signed in: log in again", libraryError(null) === LIBRARY_SIGNED_OUT);

const limit = "The Free plan keeps 5 documents. Upgrade for more.";
check("the database's own refusal is shown as it is",
  (await insert({ status: 400, body: { code: "P0001", message: limit, details: null, hint: null } })) === limit);
const rls = await insert({ status: 403, body: { code: "42501", message: 'new row violates row-level security policy for table "documents"', details: null, hint: null } });
check("other database errors aren't", rls === "Couldn't save it to your library. Try again.", rls);
const storageRls = await upload({ status: 400, body: { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" } });
check("nor are storage's", storageRls === "Couldn't save it to your library. Try again.", storageRls);

const dash = readFileSync(new URL("../components/DashboardClient.tsx", import.meta.url), "utf8");
check("the dashboard says the document limit as the database does", dash.includes("plan keeps ${maxDocuments} documents. Upgrade for more.") && !/on the \$\{plan\} plan/.test(dash));
check("and no longer says 'Not authenticated.'", !dash.includes("Not authenticated."));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll library error checks passed.");
