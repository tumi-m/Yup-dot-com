/**
 * The video and audio tools as a whole: YouTube's pause covers every route
 * that asks the media worker, and links the downloaders can't take are named.
 */
delete process.env.NEXT_PUBLIC_ENABLE_YOUTUBE;
process.env.MEDIA_WORKER_URL = "https://media.example.test";
process.env.MEDIA_WORKER_SECRET = "media-tools-test";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

// Anything sent to the worker is counted, and answered as a working one would.
let workerCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://media.example.test/")) {
    workerCalls++;
    return Response.json({ id: "PLx", title: "A list", count: 1, entries: [{ id: "aaaaaaaaaaa", title: "One" }] });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" }, body: JSON.stringify(body) });

{
  const playlist = await import("../app/api/media/playlist/route.ts");
  const res = await playlist.POST(post("/api/media/playlist", { url: "https://www.youtube.com/playlist?list=PLabcdefghij12345" }));
  const body = await res.json();
  check("while YouTube is paused, playlists aren't listed either", res.status === 503 && /paused/.test(body.error), JSON.stringify(body));
  check("and the worker is never asked", workerCalls === 0, `${workerCalls} calls`);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
