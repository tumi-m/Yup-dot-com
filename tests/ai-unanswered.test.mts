// Chat with PDF: a question that gets no answer text costs nothing. The
// browser lowers "N left today" only once text arrives, so the server must
// refund every turn that delivered none: a stream error, a stop before the
// first word, or a model that finished without writing anything.
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// The route loads lib/usage.ts through require(); so must this test, or it
// would get a second copy whose store the route never sees.
const { memoryUsageStore, setUsageStore } = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

// A local Ollama that answers according to the question.
const ollama = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const last: string = JSON.parse(body).messages.at(-1).content;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const w = (o: object) => res.write(JSON.stringify(o) + "\n");
    if (last.includes("STREAMERR")) w({ error: "model crashed" });
    else if (last.includes("EMPTY")) w({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
    else if (last.includes("WAIT")) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!res.destroyed) w({ message: { role: "assistant", content: "Late." }, done: true, done_reason: "stop" });
    } else {
      w({ message: { role: "assistant", content: "It is a report " }, done: false });
      w({ message: { role: "assistant", content: "(p. 1)." }, done: true, done_reason: "stop" });
    }
    res.end();
  });
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
process.env.OLLAMA_HOST = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
delete process.env.OLLAMA_API_KEY;
setUsageStore(memoryUsageStore());

const route = await import("../app/api/ai/chat/route.ts");
const ip = { "x-forwarded-for": "192.0.2.77" };
const remaining = async () => (await (await route.GET(new Request("http://localhost/api/ai/chat", { headers: ip }))).json()).remaining as number;

async function ask(question: string, signal?: AbortSignal) {
  const res = await route.POST(
    new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { ...ip, "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ documentName: "doc.pdf", documentText: "[Page 1]\nQuarterly report.", messages: [{ role: "user", content: question }] }),
      signal,
    })
  );
  const events: { type: string; text?: string; message?: string }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } catch {
    // Stopped.
  }
  for (const line of buffer.split("\n")) if (line) events.push(JSON.parse(line));
  return { status: res.status, left: res.headers.get("x-ai-remaining"), events };
}

const start = await remaining();
check("a guest starts with answers left", start > 1, start);

const answered = await ask("Summarize");
check("an answer streams text", answered.events.some((e) => e.type === "text" && e.text));
check("and costs one turn", (await remaining()) === start - 1 && answered.left === String(start - 1), { left: answered.left });

const crashed = await ask("STREAMERR please");
check("a stream error says so", crashed.events.some((e) => e.type === "error") && !crashed.events.some((e) => e.type === "text"), crashed.events);
check("and is refunded", (await remaining()) === start - 1);

const empty = await ask("EMPTY please");
check("an empty answer is an error, not silence", empty.events.some((e) => e.type === "error" && e.message), empty.events);
check("and is refunded", (await remaining()) === start - 1);

// Stopped before the first word: the browser hangs up, the request's signal aborts.
const stop = new AbortController();
const stopped = ask("WAIT please", stop.signal);
await new Promise((r) => setTimeout(r, 300));
stop.abort();
await stopped;
await new Promise((r) => setTimeout(r, 200));
check("stopping before the first word is refunded", (await remaining()) === start - 1);

setUsageStore(null);
ollama.close();
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll unanswered-question checks passed.");
