// Renders the film to a silent H.264 MP4.
//
//   node scripts/render.mjs --fmt 16x9                 master: 60 fps, motion-blurred, CRF 18
//   node scripts/render.mjs --fmt 9x16                 vertical: 30 fps, CRF 20
//   node scripts/render.mjs --fmt 16x9 --draft         quick 30 fps half-size draft, no blur
//   options: --from 0 --to 38 --chunk 1 --workers 3 --crf 18 --out out/video-16x9.mp4
//   --only 18,19   re-render just those chunks (1 s each by default) and rejoin the film
//
// Each output frame blends N captures spread over a 180-degree shutter (ffmpeg tmix).
// N is chosen per chunk from the fastest on-screen motion in it (4 at rest, up to 16
// on the whip). Frames go straight from Chromium into ffmpeg through a pipe, chunk by
// chunk, in parallel workers; chunks are joined without re-encoding. Every chunk and the
// joined film are checked for the exact frame count, so picture and sound cannot drift.
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve, launch, openFilm, FFMPEG, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = (k) => args.includes(`--${k}`);
const fmt = opt("fmt", "16x9");
const draft = flag("draft");
const fps = +opt("fps", draft ? 30 : fmt === "9x16" ? 30 : 60);
const from = +opt("from", 0), to = +opt("to", 38);
const chunkSec = +opt("chunk", 1);
const workers = +opt("workers", 3);
// the vertical cut is not the master: CRF 20 keeps its size sensible (grain costs bits at 30 fps)
const crf = opt("crf", draft ? "26" : fmt === "9x16" ? "20" : "18");
const shutter = 0.5;
const out = resolve(ROOT, opt("out", `out/video-${fmt}${draft ? "-draft" : ""}.mp4`));
// chunks are kept between runs so a fix only re-renders the seconds it touches
const tmp = resolve(ROOT, `out/chunks-${fmt}${draft ? "-draft" : ""}-${from}-${to}-${chunkSec}`);
const only = opt("only", null)?.split(",").map(Number);

const srv = await serve();
if (!only) await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

// ---- plan chunks and their subframe counts from the film's own motion
const planBrowser = await launch();
const { page: planPage } = await openFilm(planBrowser, srv.url, fmt);
const nFrames = Math.round((to - from) * fps);
const perChunk = Math.round(chunkSec * fps);
const chunks = [];
for (let f0 = 0; f0 < nFrames; f0 += perChunk) {
  const f1 = Math.min(nFrames, f0 + perChunk);
  const maxSpeed = await planPage.evaluate(({ a, b, fps, from }) => {
    let m = 0;
    for (let f = a; f < b; f++) for (let k = 0; k < 4; k++) m = Math.max(m, window.FILM.speed(from + (f + k / 4) / fps));
    return m;
  }, { a: f0, b: f1, fps, from });
  // spacing between captures inside one shutter, in screen px
  const blurPx = (maxSpeed / fps) * shutter;
  const n = draft ? 1 : Math.max(4, Math.min(16, Math.ceil(blurPx / 7)));
  chunks.push({ i: chunks.length, f0, f1, n, maxSpeed: Math.round(maxSpeed) });
}
await planBrowser.close();
console.log(`${fmt} ${fps} fps, ${nFrames} frames, ${chunks.length} chunks, captures ${chunks.reduce((s, c) => s + (c.f1 - c.f0) * c.n, 0)}`);
console.log("subframes per chunk:", chunks.map((c) => c.n).join(" "));

/**
 * How many inputs late tmix's window ends, measured on this FFmpeg with flat grey frames.
 * The bundled 4.1 build skips its first output, so output m mixes inputs m+1..m+N (lag N);
 * newer builds mix m-N+1..m (lag 0). Each chunk's input is padded at the front by the lag
 * so that every output frame blends exactly its own subframes and none is lost.
 */
async function tmixLag(N) {
  const raw = await new Promise((res, rej) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      `color=c=black:s=8x8:r=24:d=5,format=gray,geq=lum='N*2',tmix=frames=${N}:weights='${Array(N).fill(1).join(" ")}'`,
      "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const out = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("close", (c) => (c === 0 ? res(Buffer.concat(out)) : rej(new Error("tmix probe failed"))));
  });
  // (120 probe frames, brightness 2 per frame, so up to 16 subframes is measured well inside the range)
  const m = 2 * N;
  if (raw.length < (m + 1) * 64) throw new Error(`tmix probe too short for ${N} subframes`);
  const meanIdx = raw[m * 64] / 2;
  return Math.round(meanIdx + (N - 1) / 2 - m);
}

async function countFrames(file) {
  const s = await new Promise((res) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file, "-map", "0:v", "-c", "copy", "-f", "null", "-"]);
    const err = [];
    p.stderr.on("data", (d) => err.push(d));
    p.on("close", () => res(Buffer.concat(err).toString()));
  });
  const all = [...s.matchAll(/frame=\s*(\d+)/g)];
  return all.length ? +all[all.length - 1][1] : -1;
}

const lags = {};
for (const n of new Set(chunks.map((c) => c.n))) if (n > 1) lags[n] = await tmixLag(n);
if (Object.keys(lags).length) console.log("tmix lag per subframe count:", JSON.stringify(lags));
for (const [n, l] of Object.entries(lags)) if (!Number.isInteger(l) || l < 0) throw new Error(`bad tmix lag ${l} for ${n} subframes`);

function encoder(chunk, file) {
  const n = chunk.n;
  const filters = [];
  if (n > 1) filters.push(`tmix=frames=${n}:weights='${Array(n).fill(1).join(" ")}'`, `select='eq(mod(n\\,${n})\\,${n - 1})'`);
  filters.push(`setpts=N/(${fps}*TB)`);
  if (draft) filters.push("scale=iw/2:ih/2:flags=bicubic");
  filters.push("scale=out_color_matrix=bt709:out_range=tv", "format=yuv420p");
  const a = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps * n), "-c:v", "png", "-i", "-",
    "-vf", filters.join(","), "-r", String(fps),
    "-frames:v", String(chunk.f1 - chunk.f0),
    "-c:v", "libx264", "-preset", draft ? "veryfast" : "slow", "-crf", crf, "-tune", "film",
    "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", String(fps * 2),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    file,
  ];
  const p = spawn(FFMPEG, a, { stdio: ["pipe", "inherit", "inherit"] });
  // with -frames:v, ffmpeg may finish before the tail padding is written: that is fine
  p.stdin.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
  let closed = false;
  const done = new Promise((res, rej) => p.on("close", (c) => { closed = true; c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} on chunk ${chunk.i}`)); }));
  return { p, done, isClosed: () => closed || p.stdin.destroyed };
}

const queue = chunks.filter((c) => !only || only.includes(c.i)).sort((a, b) => b.n * (b.f1 - b.f0) - a.n * (a.f1 - a.f0));
let finished = 0;
const t0 = Date.now();

async function worker(id) {
  let browser = await launch();
  let { page } = await openFilm(browser, srv.url, fmt, 1);
  let cdp = await page.context().newCDPSession(page);
  const reopen = async () => {
    try { await browser.close(); } catch { /* already gone */ }
    browser = await launch();
    ({ page } = await openFilm(browser, srv.url, fmt, 1));
    cdp = await page.context().newCDPSession(page);
  };
  for (;;) {
    const c = queue.shift();
    if (!c) break;
    const file = join(tmp, `c${String(c.i).padStart(4, "0")}.mp4`);
    const enc = encoder(c, file);
    const put = async (png, times = 1) => {
      for (let i = 0; i < times && !enc.isClosed(); i++) {
        if (!enc.p.stdin.write(png)) {
          await new Promise((r) => {
            const go = () => { enc.p.stdin.off("drain", go); enc.p.stdin.off("close", go); r(); };
            enc.p.stdin.on("drain", go); enc.p.stdin.on("close", go);
          });
        }
      }
    };
    let first = true, lastPng = null;
    for (let f = c.f0; f < c.f1; f++) {
      for (let k = 0; k < c.n; k++) {
        const t = from + f / fps + (c.n > 1 ? ((k + 0.5) / c.n - 0.5) * (shutter / fps) : 0);
        let png = null;
        for (let attempt = 0; attempt < 4 && !png; attempt++) {
          try {
            await page.evaluate(async (tt) => {
              window.FILM.seek(tt);
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            }, t);
            const r = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
            png = Buffer.from(r.data, "base64");
          } catch (e) {
            console.error(`[w${id}] capture failed at ${t.toFixed(4)}s (${e.message}); reopening`);
            await reopen();
          }
        }
        if (!png) throw new Error(`capture failed at ${t}`);
        if (first && c.n > 1) await put(png, lags[c.n]); // front padding: see tmixLag
        first = false;
        await put(png);
        lastPng = png;
      }
    }
    // tail padding (any extra output is cut by -frames:v)
    if (c.n > 1) await put(lastPng, c.n);
    if (!enc.isClosed()) enc.p.stdin.end();
    await enc.done;
    const got = await countFrames(file);
    if (got !== c.f1 - c.f0) throw new Error(`chunk ${c.i} has ${got} frames, expected ${c.f1 - c.f0}`);
    finished++;
    const el = (Date.now() - t0) / 1000;
    console.log(`[w${id}] chunk ${c.i} (${c.f0}-${c.f1}, x${c.n}) done; ${finished}/${chunks.length} in ${el.toFixed(0)} s`);
  }
  await browser.close();
}

await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
const list = chunks.map((c) => `file '${join(tmp, `c${String(c.i).padStart(4, "0")}.mp4`)}'`).join("\n");
await writeFile(join(tmp, "list.txt"), list + "\n");
await new Promise((res, rej) => {
  const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(tmp, "list.txt"), "-c", "copy", "-movflags", "+faststart", out], { stdio: "inherit" });
  p.on("close", (c) => (c === 0 ? res() : rej(new Error("concat failed"))));
});
const total = await countFrames(out);
if (total !== nFrames) throw new Error(`${out} has ${total} frames, expected ${nFrames}`);
await writeFile(out.replace(/\.mp4$/, ".plan.json"), JSON.stringify({ fmt, fps, from, to, shutter, chunks }, null, 1));
await srv.close();
console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
