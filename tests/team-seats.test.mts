/**
 * Adding a Team member: the owner hears "All seats are taken." only when the
 * database's seat trigger refused the member (P0001), never for an outage or
 * another database error, which would stop them from trying again.
 */
import { addTeamMember, isSeatsFullError } from "../lib/billing-store.ts";
import { SEAT_ERRORS } from "../lib/billing.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

type DbError = { code?: string; message?: string } | null;
// What supabase-js hands back for an insert into team_members.
const admin = (error: DbError) => ({ from: () => ({ insert: async () => ({ error }) }) });
const add = (error: DbError) => addTeamMember("owner-id", "a@example.test", admin(error)).then(() => null, (err: unknown) => err);

const full = await add({ code: "P0001", message: "All team seats are taken." });
check("the seat trigger's refusal reads as full", isSeatsFullError(full), String(full));
check("and keeps the database's reason in the log", String(full).includes("All team seats are taken."), String(full));

// postgrest-js: a dropped connection, a 503 from the gateway, a PostgREST error.
for (const [what, error] of [
  ["a dropped connection", { code: "", message: "TypeError: fetch failed" }],
  ["a 503 from the gateway", { message: "upstream connect error or disconnect/reset before headers" }],
  ["a PostgREST error", { code: "PGRST301", message: "JWT expired" }],
  ["another constraint", { code: "23514", message: "new row violates check constraint" }],
] as const) {
  const err = await add(error);
  check(`${what} is an error, not "${SEAT_ERRORS.full}"`, err instanceof Error && !isSeatsFullError(err), String(err));
}

check("already on the team is not an error", (await add({ code: "23505", message: "duplicate key" })) === null);
check("added", (await add(null)) === null);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
