/**
 * Ways a visitor could get downloads past the daily allowance, run against
 * the real route handlers with fake upstreams.
 */
process.env.MEDIA_SIGNING_SECRET = "abuse-test-secret";
import { createRequire } from "node:module";
import { MEDIA_BUCKET } from "../lib/media-refund.ts";
import type { UsageStore } from "../lib/usage.ts";

// The routes load lib/usage.ts through require(); so must this test, or it
// would get a second copy whose store the routes never see.
const { memoryUsageStore, setUsageStore, usageSubject } = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

// A tweet with one video, and a CDN that serves a 5000-byte file, answering
// 416 to a Range past its end. `cdnDown` makes it refuse the file outright.
const SIZE = 5000;
const CDN_URL = "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/a.mp4";
let cdnDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://cdn.syndication.twimg.com/")) {
    return Response.json({
      user: { screen_name: "someone" },
      text: "a clip",
      mediaDetails: [{
        type: "video",
        media_url_https: "https://pbs.twimg.com/x.jpg",
        video_info: { duration_millis: 1000, variants: [{ content_type: "video/mp4", bitrate: 832000, url: CDN_URL }] },
      }],
    });
  }
  if (url.startsWith("https://video.twimg.com/")) {
    if (cdnDown) return new Response("", { status: 403 });
    const start = Number(/bytes=(\d+)-/.exec(new Headers(init.headers).get("range") ?? "")?.[1] ?? 0);
    if (start >= SIZE) return new Response("", { status: 416, headers: { "content-range": `bytes */${SIZE}` } });
    return new Response(new Uint8Array(SIZE - start), { status: start ? 206 : 200, headers: { "content-length": String(SIZE - start) } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const link = await import("../app/api/media/link/route.ts");
const file = await import("../app/api/media/file/route.ts");

const guest = (ip: string) => ({ "content-type": "application/json", "x-forwarded-for": ip });
async function getLink(ip: string) {
  const res = await link.POST(new Request("http://localhost/api/media/link", {
    method: "POST",
    headers: guest(ip),
    body: JSON.stringify({ url: "https://x.com/someone/status/1234567890", kind: "mp4", height: 360 }),
  }));
  return { status: res.status, body: await res.json() };
}
const getFile = (href: string, ip: string, extra: Record<string, string> = {}) =>
  file.GET(new Request(`http://localhost${href}`, { headers: { "x-forwarded-for": ip, ...extra } }));

// A Range past the end made the CDN answer 416, and that failure gave the
// download back; with the CDN address readable in the link, files could be
// had without limit.
{
  const store: UsageStore = memoryUsageStore();
  setUsageStore(store);
  const ip = "203.0.113.7";
  const statuses: number[] = [];
  let last = await getLink(ip);
  for (let i = 0; i < 8 && last.status === 200; i++) {
    const r = await getFile(last.body.href, ip, { range: "bytes=999999-" });
    statuses.push(r.status);
    await r.body?.cancel();
    last = await getLink(ip);
  }
  check("a failed Range request doesn't give the download back", statuses.length === 5 && statuses.every((s) => s === 502), statuses.join(","));
  check("so the 6th link of the day is refused", last.status === 429, String(last.status));

  setUsageStore(memoryUsageStore());
  const fresh = await getLink("203.0.113.8");
  const token = new URL(fresh.body.href, "http://l").searchParams.get("t") ?? "";
  const decoded = token.split(".").map((part) => Buffer.from(part, "base64url").toString("latin1")).join("");
  check("the file link doesn't reveal the CDN address", fresh.status === 200 && !decoded.includes("twimg") && !decoded.includes("a.mp4"), decoded.slice(0, 80));
  const ok = await getFile(fresh.body.href, "203.0.113.8");
  check("the link still downloads the file", ok.status === 200 && (await ok.arrayBuffer()).byteLength === SIZE);
  const tampered = await getFile(fresh.body.href.replace(/t=(.)/, (_: string, c: string) => `t=${c === "A" ? "B" : "A"}`), "203.0.113.8");
  check("a tampered link is refused", tampered.status === 403);
}

// File links are encrypted, not just signed.
{
  const { openToken, sealToken } = await import("../lib/media-server.ts");
  const sealed = sealToken({ u: "https://video.twimg.com/a.mp4" }, "k");
  check("sealed tokens round-trip", openToken<{ u: string }>(sealed, "k")?.u === "https://video.twimg.com/a.mp4");
  check("sealed tokens: wrong key, expired or cut short fail",
    openToken(sealed, "k2") === null && openToken(sealToken({ u: "x" }, "k", -5), "k") === null && openToken(sealed.slice(0, 30), "k") === null);
}

// The CDN refusing a file the visitor never got still gives the download back.
{
  const store = memoryUsageStore();
  setUsageStore(store);
  const ip = "203.0.113.9";
  const got = await getLink(ip);
  const subject = usageSubject(new Request("http://l", { headers: guest(ip) }), null);
  const before = await store.count(subject, MEDIA_BUCKET, "day");
  cdnDown = true;
  const r = await getFile(got.body.href, ip);
  cdnDown = false;
  const after = await store.count(subject, MEDIA_BUCKET, "day");
  check("a CDN refusal is still refunded", r.status === 502 && before === 1 && after === 0, `${r.status} ${before} → ${after}`);
}

setUsageStore(null);
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
