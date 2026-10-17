// Checks on the rendered MP4 itself (not the source page).
//   node scripts/qa.mjs sheet  <video.mp4> <out.png> [--every 1] [--width 360] [--cols 6] [--from 0 --to 38]
//   node scripts/qa.mjs pops   <video.mp4>            frame-difference scan: jumps and one-frame flashes
//   node scripts/qa.mjs loop   <video.mp4>            first vs last frame, motion into vs out of the seam
//   node scripts/qa.mjs loud   <video.mp4>            EBU R128 integrated loudness and true peak
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launch, FFMPEG } from "./lib.mjs";

const [cmd, file, outArg, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const all = [outArg, ...rest]; const i = all.indexOf(`--${k}`); return i < 0 ? d : all[i + 1]; };

function run(args, { raw = false } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, args);
    const out = [], err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("close", (c) => (c === 0 ? res(raw ? Buffer.concat(out) : Buffer.concat(err).toString()) : rej(new Error(Buffer.concat(err).toString().slice(-2000)))));
  });
}

async function probe(f) {
  const s = await run(["-hide_banner", "-i", f, "-f", "null", "-t", "0.01", "-"]).catch((e) => e.message);
  const fps = +(/, ([\d.]+) fps/.exec(s) || [0, 60])[1];
  const [, w, h] = /, (\d{3,4})x(\d{3,4})/.exec(s) || [0, 1920, 1080];
  // the picture's own length (the container's can be a few ms longer because of the AAC tail)
  const c = await run(["-hide_banner", "-i", f, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
  const all = [...c.matchAll(/frame=\s*(\d+)/g)];
  const frames = all.length ? +all[all.length - 1][1] : Math.round(38 * fps);
  return { fps, w: +w, h: +h, frames, dur: frames / fps };
}

async function grabJpeg(f, t, width) {
  return run(["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "-"], { raw: true });
}

if (cmd === "sheet") {
  const meta = await probe(file);
  const every = +opt("every", 1), width = +opt("width", 360), cols = +opt("cols", 6);
  const a = +opt("from", 0), b = Math.min(+opt("to", meta.dur), meta.dur - 1 / meta.fps);
  const tiles = [];
  for (let t = a; t <= b + 1e-9; t += every) tiles.push({ t, src: `data:image/jpeg;base64,${(await grabJpeg(file, t, width)).toString("base64")}` });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: cols * (width + 6) + 6, height: 300 } });
  await page.setContent(`<body style="margin:0;background:#15121f;font:600 13px ui-monospace,monospace;color:#eee"><div style="display:grid;grid-template-columns:repeat(${cols},${width}px);gap:6px;padding:6px">${tiles.map((x) => `<div style="position:relative"><img src="${x.src}" style="width:${width}px;display:block"><span style="position:absolute;left:4px;top:3px;background:rgba(0,0,0,.6);padding:1px 5px;border-radius:3px">${x.t.toFixed(2)}</span></div>`).join("")}</div></body>`);
  await writeFile(resolve(outArg), await page.screenshot({ fullPage: true }));
  await browser.close();
  console.log(`${tiles.length} tiles -> ${outArg}`);
} else if (cmd === "pops") {
  const meta = await probe(file);
  const W = 192, H = Math.round((W * meta.h) / meta.w);
  const raw = await run(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { raw: true });
  const n = Math.floor(raw.length / (W * H));
  const d = [];
  for (let i = 1; i < n; i++) {
    let s = 0;
    const o0 = (i - 1) * W * H, o1 = i * W * H;
    for (let p = 0; p < W * H; p++) s += Math.abs(raw[o1 + p] - raw[o0 + p]);
    d.push(s / (W * H));
  }
  const flags = [];
  for (let i = 0; i < d.length; i++) {
    const prev = d[i - 1] ?? d[i], next = d[i + 1] ?? d[i];
    const med = [d[i - 3], d[i - 2], prev, next, d[i + 2], d[i + 3]].filter((x) => x != null).sort((a, b) => a - b)[2] ?? 0;
    if (d[i] > 2.5 && d[i] > 3 * Math.max(med, 0.4)) flags.push({ t: ((i + 1) / meta.fps).toFixed(3), diff: d[i].toFixed(2), around: med.toFixed(2), kind: "jump" });
  }
  // one-frame flash: frame i differs from both neighbours while i-1 and i+1 agree
  for (let i = 1; i + 1 < n; i++) {
    let a = 0, b = 0, c = 0;
    const o0 = (i - 1) * W * H, o1 = i * W * H, o2 = (i + 1) * W * H;
    for (let p = 0; p < W * H; p += 3) { a += Math.abs(raw[o1 + p] - raw[o0 + p]); b += Math.abs(raw[o2 + p] - raw[o1 + p]); c += Math.abs(raw[o2 + p] - raw[o0 + p]); }
    if (a > 4 * (c + 50) && b > 4 * (c + 50) && a / (W * H / 3) > 1.5) flags.push({ t: (i / meta.fps).toFixed(3), diff: (a / (W * H / 3)).toFixed(2), kind: "flash" });
  }
  console.log(JSON.stringify({ frames: n, fps: meta.fps, meanDiff: (d.reduce((s, x) => s + x, 0) / d.length).toFixed(3), maxDiff: Math.max(...d).toFixed(2), flags }, null, 1));
} else if (cmd === "loop") {
  const meta = await probe(file);
  const W = 192, H = Math.round((W * meta.h) / meta.w);
  // exact frames by index, not by seeking
  const frame = async (n) => run(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${n}),scale=${W}:${H},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { raw: true });
  const diff = (a, b) => { let s = 0; for (let p = 0; p < a.length; p++) s += Math.abs(a[p] - b[p]); return s / a.length; };
  const first = await frame(0), second = await frame(1), last = await frame(meta.frames - 1), penult = await frame(meta.frames - 2);
  console.log(JSON.stringify({ firstVsLast: diff(first, last).toFixed(3), motionOutOfSeam: diff(first, second).toFixed(3), motionIntoSeam: diff(penult, last).toFixed(3) }));
} else if (cmd === "loud") {
  const s = await run(["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"]);
  const sum = s.slice(s.lastIndexOf("Summary:"));
  console.log(sum.trim());
} else {
  console.log("usage: qa.mjs sheet|pops|loop|loud <video.mp4> ...");
}
process.exit(0);
