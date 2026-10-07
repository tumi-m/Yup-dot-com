/**
 * Media download refunds (lib/media-refund.ts): a grant is given back once,
 * a refunded grant is dead, and YouTube refunds follow the worker's record of
 * the grant (failed, never used, or worker unreachable), never a download
 * that finished or is still running.
 */
import { askWorker, grantRef, newGrantRef, REFUNDABLE, refundGrant, wasRefunded, MEDIA_BUCKET } from "../lib/media-refund.ts";
import { consumeDaily, memoryUsageStore } from "../lib/usage.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

// Grant references.
{
  const c = newGrantRef();
  check("new grant refs are random and URL-safe", /^[\w-]{16}$/.test(c) && c !== newGrantRef(), c);
  check("grantRef reads s and c", JSON.stringify(grantRef({ s: "ip:abc", c, u: "x" })) === JSON.stringify({ s: "ip:abc", c }));
  check("grantRef rejects old or odd grants", grantRef({ u: "x" }) === null && grantRef({ s: "ip:a", c: "../../x" }) === null && grantRef(null) === null);
}

// Refund once, then the grant is dead.
{
  const store = memoryUsageStore();
  const subject = "ip:guest";
  for (let i = 0; i < 5; i++) await consumeDaily(subject, MEDIA_BUCKET, 5, store);
  check("guest has used all 5", (await consumeDaily(subject, MEDIA_BUCKET, 5, store)) === -1);
  const ref = { s: subject, c: newGrantRef() };
  check("not refunded yet", !(await wasRefunded(store, ref)));
  check("first refund gives the download back", (await refundGrant(store, ref)) === true && (await store.count(subject, MEDIA_BUCKET, "day")) === 4);
  check("second refund of the same grant does nothing", (await refundGrant(store, ref)) === false && (await store.count(subject, MEDIA_BUCKET, "day")) === 4);
  check("refunded grant is marked dead", await wasRefunded(store, ref));
  check("the guest can download again", (await consumeDaily(subject, MEDIA_BUCKET, 5, store)) === 0);
  const other = { s: "ip:someone-else", c: ref.c };
  check("refund bookkeeping is per subject", !(await wasRefunded(store, other)));
}

// The worker decides YouTube refunds.
{
  const fake = (status: number, body: unknown, throws = false) => {
    const calls: { url: string; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (throws) throw new TypeError("fetch failed");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { f, calls };
  };
  const ask = (status: number, body: unknown, throws = false) => {
    const x = fake(status, body, throws);
    return askWorker("https://w.test", "sek", "ref-12345678", x.f).then((v) => ({ v, calls: x.calls }));
  };
  const failed = await ask(200, { used: true, status: "error", error: "Cancelled." });
  check("job failed or cancelled → refund", failed.v === "failed" && REFUNDABLE.includes(failed.v));
  check("asks /refs/<ref> with the shared secret", failed.calls[0].url === "https://w.test/refs/ref-12345678" && failed.calls[0].auth === "Bearer sek");
  check("job ready → no refund", (await ask(200, { used: true, status: "ready" })).v === "used");
  check("job still running → no refund", (await ask(200, { used: true, status: "working" })).v === "used");
  check("grant never used → refund", (await ask(404, { used: false })).v === "unused");
  check("old worker without /refs → no refund", (await ask(404, { error: "Not found." })).v === "unknown");
  check("worker down → refund", (await ask(0, null, true)).v === "unreachable");
  check("sleeping host (HTML) → refund", (await ask(503, "<html>waking up</html>")).v === "unreachable");
  check("worker rejects our secret (so it rejected the job too) → refund", (await ask(401, { error: "Unauthorized." })).v === "unreachable");
  check("anything else → no refund", !REFUNDABLE.includes((await ask(500, { error: "x" })).v));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
