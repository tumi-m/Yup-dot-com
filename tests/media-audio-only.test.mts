/**
 * An MP3 from a post whose only file is above the visitor's plan: the free
 * tier is video up to 720p, so the link must carry the sound alone, never
 * the 1080p video. Run against the real route handlers with a fake X.
 */
process.env.MEDIA_SIGNING_SECRET = "audio-only-test-secret";
import { createRequire } from "node:module";

// The routes load these through require(); so must this test, or it would
// get second copies the routes never see.
const require = createRequire(import.meta.url);
const { memoryUsageStore, setUsageStore } = require("../lib/usage.ts") as typeof import("../lib/usage.ts");
const {
  ALL_FORMATS, BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink,
  EncodedVideoPacketSource, Input, Mp4OutputFormat, Output,
} = require("mediabunny") as typeof import("mediabunny");
const { audioOnlyMp4, NoAudioError } = require("../lib/audio-only.ts") as typeof import("../lib/audio-only.ts");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
// Decoder configs of a real 1080p H.264 + AAC clip; the frames are stand-ins (nothing here decodes).
const AVCC = hex("0164002affe1001b6764002aacd940780227e5c044000003000400000301e03c60c65801000568eaecb22cfdf8f800");
const ASC = hex("119056e500");

/** A 2-second MP4 at `w`x`h` with AAC sound (or none). */
async function clip(w: number, h: number, sound = true): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const video = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(video);
  const audio = sound ? new EncodedAudioPacketSource("aac") : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  const fps = 30;
  let heard = 0;
  for (let i = 0; i < 2 * fps; i++) {
    // A big frame, so a video track shows in the size too.
    const frame = new Uint8Array(4000).fill(i % 30 === 0 ? 0x65 : 0x41);
    await video.add(new EncodedPacket(frame, i % 30 === 0 ? "key" : "delta", i / fps, 1 / fps),
      i ? undefined : { decoderConfig: { codec: "avc1.64002a", codedWidth: w, codedHeight: h, description: AVCC } });
    for (; audio && heard * 1024 <= ((i + 1) / fps) * 48_000; heard++) {
      await audio.add(new EncodedPacket(new Uint8Array([0x21, heard & 255, 7]), "key", (heard * 1024) / 48_000, 1024 / 48_000),
        heard ? undefined : { decoderConfig: { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2, description: ASC } });
    }
  }
  await output.finalize();
  return new Uint8Array(target.buffer!);
}

async function tracks(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const video = await input.getVideoTracks();
  const audio = await input.getPrimaryAudioTrack();
  let audioPackets = 0;
  if (audio) for await (const _ of new EncodedPacketSink(audio).packets(undefined, undefined, { metadataOnly: true })) audioPackets++;
  const out = {
    video: video.map((v) => `${v.codedWidth}x${v.codedHeight}`),
    audio: audio ? await audio.getCodec() : null,
    audioPackets,
  };
  input.dispose();
  return out;
}

const FILES: Record<string, Uint8Array> = {
  "1920x1080/full.mp4": await clip(1920, 1080),
  "1080x1920/tall.mp4": await clip(1080, 1920),
  "640x360/small.mp4": await clip(640, 360),
};
const cdn = (path: string) => `https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/${path}?tag=12`;
const V = (path: string, bitrate: number) => ({ content_type: "video/mp4", bitrate, url: cdn(path) });
const POSTS: Record<string, ReturnType<typeof V>[]> = {
  // Only a 1080p file, as X, TikTok and Instagram often have.
  "9000000001": [V("1920x1080/full.mp4", 10_368_000)],
  "9000000002": [V("1080x1920/tall.mp4", 10_368_000)],
  // A small file too: the MP3 comes from it, as before.
  "9000000003": [V("1920x1080/full.mp4", 10_368_000), V("640x360/small.mp4", 832_000)],
};
let cdnDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "cdn.syndication.twimg.com") {
    const variants = POSTS[url.searchParams.get("id") ?? ""];
    if (!variants) return new Response("", { status: 404 });
    return Response.json({
      user: { screen_name: "tester" },
      text: "a clip",
      mediaDetails: [{ type: "video", media_url_https: "https://pbs.twimg.com/x.jpg", video_info: { duration_millis: 2000, variants } }],
    });
  }
  if (url.hostname === "api.fxtwitter.com" || url.hostname === "api.vxtwitter.com") return new Response("", { status: 404 });
  if (url.hostname === "video.twimg.com") {
    const body = FILES[url.pathname.split("/").slice(-2).join("/")];
    if (cdnDown || !body) return new Response("", { status: 403 });
    const m = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers).get("range") ?? "");
    if (!m) return new Response(body.slice(), { headers: { "content-length": String(body.length) } });
    const start = +m[1], end = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${body.length}` },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const link = await import("../app/api/media/link/route.ts");
const file = await import("../app/api/media/file/route.ts");

const headers = (ip: string) => ({ "content-type": "application/json", "x-forwarded-for": ip });
async function getLink(ip: string, id: string, kind: "mp3" | "mp4", height?: number) {
  const res = await link.POST(new Request("http://localhost/api/media/link", {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({ url: `https://x.com/tester/status/${id}`, kind, height }),
  }));
  return { status: res.status, body: await res.json() };
}
async function getFile(href: string, ip: string) {
  const res = await file.GET(new Request(`http://localhost${href}`, { headers: { "x-forwarded-for": ip } }));
  return { status: res.status, type: res.headers.get("content-type"), bytes: new Uint8Array(await res.arrayBuffer()) };
}

setUsageStore(memoryUsageStore());

// The bug: a guest asked for an MP3 and was handed the whole 1080p MP4.
for (const [id, what] of [["9000000001", "landscape"], ["9000000002", "portrait"]] as const) {
  const ip = id === "9000000001" ? "203.0.113.20" : "203.0.113.21";
  const mp4 = await getLink(ip, id, "mp4", 720);
  check(`${what} 1080p only: MP4 is Pro`, mp4.status === 403 && mp4.body.upgrade === true, JSON.stringify(mp4));
  const mp3 = await getLink(ip, id, "mp3");
  check(`${what} 1080p only: MP3 is still offered`, mp3.status === 200 && mp3.body.mode === "convert", JSON.stringify(mp3));
  const got = await getFile(mp3.body.href, ip);
  const t = await tracks(got.bytes);
  const source = await tracks(FILES[id === "9000000001" ? "1920x1080/full.mp4" : "1080x1920/tall.mp4"]);
  check(`${what}: the MP3 link serves no video track`, got.status === 200 && t.video.length === 0, `${got.status} ${JSON.stringify(t)}`);
  check(`${what}: only the sound, all of it`, got.type === "audio/mp4" && t.audio === "aac" && t.audioPackets === source.audioPackets && t.audioPackets > 0,
    `${got.type} ${JSON.stringify(t)} vs ${JSON.stringify(source)}`);
}

// A post with a file within the plan: the MP3 comes from that file, unchanged.
{
  const ip = "203.0.113.22";
  const mp3 = await getLink(ip, "9000000003", "mp3");
  const got = await getFile(mp3.body.href, ip);
  const t = await tracks(got.bytes);
  check("a small file within the plan is still sent as is", got.status === 200 && got.type === "video/mp4" && t.video.join() === "640x360" && t.audio === "aac",
    `${got.status} ${got.type} ${JSON.stringify(t)}`);
}

// The CDN refuses the file: the download is given back, as for a video.
{
  const ip = "203.0.113.23";
  const first = await getLink(ip, "9000000001", "mp3");
  cdnDown = true;
  const got = await getFile(first.body.href, ip);
  cdnDown = false;
  const next = await getLink(ip, "9000000001", "mp3");
  check("a refused file is a 502, and the download is given back",
    got.status === 502 && next.status === 200 && next.body.remaining === first.body.remaining, `${got.status} ${first.body.remaining} → ${next.body.remaining}`);
}

// A file without sound has nothing to send.
{
  let threw: unknown = null;
  await audioOnlyMp4(new BufferSource(await clip(1920, 1080, false))).catch((err) => (threw = err));
  check("a video without sound is refused, not sent", threw instanceof NoAudioError, String(threw));
}

setUsageStore(null);
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
