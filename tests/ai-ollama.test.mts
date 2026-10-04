/**
 * Ollama client for the PDF assistant: config, stream parsing across any
 * chunk split (including inside multi-byte characters), reasoning never
 * reaching the user, error mapping, retries, abort, and document fitting.
 * Uses an injected fetch; no network.
 */
import {
  ollamaConfig,
  normalizeHost,
  parseNdjson,
  createThinkFilter,
  streamChat,
  userMessage,
  OllamaError,
  type OllamaConfig,
} from "../lib/ai/ollama.ts";
import { fitDocument } from "../lib/ai/document.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

// ---------- config ----------
check("not configured without a key on Ollama Cloud", ollamaConfig({}) === null);
const cloud = ollamaConfig({ OLLAMA_API_KEY: " k " })!;
check("cloud defaults", cloud.host === "https://ollama.com" && cloud.apiKey === "k" && cloud.model === "deepseek-v4.1-flash" && cloud.think === "low", JSON.stringify(cloud));
check(":cloud tag stripped for ollama.com's API", ollamaConfig({ OLLAMA_API_KEY: "k", OLLAMA_MODEL: "deepseek-v4.1-flash:cloud" })!.model === "deepseek-v4.1-flash");
const self = ollamaConfig({ OLLAMA_HOST: "https://llm.example.com/api/" })!;
check("self-hosted needs no key and keeps its tag", self.host === "https://llm.example.com" && !self.apiKey && self.model === "deepseek-v4.1-flash:cloud");
check("host:port defaults to http", normalizeHost("10.0.0.5") === "http://10.0.0.5:11434" && normalizeHost(":11434") === "http://127.0.0.1:11434");
check("invalid host disables the assistant", ollamaConfig({ OLLAMA_HOST: "ftp://x" }) === null);
check("think override", ollamaConfig({ OLLAMA_API_KEY: "k", OLLAMA_THINK: "false" })!.think === false);
check("other models get their own default", ollamaConfig({ OLLAMA_API_KEY: "k", OLLAMA_MODEL: "gpt-oss:120b" })!.think === undefined);

// ---------- NDJSON parsing ----------
function streamOf(text: string, sizes: number[]) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      let i = 0, k = 0;
      while (i < bytes.length) {
        const n = sizes[k++ % sizes.length];
        c.enqueue(bytes.slice(i, i + n));
        i += n;
      }
      c.close();
    },
  });
}
const lines = [
  { message: { role: "assistant", content: "", thinking: "Let me think 🤔 privately" }, done: false },
  { message: { role: "assistant", content: "\n\nHéllo 🌍 " }, done: false },
  { message: { role: "assistant", content: "wörld (p. 3)" }, done: false },
  { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 9 },
];
const ndjson = lines.map((l) => JSON.stringify(l)).join("\n"); // no trailing newline
let allSplitsOk = true;
for (const sizes of [[1], [2], [3], [5, 1], [7], [64], [4096]]) {
  const out: unknown[] = [];
  for await (const v of parseNdjson(streamOf(ndjson, sizes))) out.push(v);
  if (JSON.stringify(out) !== JSON.stringify(lines)) allSplitsOk = false;
}
check("NDJSON parses identically for every chunk split (incl. inside emoji)", allSplitsOk);

// ---------- <think> filter ----------
const f = createThinkFilter();
const pieces = ["Hi <th", "ink>secret", " stuff</thi", "nk> there <", "b>ok</b>"];
const filtered = pieces.map((p) => f.push(p)).join("") + f.flush();
check("inline <think> blocks removed across splits", filtered === "Hi  there <b>ok</b>", JSON.stringify(filtered));
const g = createThinkFilter();
check("unclosed <think> swallows the rest", g.push("A<think>never closed") + g.flush() === "A");

// ---------- streamChat ----------
type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = () => new Response(streamOf(ndjson + "\n", [3]), { status: 200 });
const cfg: OllamaConfig = { ...cloud };
async function collect(gen: AsyncGenerator<string, { doneReason: string | null }>) {
  let text = "";
  let r = await gen.next();
  while (!r.done) {
    text += r.value;
    r = await gen.next();
  }
  return { text, reason: r.value.doneReason };
}
async function kind(p: Promise<unknown>) {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof OllamaError ? e.kind : `other:${(e as Error).message}`;
  }
}

{
  const { fn, calls } = fakeFetch([ok]);
  const r = await collect(streamChat(cfg, { messages: [{ role: "user", content: "q" }], maxAnswerTokens: 100 }, { fetch: fn }));
  check("answer text only, leading blank lines trimmed, no reasoning", r.text === "Héllo 🌍 wörld (p. 3)" && r.reason === "stop", JSON.stringify(r));
  const body = JSON.parse(String(calls[0].init.body));
  const headers = calls[0].init.headers as Record<string, string>;
  check("request: /api/chat, bearer key, model, stream, think, num_predict",
    calls[0].url === "https://ollama.com/api/chat" && headers.Authorization === "Bearer k" &&
    body.model === "deepseek-v4.1-flash" && body.stream === true && body.think === "low" && body.options.num_predict === 100);
}
{
  const { fn } = fakeFetch([() => new Response('{"error":"unauthorized"}', { status: 401 })]);
  check("401 → auth (no retry)", (await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn })))) === "auth");
  check("auth errors show a generic message, not the key problem", userMessage(new OllamaError("auth", "x")) === "The AI assistant isn't available right now.");
}
{
  const { fn } = fakeFetch([() => new Response('{"error":"model not found"}', { status: 404 })]);
  check("404 → model", (await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn })))) === "model");
}
{
  const { fn, calls } = fakeFetch([() => new Response("busy", { status: 429 })]);
  check("429 → rate_limit, not retried", (await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn })))) === "rate_limit" && calls.length === 1);
}
{
  const { fn, calls } = fakeFetch([() => new Response("oops", { status: 502 }), ok]);
  const r = await collect(streamChat(cfg, { messages: [] }, { fetch: fn, retryDelayMs: 5 }));
  check("5xx retried once, then succeeds", calls.length === 2 && r.text.startsWith("Héllo"));
}
{
  const { fn, calls } = fakeFetch([() => { throw new TypeError("fetch failed"); }, () => { throw new TypeError("fetch failed"); }]);
  check("network failure retried once, then unavailable", (await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn, retryDelayMs: 5 })))) === "unavailable" && calls.length === 2);
}
{
  const { fn } = fakeFetch([() => new Response(streamOf('{"message":{"content":"a"},"done":false}\n{"error":"overloaded"}\n', [8]), { status: 200 })]);
  check("in-stream error → unavailable", (await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn })))) === "unavailable");
}
{
  const { fn } = fakeFetch([() => new Response(streamOf('{"message":{"content":"a"},"done":false}\n', [8]), { status: 200 })]);
  check("stream ending without done → unavailable", (await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn })))) === "unavailable");
}
{
  // A stream that never ends; abort from the caller must cancel upstream.
  let upstreamAborted = false;
  const fn = (async (_u: string, init: RequestInit) => {
    init.signal?.addEventListener("abort", () => (upstreamAborted = true));
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"message":{"content":"x"},"done":false}\n')); } }), { status: 200 });
  }) as unknown as typeof fetch;
  const ac = new AbortController();
  const gen = streamChat(cfg, { messages: [] }, { fetch: fn, signal: ac.signal });
  const first = await gen.next();
  setTimeout(() => ac.abort(), 20);
  const k = await kind(gen.next());
  check("abort cancels upstream and reports aborted", first.value === "x" && k === "aborted" && upstreamAborted, k);
}
{
  const fn = (async (_u: string, init: RequestInit) =>
    new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
  const k = await kind(collect(streamChat(cfg, { messages: [] }, { fetch: fn, idleTimeoutMs: 50 })));
  check("silent stream times out", k === "timeout", k);
}

// ---------- document fitting ----------
const doc = Array.from({ length: 10 }, (_, i) => `[Page ${i + 1}]\n${"x".repeat(100)}`).join("\n\n");
const all = fitDocument(doc, 1_000_000);
check("short document untouched", !all.truncated && all.text === doc && all.totalPages === 10);
const cut = fitDocument(doc, 450);
check("cut at a page boundary", cut.truncated && cut.lastPage === 4 && cut.totalPages === 10 && cut.text.endsWith("x") && !cut.text.includes("[Page 5]") && cut.text.length <= 450, `${cut.lastPage} ${cut.text.length}`);
const tiny = fitDocument(doc, 50);
check("first page over budget is still cut, not dropped", tiny.truncated && tiny.text.length === 50 && tiny.lastPage === 1);
const plain = fitDocument("y".repeat(500), 100);
check("unmarked text cut to budget", plain.truncated && plain.text.length === 100 && plain.lastPage === null);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
