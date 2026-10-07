/**
 * X resolver: token formula, payload parsing, source fallback order, and the
 * guarantee that only https://video.twimg.com MP4s come out. Uses a fake
 * network; payload shapes follow react-tweet's and FxTwitter's published types.
 */
import { readFileSync } from "node:fs";
import {
  resolveXVideo, syndicationToken, XResolveError, isAllowedVideoUrl, xFilename,
  xAvailableQualities, pickXVariant, audioSourceVariant, variantQuality,
} from "../lib/x-video.ts";
import { FFMPEG_CORE_VERSION, FFMPEG_VERSION } from "../lib/mp3.ts";
import { signToken, verifyToken, workerConfig } from "../lib/media-server.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const ID = "1790866466429911046";
const V = (w: number, h: number, br: number) => ({
  content_type: "video/mp4",
  bitrate: br,
  url: `https://video.twimg.com/ext_tw_video/179/pu/vid/avc1/${w}x${h}/abc${h}.mp4?tag=12`,
});
const SYNDICATION_VIDEO = {
  __typename: "Tweet",
  text: "Liftoff! https://t.co/xyz",
  user: { screen_name: "NASA" },
  mediaDetails: [{
    type: "video",
    media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/179/pu/img/t.jpg",
    video_info: {
      duration_millis: 42500,
      variants: [
        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/179/pl/list.m3u8" },
        V(480, 270, 256000), V(1280, 720, 2176000), V(640, 360, 832000), V(1920, 1080, 10368000),
        { content_type: "video/mp4", bitrate: 999, url: "https://evil.example.com/x/1920x1080/a.mp4" },
      ],
    },
  }],
};

type Route = (url: string) => { status: number; body: unknown } | "throw";
function fakeFetch(route: Route) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const r = route(url);
    if (r === "throw") throw new Error("network down");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  return { f, calls };
}
async function kind(p: Promise<unknown>) {
  try { await p; return "ok"; } catch (e) { return e instanceof XResolveError ? e.kind : `other:${(e as Error).message}`; }
}

// Token formula (react-tweet's getToken). Recompute independently to be sure it is base 36.
const t = syndicationToken(ID);
const manual = ((Number(ID) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
check("syndication token matches react-tweet formula", t === manual && /^[a-z1-9]+$/.test(t), t);

// 1. Syndication success: best-first, m3u8 and foreign hosts dropped.
{
  const { f, calls } = fakeFetch((u) => (u.includes("syndication") ? { status: 200, body: SYNDICATION_VIDEO } : "throw"));
  const v = await resolveXVideo(ID, f as never);
  check("syndication: picks MP4s only, best first", v.variants.map((x) => x.height).join(",") === "1080,720,360,270",
    v.variants.map((x) => x.height).join(","));
  check("syndication: non-twimg URL rejected", v.variants.every((x) => isAllowedVideoUrl(x.url)));
  check("syndication: metadata", v.author === "NASA" && v.duration === 42.5 && v.hasAudio && v.title === "Liftoff!", JSON.stringify({ t: v.title, d: v.duration }));
  check("syndication: token + UA request", calls[0].includes(`token=${t}`) && calls.length === 1);
}

// 2. Quoted post: media lives under quoted_tweet.
{
  const { f } = fakeFetch(() => ({ status: 200, body: { text: "look", user: { screen_name: "a" }, quoted_tweet: { mediaDetails: SYNDICATION_VIDEO.mediaDetails } } }));
  check("quoted post video found", (await resolveXVideo(ID, f as never)).variants.length === 4);
}

// 3. GIF: silent.
{
  const gif = { user: { screen_name: "g" }, mediaDetails: [{ type: "animated_gif", video_info: { variants: [{ content_type: "video/mp4", bitrate: 0, url: "https://video.twimg.com/tweet_video/abc.mp4" }] } }] };
  const { f } = fakeFetch(() => ({ status: 200, body: gif }));
  const v = await resolveXVideo(ID, f as never);
  check("GIF: hasAudio=false", v.hasAudio === false && v.variants.length === 1);
}

// 4. Syndication returns {} (as it can for cloud IPs) → FxTwitter used.
{
  const fx = { code: 200, status: { text: "hi", author: { screen_name: "fx" }, media: { videos: [{
    type: "video", url: "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/best.mp4", width: 1280, height: 720, duration: 10.5,
    thumbnail_url: "https://pbs.twimg.com/t.jpg",
    formats: [
      { container: "mp4", codec: "h264", bitrate: 2176000, url: "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/best.mp4", height: 720, width: 1280 },
      { container: "mp4", codec: "h264", bitrate: 832000, url: "https://video.twimg.com/amplify_video/1/vid/avc1/640x360/mid.mp4", height: 360, width: 640 },
      { container: "m3u8", url: "https://video.twimg.com/amplify_video/1/pl/x.m3u8" },
    ] }] } } };
  const { f, calls } = fakeFetch((u) => (u.includes("syndication") ? { status: 200, body: {} } : u.includes("fxtwitter") ? { status: 200, body: fx } : "throw"));
  const v = await resolveXVideo(ID, f as never);
  check("empty syndication → FxTwitter fallback", v.author === "fx" && v.variants.map((x) => x.height).join(",") === "720,360" && calls.length === 2);
}

// 5. Syndication down, FxTwitter down → vxTwitter.
{
  const vx = { text: "vx", user_screen_name: "v", media_extended: [{ type: "video", url: "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280/v.mp4", duration_millis: 3000, size: { width: 720, height: 1280 } }] };
  const { f } = fakeFetch((u) => (u.includes("vxtwitter") ? { status: 200, body: vx } : "throw"));
  const v = await resolveXVideo(ID, f as never);
  check("both down → vxTwitter last resort", v.author === "v" && v.variants[0].height === 1280);
}

// 6. Failure kinds.
{
  const tomb = fakeFetch((u) => (u.includes("syndication") ? { status: 200, body: { __typename: "TweetTombstone" } } : "throw"));
  check("tombstone → unavailable", (await kind(resolveXVideo(ID, tomb.f as never))) === "unavailable");
  const photo = fakeFetch((u) => (u.includes("syndication") ? { status: 200, body: { mediaDetails: [{ type: "photo" }] } } : "throw"));
  check("photo-only post → no-video", (await kind(resolveXVideo(ID, photo.f as never))) === "no-video");
  const down = fakeFetch(() => "throw");
  check("everything down → unreachable", (await kind(resolveXVideo(ID, down.f as never))) === "unreachable");
  const empty = fakeFetch((u) => (u.includes("syndication") ? { status: 200, body: {} } : "throw"));
  check("empty syndication + others down → unreachable (not 'doesn't exist')", (await kind(resolveXVideo(ID, empty.f as never))) === "unreachable");
  const fx404 = fakeFetch((u) => (u.includes("fxtwitter") ? { status: 404, body: "" } : u.includes("syndication") ? { status: 200, body: {} } : "throw"));
  check("FxTwitter 404 → not-found", (await kind(resolveXVideo(ID, fx404.f as never))) === "not-found");
  const bad = fakeFetch(() => ({ status: 200, body: SYNDICATION_VIDEO }));
  check("non-numeric id rejected without any request", (await kind(resolveXVideo("123abc", bad.f as never))) === "not-found" && bad.calls.length === 0);
}

// 7. Allowlist and filenames.
check("allowlist: http, other hosts and non-mp4 rejected",
  !isAllowedVideoUrl("http://video.twimg.com/a.mp4") && !isAllowedVideoUrl("https://video.twimg.com.evil.com/a.mp4") &&
  !isAllowedVideoUrl("https://video.twimg.com/a.m3u8") && isAllowedVideoUrl("https://video.twimg.com/a/b.mp4?tag=1"));
check("filename", xFilename({ id: ID, author: "NASA" } as never, "mp4", 720) === `NASA-${ID}-720p.mp4` && xFilename({ id: ID, author: null } as never, "mp3") === `x-${ID}.mp3`);

// 8. Quality selection: "720p" is the short side; free users never get more than asked.
{
  const { f } = fakeFetch(() => ({ status: 200, body: SYNDICATION_VIDEO }));
  const v = await resolveXVideo(ID, f as never);
  const Q = [360, 480, 720, 1080];
  check("available qualities match real variants", xAvailableQualities(v, Q).join(",") === "360,720,1080", xAvailableQualities(v, Q).join(","));
  check("720 picks the 720 file", variantQuality(pickXVariant(v, 720)) === 720);
  check("480 picks 360, never 720", variantQuality(pickXVariant(v, 480)) === 360);
  check("MP3 source is the smallest file", variantQuality(audioSourceVariant(v)) === 270);
  const portrait = { ...v, variants: [{ url: "https://video.twimg.com/a/720x1280/p.mp4", bitrate: 1, width: 720, height: 1280 }] };
  check("portrait 720x1280 counts as 720p", xAvailableQualities(portrait, Q).join(",") === "720");
  const odd = { ...v, variants: [{ url: "https://video.twimg.com/a/576x1024/p.mp4", bitrate: 1, width: 576, height: 1024 }] };
  check("odd sizes still offer the nearest quality", xAvailableQualities(odd, Q).join(",") === "480");
}

// 8b. A /video/N link picks that media item (N counts photos too, as on X); titles can't spoof.
{
  const vid = (h: number, w: number, name: string) => ({
    type: "video", media_url_https: `https://pbs.twimg.com/${name}.jpg`,
    video_info: { duration_millis: 3000, variants: [V(w, h, h * 1000)].map((x) => ({ ...x, url: x.url.replace(`abc${h}`, name) })) },
  });
  const post = {
    __typename: "Tweet", text: "Two videos", user: { screen_name: "tester" },
    mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/p.jpg" }, vid(360, 640, "first"), vid(1080, 1920, "second")],
  };
  const { f } = fakeFetch(() => ({ status: 200, body: post }));
  const pick = async (n?: number) => resolveXVideo("33333", f as never, n);
  const third = await pick(3);
  check("/video/3 → the second video", third.variants[0].url.includes("second") && third.index === 2, third.variants[0].url);
  check("/video/2 → the first video", (await pick(2)).variants[0].url.includes("first"));
  check("/photo/1 (not a video) and no index → the first video",
    (await pick(1)).variants[0].url.includes("first") && (await pick()).variants[0].url.includes("first"));
  check("out-of-range index → the first video", (await pick(9)).variants[0].url.includes("first"));
  check("file name says which video", xFilename(third, "mp4", 1080) === "tester-33333-2-1080p.mp4" && xFilename(await pick(2), "mp4", 360) === "tester-33333-1-360p.mp4", xFilename(third, "mp4", 1080));
  const single = await resolveXVideo(ID, fakeFetch(() => ({ status: 200, body: SYNDICATION_VIDEO })).f as never, 1);
  check("single-video post: no index in the name", single.index === null && xFilename(single, "mp4", 720) === `NASA-${ID}-720p.mp4`);

  // FxTwitter lists every media item in media.all.
  const fx = {
    code: 200,
    status: {
      text: "fx", author: { screen_name: "fx" },
      media: {
        all: [{ type: "photo", url: "https://pbs.twimg.com/p.jpg" },
          { type: "video", url: "https://video.twimg.com/a/vid/640x360/one.mp4", width: 640, height: 360 },
          { type: "video", url: "https://video.twimg.com/a/vid/1280x720/two.mp4", width: 1280, height: 720 }],
        videos: [{ type: "video", url: "https://video.twimg.com/a/vid/640x360/one.mp4", width: 640, height: 360 },
          { type: "video", url: "https://video.twimg.com/a/vid/1280x720/two.mp4", width: 1280, height: 720 }],
      },
    },
  };
  const fxf = fakeFetch((u) => (u.includes("fxtwitter") ? { status: 200, body: fx } : { status: 200, body: {} })).f;
  check("fxtwitter: /video/3 → the second video", (await resolveXVideo("33333", fxf as never, 3)).variants[0].url.includes("two.mp4"));

  const spoof = { ...SYNDICATION_VIDEO, text: "\u202Egnp.exe\u202C and \u2066more\u2069 \u200Bhere 🧙\u200D\u2642\uFE0F" };
  const t2 = (await resolveXVideo(ID, fakeFetch(() => ({ status: 200, body: spoof })).f as never)).title;
  check("bidi and zero-width characters stripped from titles; emoji kept", t2 === "gnp.exe and more here 🧙\u200D\u2642\uFE0F", JSON.stringify(t2));
}

// 9. The browser loads ffmpeg.wasm from paths stamped with these versions.
{
  const installed = (name: string) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
  check("ffmpeg.wasm versions match installed packages",
    installed("@ffmpeg/ffmpeg") === FFMPEG_VERSION && installed("@ffmpeg/core") === FFMPEG_CORE_VERSION);
}

// 10. Tokens and worker config.
{
  const tok = signToken({ u: "x" }, "k");
  check("token round-trips", verifyToken<{ u: string }>(tok, "k")?.u === "x");
  check("wrong key rejected", verifyToken(tok, "k2") === null);
  check("tampered body rejected", verifyToken("e30" + tok.slice(3), "k") === null);
  check("expired token rejected", verifyToken(signToken({ u: "x" }, "k", -5), "k") === null);
  check("grace period accepts a recently expired token (refunds)", verifyToken(signToken({ u: "x" }, "k", -5), "k", 60)?.u === "x");
  const env = (url?: string, secret?: string) => {
    if (url === undefined) delete process.env.MEDIA_WORKER_URL; else process.env.MEDIA_WORKER_URL = url;
    if (secret === undefined) delete process.env.MEDIA_WORKER_SECRET; else process.env.MEDIA_WORKER_SECRET = secret;
    return workerConfig();
  };
  const c = env("media.example.com/ \n", " s3cret\n");
  check("worker URL gets https and loses trailing slash; secret trimmed",
    c.ok && c.url === "https://media.example.com" && c.secret === "s3cret", JSON.stringify(c));
  const h = env("http://media.example.com", "s");
  check("http upgraded to https (browsers block mixed content)", h.ok && h.url === "https://media.example.com");
  const l = env("http://localhost:8080/", "s");
  check("localhost keeps http", l.ok && l.url === "http://localhost:8080");
  check("missing pieces reported", !env(undefined, "s").ok && (env("u.com", "  ") as { reason: string }).reason === "missing-secret");
  env(undefined, undefined);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
