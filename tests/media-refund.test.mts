/**
 * Media download refunds (lib/media-refund.ts): a grant is given back once,
 * a refunded grant is dead, and YouTube refunds follow the worker's record of
 * the grant (failed, never used, or worker unreachable), never a download
 * that finished or is still running.
 */
import {
  askWorker,
  grantRef,
  newGrantRef,
  REFUNDABLE,
  refundGrant,
  refundUnserved,
  startServing,
  wasRefunded,
  MEDIA_BUCKET,
} from "../lib/media-refund.ts";
import { signingSecret, signToken, verifyToken } from "../lib/media-server.ts";
import { consumeDaily, memoryUsageStore } from "../lib/usage.ts";

const results: boolean[] = [];
const now = () => Math.floor(Date.now() / 1000);
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

// Grant references.
{
  const c = newGrantRef();
  check("new grant refs are random and URL-safe", /^[\w-]{16}$/.test(c) && c !== newGrantRef(), c);
  check("grantRef reads s, c and t", JSON.stringify(grantRef({ s: "ip:abc", c, t: 1700000000, u: "x" })) === JSON.stringify({ s: "ip:abc", c, t: 1700000000 }));
  check("grantRef rejects old or odd grants",
    grantRef({ u: "x" }) === null && grantRef({ s: "ip:a", c: "../../x", t: 1 }) === null && grantRef({ s: "ip:a", c }) === null && grantRef(null) === null);
}

// Refund once, then the grant is dead.
{
  const store = memoryUsageStore();
  const subject = "ip:guest";
  for (let i = 0; i < 5; i++) await consumeDaily(subject, MEDIA_BUCKET, 5, store);
  check("guest has used all 5", (await consumeDaily(subject, MEDIA_BUCKET, 5, store)) === -1);
  const ref = { s: subject, c: newGrantRef(), t: now() };
  check("not refunded yet", !(await wasRefunded(store, ref)));
  check("first refund gives the download back", (await refundGrant(store, ref)) === true && (await store.count(subject, MEDIA_BUCKET, "day")) === 4);
  check("second refund of the same grant does nothing", (await refundGrant(store, ref)) === false && (await store.count(subject, MEDIA_BUCKET, "day")) === 4);
  check("refunded grant is marked dead", await wasRefunded(store, ref));
  check("the guest can download again", (await consumeDaily(subject, MEDIA_BUCKET, 5, store)) === 0);
  const other = { ...ref, s: "ip:someone-else" };
  check("refund bookkeeping is per subject", !(await wasRefunded(store, other)));
}

// The worker decides YouTube refunds.
{
  const fake = (status: number, body: unknown, throws = false) => {
    const calls: { url: string; method?: string; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, auth: new Headers(init?.headers).get("authorization") });
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
  check("voids the grant at /refs/<ref>/void with the shared secret",
    failed.calls[0].url === "https://w.test/refs/ref-12345678/void" && failed.calls[0].method === "POST" && failed.calls[0].auth === "Bearer sek");
  check("job ready → no refund", (await ask(200, { used: true, status: "ready" })).v === "used");
  check("job still running → no refund", (await ask(200, { used: true, status: "working" })).v === "used");
  check("grant never used (now void) → refund", (await ask(200, { used: false })).v === "unused");
  check("old worker that can't void grants → no refund",
    (await ask(404, { error: "Not found." })).v === "unknown" && (await ask(404, { used: false })).v === "unknown");
  check("worker down → refund", (await ask(0, null, true)).v === "unreachable");
  check("sleeping host (HTML) → refund", (await ask(503, "<html>waking up</html>")).v === "unreachable");
  check("worker rejects our secret (so it rejected the job too) → refund", (await ask(401, { error: "Unauthorized." })).v === "unreachable");
  check("anything else → no refund", !REFUNDABLE.includes((await ask(500, { error: "x" })).v));
}

// A grant that sent its file is never refunded (download, then ask again with
// a Range past the end so X answers 416: that used to reset the quota).
{
  const store = memoryUsageStore();
  const subject = "ip:attacker";
  const used = () => store.count(subject, MEDIA_BUCKET, "day");
  await consumeDaily(subject, MEDIA_BUCKET, 5, store);
  const ref = { s: subject, c: newGrantRef(), t: now() };
  const serve = await startServing(store, ref);
  check("first send of a grant", serve.ok && serve.first);
  check("a second send is not the first", (await startServing(store, ref)).first === false);
  check("no refund after the file was sent", (await refundUnserved(store, ref)) === false && (await used()) === 1);
  check("grant still usable after a refused refund", !(await wasRefunded(store, ref)));

  const unsent = { s: subject, c: newGrantRef(), t: now() };
  await consumeDaily(subject, MEDIA_BUCKET, 5, store);
  check("a grant that never sent is refunded", (await refundUnserved(store, unsent)) === true && (await used()) === 1);
  check("and can't send afterwards", (await startServing(store, unsent)).ok === false);

  // Race: the refund checks before the send marks, the send checks before
  // the refund lands. One of them must lose.
  const raced = { s: subject, c: newGrantRef(), t: now() };
  await consumeDaily(subject, MEDIA_BUCKET, 5, store);
  const before = await used();
  let marked = false;
  const racing = { ...store, async count(...a: Parameters<typeof store.count>) {
    const n = await store.count(...a);
    // The send marks itself right after the refund's first look.
    if (a[1].startsWith("media-served:") && !marked) {
      marked = true;
      await startServing(store, raced);
    }
    return n;
  } };
  const refunded = await refundUnserved(racing, raced);
  check("racing refund loses to a send in flight", refunded === false && (await used()) === before);
}

// X file links and media worker grants use different keys, so one can't be
// passed off as the other (an X link "refunded" through /api/media/refund).
{
  const env = { MEDIA_WORKER_SECRET: "worker-secret" } as NodeJS.ProcessEnv;
  const xKey = signingSecret(env);
  check("X link key is not the worker secret", xKey !== "worker-secret" && xKey.length >= 32);
  const xToken = signToken({ u: "https://video.twimg.com/a.mp4", s: "ip:a", c: "abcdefgh" }, xKey);
  check("an X link doesn't verify as a worker grant", verifyToken(xToken, "worker-secret") === null);
  const workerToken = signToken({ u: "https://youtu.be/x", s: "ip:a", c: "abcdefgh" }, "worker-secret");
  check("a worker grant doesn't verify as an X link", verifyToken(workerToken, xKey) === null);
  check("MEDIA_SIGNING_SECRET wins", signingSecret({ ...env, MEDIA_SIGNING_SECRET: "s" } as NodeJS.ProcessEnv) !== xKey);
  const none = signingSecret({} as NodeJS.ProcessEnv);
  check("no secret: a random key, not a constant", none.length >= 32 && none !== "pdf-wizard-unsigned-default");
  check("no secret: a forged link with the old default fails",
    verifyToken(signToken({ u: "https://video.twimg.com/a.mp4" }, "pdf-wizard-unsigned-default"), none) === null);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
