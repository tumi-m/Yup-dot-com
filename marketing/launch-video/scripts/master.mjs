// Puts picture and sound together and writes the deliverables.
//   node scripts/master.mjs [--deliver out/deliver]
// Needs out/video-16x9.mp4, out/video-9x16.mp4 (scripts/render.mjs) and out/audio/mix.wav (audio/build.py).
// Writes, per cut: the film with sound, a silent version, a thumbnail (frame 0, the end card),
// stills and a one-frame-per-second storyboard sheet.
import { spawn } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { FFMPEG, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const deliver = resolve(ROOT, opt("deliver", "out/deliver"));
const mix = resolve(ROOT, "out/audio/mix.wav");

const ff = (a) => new Promise((res, rej) => {
  const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: "inherit" });
  p.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${a.join(" ")}`))));
});
const node = (script, a) => new Promise((res, rej) => {
  const p = spawn(process.execPath, [join(ROOT, "scripts", script), ...a], { stdio: "inherit" });
  p.on("close", (c) => (c === 0 ? res() : rej(new Error(script))));
});

await mkdir(deliver, { recursive: true });
const STILLS = { "16x9": [3.5, 10.9, 13.9, 31.9], "9x16": [3.5, 10.9, 14.4, 32.0] };
for (const fmt of ["16x9", "9x16"]) {
  const video = resolve(ROOT, `out/video-${fmt}.mp4`);
  if (!existsSync(video)) { console.log(`skip ${fmt}: no ${video}`); continue; }
  const base = join(deliver, `pdf-wizard-launch-${fmt}`);
  // picture is copied as rendered (H.264 High, BT.709); sound is AAC 192k; moov at the front
  await ff(["-i", video, "-i", mix, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", `${base}.mp4`]);
  await ff(["-i", video, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", `${base}-silent.mp4`]);
  await ff(["-i", video, "-frames:v", "1", "-update", "1", `${base}-thumbnail.png`]);
  for (const [i, t] of STILLS[fmt].entries()) await ff(["-ss", String(t), "-i", video, "-frames:v", "1", "-update", "1", `${base}-still-${i + 1}.png`]);
  await node("qa.mjs", ["sheet", `${base}.mp4`, `${base}-storyboard.png`, "--every", "1", "--width", fmt === "9x16" ? "240" : "360", "--cols", fmt === "9x16" ? "10" : "6"]);
  console.log(`delivered ${base}.mp4`);
}
for (const f of ["README.md", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(ROOT, f), join(deliver, f));
process.exit(0);
