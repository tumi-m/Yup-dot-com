/**
 * Download sizes and leaner files: the size under each quality chip, when
 * "Smaller file" / Compress Video re-encode and at what bitrate, the MP3
 * quality picked from the source's audio, and the Compress Video tool's
 * registration. Pure logic only; the browser path is checked with Playwright.
 */
import {
  BITS_PER_PIXEL, canEncodeH264, encodedBytes, encoderFrameRate, encoderRequest, MAX_IN_MEMORY, planVideo, REENCODE_RATIO, shortBytes, targetBitrate, worthReencoding,
} from "../lib/video-quality.ts";
import { probeSizes, qualitySizes, smallerSize, variantSize, workerQualitySizes } from "../lib/media-size.ts";
import { mp3VbrLevel, parseAudioStream } from "../lib/mp3.ts";
import { parseTikTokItem } from "../lib/social/tiktok.ts";
import { xAvailableQualities, type XVideo } from "../lib/x-video.ts";
import { QUALITIES } from "../lib/media.ts";
import { getTool, TOOLS } from "../lib/tools.tsx";
import { panelSpec } from "../components/tools/panel-spec.tsx";
import { PROCESSORS } from "../components/tools/processors.ts";
import * as sitemapModule from "../app/sitemap.ts";

// app/sitemap.ts loads as CommonJS here, so its default export may be nested.
const sitemap = ((sitemapModule as { default: unknown }).default as { default?: unknown }).default ?? sitemapModule.default;

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const MB = 1024 * 1024;

// ---------- bitrate targets ----------
const hd = targetBitrate(1920, 1080, 30);
check("1080p30 target is about 4.35 Mbps (0.07 bits/pixel/frame)", Math.abs(hd - 1920 * 1080 * 30 * 0.07) < 1, String(hd));
check("presets order small < recommended < high", targetBitrate(1920, 1080, 30, "small") < hd && hd < targetBitrate(1920, 1080, 30, "high"));
check("preset bpp values", BITS_PER_PIXEL.small === 0.045 && BITS_PER_PIXEL.recommended === 0.07 && BITS_PER_PIXEL.high === 0.1);
const t720 = targetBitrate(1280, 720, 30);
check("720p gets about 0.086 bits/pixel (its SSIM there matched 1080p at 0.07)", t720 / (1280 * 720 * 30) > 0.085 && t720 / (1280 * 720 * 30) < 0.087, String(t720));
check("portrait is the same as landscape", targetBitrate(1080, 1920, 30) === hd);
check("60 fps costs 1.5× 30 fps, not 2×", Math.abs(targetBitrate(1920, 1080, 60) / hd - 1.5) < 0.001);
check("unknown fps is treated as 30", targetBitrate(1920, 1080, null) === hd && targetBitrate(1920, 1080, 0) === hd);
check("absurd fps is clamped", targetBitrate(1920, 1080, 1000) === targetBitrate(1920, 1080, 120));
check("4K scales sub-linearly (×4 pixels, under ×3 bits)", targetBitrate(3840, 2160, 30) / hd < 3 && targetBitrate(3840, 2160, 30) / hd > 2.5);

// ---------- the frame rate the encoder is told ----------
// Chrome's encoder spends bitrate / frame rate per frame (30 when not told),
// and mediabunny's MP4 timescale comes from the same number: it must stay
// close to the real rate and keep the 1/57600 s timescale (57600/k, k coprime).
{
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const rates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120, 240, 7.5, 27.3];
  const got = rates.map((r) => [r, encoderFrameRate(r)] as const);
  check("encoder frame rate is within 1% of the source's", got.every(([r, e]) => !!e && Math.abs(e / r - 1) < 0.01), JSON.stringify(got));
  check(
    "it keeps the MP4's 1/57600 s timescale",
    got.every(([, e]) => {
      const k = Math.round(57_600 / e!);
      return Math.abs(57_600 / k - e!) < 1e-9 && gcd(k, 57_600) === 1;
    })
  );
  check("no rate, or a nonsense one: the encoder isn't told", [null, undefined, 0, NaN, Infinity, -30, 0.5, 1000].every((r) => encoderFrameRate(r) === undefined));
  const at60 = encoderRequest(6_531_840, 60);
  check("up to 60 fps: the target bitrate at the source's rate", at60.bitrate === 6_531_840 && at60.frameRate === encoderFrameRate(60));
  const at120 = encoderRequest(10_886_400, 120);
  check("above 60 fps: told 60 with the bitrate scaled to match", at120.frameRate === encoderFrameRate(60) && at120.bitrate === 5_443_200, JSON.stringify(at120));
  check("unknown rate: the bitrate as is, no rate", JSON.stringify(encoderRequest(4_000_000, null)) === JSON.stringify({ bitrate: 4_000_000 }));
}

// ---------- re-encode decision ----------
check("re-encode only at ≥ 1.4× the target", REENCODE_RATIO === 1.4 && worthReencoding(hd * 1.4, hd) && !worthReencoding(hd * 1.39, hd));
check("no bitrate, no re-encode", !worthReencoding(0, hd));
const src = (o: Partial<Parameters<typeof planVideo>[0]>) =>
  ({ codec: "avc", container: "mp4", width: 1920, height: 1080, fps: 30, bitrate: 10_368_000, ...o });
const heavy = planVideo(src({}));
check("X 1080p at 10.4 Mbps is re-encoded to the target", heavy.action === "encode" && heavy.bitrate === hd, JSON.stringify(heavy));
check("lean H.264 MP4 is kept as is", planVideo(src({ bitrate: 5_000_000 })).action === "keep");
check("lean H.264 in MOV is only remuxed", planVideo(src({ container: "mov", bitrate: 5_000_000 })).action === "remux");
check("X 720p (2.18 Mbps) is already lean", planVideo(src({ width: 1280, height: 720, bitrate: 2_176_000 })).action === "keep");
const vp9 = planVideo(src({ codec: "vp9", container: "webm", bitrate: 2_000_000 }));
check("VP9 is converted, never with more bits than it had", vp9.action === "encode" && vp9.bitrate === 2_000_000, JSON.stringify(vp9));
const vp9Heavy = planVideo(src({ codec: "vp9", container: "webm", bitrate: 20_000_000 }));
check("heavy VP9 goes to the target", vp9Heavy.action === "encode" && vp9Heavy.bitrate === hd);
// Packet stats give fractional bitrates; encoders want whole numbers.
const vp9Odd = planVideo(src({ codec: "vp9", container: "webm", bitrate: 1_612_903.2258 }));
check("converted bitrate is a whole number", vp9Odd.action === "encode" && vp9Odd.bitrate === 1_612_903, JSON.stringify(vp9Odd));
const hevc = planVideo(src({ codec: "hevc", container: "mov", bitrate: 0 }));
check("unknown-bitrate HEVC goes to the target", hevc.action === "encode" && hevc.bitrate === hd);
check("the small preset re-encodes what recommended keeps", planVideo(src({ bitrate: 4_500_000 }), "small").action === "encode" && planVideo(src({ bitrate: 4_500_000 })).action === "keep");
check("encodedBytes", encodedBytes(4_000_000, 128_000, 10) === 5_160_000);
check("shortBytes", shortBytes(500_000) === "0.5 MB" && shortBytes(20_000) === "0.1 MB" && shortBytes(8.3 * MB) === "8.3 MB" && shortBytes(42.4 * MB) === "42 MB" && shortBytes(1.5 * 1024 * MB) === "1.5 GB");
check("no WebCodecs here: H.264 encoding reported unavailable", (await canEncodeH264()) === false);

// ---------- size estimates ----------
const xVideo: XVideo = {
  id: "1", index: null, title: "t", author: "a", thumbnail: null, duration: 42.5, hasAudio: true,
  variants: [
    { url: "https://video.twimg.com/1920x1080/a.mp4", bitrate: 10_368_000, width: 1920, height: 1080 },
    { url: "https://video.twimg.com/1280x720/b.mp4", bitrate: 2_176_000, width: 1280, height: 720 },
    { url: "https://video.twimg.com/640x360/c.mp4", bitrate: 832_000, width: 640, height: 360 },
  ],
};
const avail = xAvailableQualities(xVideo, QUALITIES);
const sizes = qualitySizes(xVideo, avail);
check("X sizes are bitrate × duration, marked estimates", sizes[1080]?.size === Math.round((10_368_000 * 42.5) / 8) && sizes[1080].exact === false, JSON.stringify(sizes[1080]));
check("480 shows the size of the 360p file it downloads", sizes[480] === undefined || sizes[480].size === sizes[360].size);
check("only 1080p offers Smaller file (720p/360p are lean)", !!sizes[1080]?.smaller && !sizes[720]?.smaller && !sizes[360]?.smaller, JSON.stringify(sizes));
check("1080p smaller ≈ (4.35 Mbps + 128 kbps) × 42.5 s", sizes[1080].smaller === encodedBytes(hd, 128_000, 42.5), String(sizes[1080].smaller));
check("Smaller file saves over half on X 1080p", sizes[1080].smaller! < sizes[1080].size / 2);
check("exact size wins over bitrate", variantSize({ url: "u", bitrate: 1_000_000, width: 1, height: 1, size: 1234 }, 10)?.exact === true && variantSize({ url: "u", bitrate: 1_000_000, width: 1, height: 1, size: 1234 }, 10)?.size === 1234);
check("no size and no bitrate: nothing shown", variantSize({ url: "u", bitrate: 0, width: null, height: null }, 10) === null);
check("no duration: nothing estimated", variantSize({ url: "u", bitrate: 2_000_000, width: null, height: null }, null) === null);
check("unknown dimensions are assumed 16:9", smallerSize({ url: "u", bitrate: 0, width: null, height: 1080 }, 50 * MB, 30, true) === encodedBytes(hd, 128_000, 30));
check("a silent clip counts no audio", smallerSize({ url: "u", bitrate: 0, width: 1920, height: 1080 }, 50 * MB, 30, false) === encodedBytes(hd, 0, 30));
// The frame rate is unknown here: offered only when 60 fps would re-encode too.
const at = (mbps: number) => smallerSize({ url: "u", bitrate: 0, width: 1920, height: 1080 }, (mbps * 1e6 * 10) / 8, 10, false);
check("1080p at 8 Mbps: a 60 fps post would be kept, so not offered", at(8) === undefined);
check("1080p at 9.2 Mbps: re-encoded at 30 and 60 fps, offered", at(9.2) === encodedBytes(hd, 0, 10) && 9.2e6 >= targetBitrate(1920, 1080, 60) * REENCODE_RATIO);
{
  // Over 1 GB the browser saves the file straight from our origin, so it can't be re-encoded.
  const long: XVideo = { ...xVideo, duration: 1000, variants: [{ url: "https://video.twimg.com/1280x720/big.mp4", bitrate: 10_000_000, width: 1280, height: 720 }] };
  const s = qualitySizes(long, [720]);
  check("a 1.25 GB file shows its size but doesn't offer Smaller file", s[720]?.size === 1_250_000_000 && s[720].smaller === undefined, JSON.stringify(s));
  const v = long.variants[0];
  check("at the in-tab limit it's still offered", !!smallerSize(v, MAX_IN_MEMORY, 800, true) && smallerSize(v, MAX_IN_MEMORY + 1, 800, true) === undefined);
}

// TikTok: DataSize is exact, PlayAddr's own width/height win.
{
  const tt = parseTikTokItem("7106798200794926362", {
    desc: "x", author: { uniqueId: "u" },
    video: {
      width: 576, height: 1024, duration: 20,
      bitrateInfo: [
        { Bitrate: 1_100_000, PlayAddr: { UrlKey: "v1_h264_720p_1100000", DataSize: "2750123", Width: 720, Height: 1280, UrlList: ["https://v16-webapp-prime.tiktok.com/video/h264-720.mp4"] } },
        { Bitrate: 600_000, PlayAddr: { UrlKey: "v1_h264_540p_600000", UrlList: ["https://v16-webapp.tiktokcdn-us.com/video/h264-540.mp4"] } },
      ],
    },
  }, "https://www.tiktok.com/@u/video/7106798200794926362", "");
  const s = qualitySizes(tt, xAvailableQualities(tt, QUALITIES));
  check("TikTok DataSize is shown exactly", s[720]?.size === 2_750_123 && s[720].exact === true, JSON.stringify(s));
  check("TikTok width/height from PlayAddr", tt.variants[0].width === 720 && tt.variants[0].height === 1280);
  check("TikTok without DataSize falls back to bitrate", s[480] ? s[480].exact === false : true);
}

// HEAD probe for variants with neither size nor bitrate (Instagram).
{
  const ig: XVideo = {
    id: "C", index: null, title: "t", author: null, thumbnail: null, duration: 12, hasAudio: true,
    variants: [
      { url: "https://scontent.cdninstagram.com/v/720.mp4", bitrate: 0, width: 720, height: 1280 },
      { url: "https://scontent.cdninstagram.com/v/360.mp4", bitrate: 0, width: 360, height: 640 },
    ],
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("720.mp4")) return new Response(null, { headers: { "content-length": "3456789" } });
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x.mp4" } });
  };
  const q = xAvailableQualities(ig, QUALITIES);
  await probeSizes(ig, q, { "User-Agent": "ua" }, f);
  const s = qualitySizes(ig, q);
  check("HEAD Content-Length becomes an exact size", s[720]?.size === 3_456_789 && s[720].exact === true, JSON.stringify(s));
  check("a redirect is not followed and gives no size", s[360] === undefined && calls.every((c) => c.init?.redirect === "manual" && c.init?.method === "HEAD"));
  check("each file probed once", calls.length === 2, String(calls.length));
  calls.length = 0;
  await probeSizes(xVideo, avail, {}, f);
  check("nothing probed when bitrates are known", calls.length === 0);
  const boom = async () => {
    throw new Error("down");
  };
  const ig2: XVideo = { ...ig, variants: ig.variants.map(({ size: _size, ...v }) => v) };
  await probeSizes(ig2, q, {}, boom);
  check("network failures are ignored", Object.keys(qualitySizes(ig2, q)).length === 0);
}

// YouTube (worker): a size per short side, picked like the worker picks formats.
{
  const w = workerQualitySizes({ "360": 5_000_000, "720": 12_000_000, "1080": 30_000_000 }, [360, 480, 720, 1080]);
  check("worker sizes map to qualities (480 → the 360p file)", w[360].size === 5e6 && w[480].size === 5e6 && w[720].size === 12e6 && w[1080].size === 3e7 && !w[720].exact);
  check("worker: below the smallest → the smallest", workerQualitySizes({ "720": 9 }, [360])[360].size === 9);
  check("worker: missing or junk sizes → none", Object.keys(workerQualitySizes(undefined, [720])).length === 0 && Object.keys(workerQualitySizes({ a: "x", "720": -1 }, [720])).length === 0);
}

// ---------- MP3 quality from the source ----------
const LOGS = {
  aac128: "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)",
  aac96: "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 96 kb/s (default)",
  aac64: "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 64 kb/s (default)",
  mono64: "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 64 kb/s (default)",
  he48: "  Stream #0:1[0x2](und): Audio: aac (HE-AAC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 48 kb/s (default)",
  aac256: "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s (default)",
  surround: "  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, 5.1, fltp, 384 kb/s",
  noRate: "  Stream #0:1(und): Audio: opus, 48000 Hz, stereo, fltp (default)",
};
const full = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':\n  Duration: 00:00:42.50, start: 0.000000, bitrate: 10496 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 10368 kb/s, 30 fps\n${LOGS.aac128}\nAt least one output file must be specified`;
const parsed = parseAudioStream(full);
check("parses the audio line out of a full log (not the video's kb/s)", parsed?.kbps === 128 && parsed.channels === 2 && !parsed.heAac, JSON.stringify(parsed));
check("128k AAC → V3 (~175 kbps, about 1.4×)", mp3VbrLevel(parseAudioStream(LOGS.aac128)) === 3);
check("96k AAC → V5 (~130 kbps)", mp3VbrLevel(parseAudioStream(LOGS.aac96)) === 5);
check("64k AAC → V6, the smallest allowed", mp3VbrLevel(parseAudioStream(LOGS.aac64)) === 6);
check("mono is detected", parseAudioStream(LOGS.mono64)?.channels === 1);
check("64k mono counts like 128k stereo → V3", mp3VbrLevel(parseAudioStream(LOGS.mono64)) === 3);
check("48k HE-AAC counts double → V5", parseAudioStream(LOGS.he48)?.heAac === true && mp3VbrLevel(parseAudioStream(LOGS.he48)) === 5);
check("256k AAC → V2, never above", mp3VbrLevel(parseAudioStream(LOGS.aac256)) === 2);
check("5.1 is not mono", parseAudioStream(LOGS.surround)?.channels === 2);
check("no bitrate in the log → V2", mp3VbrLevel(parseAudioStream(LOGS.noRate)) === 2);
check("unparseable log → V2", parseAudioStream("garbage") === null && mp3VbrLevel(null) === 2);
check("video-only file → no audio stream", parseAudioStream(full.replace(LOGS.aac128, "")) === null);

// ---------- Compress Video tool ----------
const tool = getTool("compress-video");
check("compress-video is registered under Video & Audio", !!tool && tool.category === "media" && TOOLS.filter((t) => t.slug === "compress-video").length === 1);
check("it is a workbench tool with a processor", !!tool && panelSpec(tool).kind === "workbench" && !!PROCESSORS["compress-video"]);
const proc = PROCESSORS["compress-video"];
check("accepts MP4, MOV and WebM", ["video/mp4", "video/quicktime", "video/webm"].every((t) => proc.accept.split(",").includes(t)));
check("one file at a time, size change reported, can be cancelled", !proc.multiple && proc.minFiles === 1 && proc.reportsSizeChange === true && proc.cancellable === true);
const labels = proc.fields[0].options!.map((o) => o.label).join(", ");
const pdfLabels = PROCESSORS["compress-pdf"].fields[0].options!.map((o) => o.label).join(", ");
check("presets read like the PDF compressor's", labels === pdfLabels && labels === "Smallest file, Recommended, High quality", labels);
check("preset values are the engine's", proc.fields[0].options!.every((o) => o.value in BITS_PER_PIXEL) && proc.fields[0].default === "recommended");
check("listed in the sitemap", (sitemap as typeof sitemapModule.default)().some((e) => e.url.endsWith("/tools/compress-video")));
let message = "";
try {
  await proc.run([new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" })], { quality: "recommended" }, {});
} catch (e) {
  message = (e as Error).message;
}
check("without WebCodecs the tool says so plainly", /can't compress video/.test(message), message);

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
