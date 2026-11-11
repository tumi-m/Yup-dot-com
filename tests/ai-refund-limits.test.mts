// Chat with PDF: a question that gets no answer text gives back the visitor's
// daily allowance (the first few a day), but not the per-minute burst or the
// site-wide day. Those bound calls to the model, which did the work either
// way; if they were given back too, a loop of stopped or empty questions
// would never hit them. When the model was never reached, the site-wide day
// is given back as well.
import net from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// The route loads lib/usage.ts through require(); so must this test, or it
// would get a second copy whose store the route never sees.
const usage = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");
const { memoryUsageStore, setUsageStore } = usage;
// A fixed time, so a run never straddles a minute and splits the burst.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 10);

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

// A local Ollama: EMPTY finishes without writing anything, WAIT stalls so the
// question can be stopped before the first word.
let calls = 0;
const ollama = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    calls++;
    const last: string = JSON.parse(body).messages.at(-1).content;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const w = (o: object) => res.write(JSON.stringify(o) + "\n");
    if (last.includes("WAIT")) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!res.destroyed) w({ message: { role: "assistant", content: "Late." }, done: true, done_reason: "stop" });
    } else {
      w({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
    }
    res.end();
  });
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
process.env.OLLAMA_HOST = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
delete process.env.OLLAMA_API_KEY;
process.env.AI_GUEST_DAILY_LIMIT = "3";

const route = await import("../app/api/ai/chat/route.ts");

async function ask(ip: string, question: string, signal?: AbortSignal) {
  const res = await route.POST(
    new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ documentName: "doc.pdf", documentText: "[Page 1]\nQuarterly report.", messages: [{ role: "user", content: question }] }),
      signal,
    })
  );
  let text = "";
  try {
    text = await res.text();
  } catch {
    // Stopped.
  }
  const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; reason?: string });
  return { status: res.status, events };
}
const remaining = async (ip: string) =>
  (await (await route.GET(new Request("http://localhost/api/ai/chat", { headers: { "x-forwarded-for": ip } }))).json()).remaining as number;

{
  // Burst: two a minute. Two unanswered questions still use them up.
  process.env.AI_BURST_PER_MINUTE = "2";
  setUsageStore(memoryUsageStore(() => T0));
  const ip = "192.0.2.81";
  const start = await remaining(ip);

  const empty = await ask(ip, "EMPTY please");
  const stop = new AbortController();
  const stopping = ask(ip, "WAIT please", stop.signal);
  await new Promise((r) => setTimeout(r, 300));
  stop.abort();
  const stopped = await stopping;
  await new Promise((r) => setTimeout(r, 200));
  check("unanswered questions reach the model", empty.status === 200 && stopped.status === 200 && calls === 2, { empty: empty.status, stopped: stopped.status, calls });
  check("and give back the daily allowance", (await remaining(ip)) === start, { start, now: await remaining(ip) });

  const third = await ask(ip, "EMPTY again");
  check("the burst still counts them: the third in a minute is refused", third.status === 429 && third.events[0]?.reason === "burst", third);
  check("without reaching the model", calls === 2, calls);
}
{
  // Site-wide: two a day. Unanswered questions still use them up.
  delete process.env.AI_BURST_PER_MINUTE;
  process.env.AI_GLOBAL_DAILY_LIMIT = "2";
  setUsageStore(memoryUsageStore(() => T0));
  calls = 0;
  const a = await ask("192.0.2.82", "EMPTY please");
  const b = await ask("192.0.2.83", "EMPTY please");
  const c = await ask("192.0.2.84", "EMPTY please");
  check("two unanswered questions site-wide reach the model", a.status === 200 && b.status === 200 && calls === 2, { a: a.status, b: b.status, calls });
  check("the site-wide day still counts them: the third is busy", c.status === 503 && c.events[0]?.reason === "busy", c);
  delete process.env.AI_GLOBAL_DAILY_LIMIT;
}
{
  // Only the first 3 unanswered a day (the guest allowance) are given back.
  setUsageStore(memoryUsageStore(() => T0));
  const ip = "192.0.2.85";
  for (let i = 0; i < 4; i++) await ask(ip, "EMPTY please");
  check("the fourth unanswered question costs an answer", (await remaining(ip)) === 2, await remaining(ip));
}
{
  // Ollama can't be reached: nothing ran, so the site-wide day is given back.
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  const host = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
  process.env.AI_GLOBAL_DAILY_LIMIT = "1";
  const store = memoryUsageStore(() => T0);
  setUsageStore(store);
  const errors = console.error;
  console.error = () => {};
  const a = await ask("192.0.2.86", "hello");
  const b = await ask("192.0.2.87", "hello");
  console.error = errors;
  check("model unreachable: neither question is busy", a.status === 200 && b.status === 200, { a: a.status, b: b.status });
  check("and the site-wide day is given back", (await store.count("site", "ai", "day")) === 0, await store.count("site", "ai", "day"));
  process.env.OLLAMA_HOST = host;
  delete process.env.AI_GLOBAL_DAILY_LIMIT;
}

setUsageStore(null);
ollama.close();
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll refund-limit checks passed.");
