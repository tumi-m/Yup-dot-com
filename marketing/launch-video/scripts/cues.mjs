// Exports the sound cues from the film itself (one source of truth for picture and sound).
//   node scripts/cues.mjs [--fmt 16x9] [--out out/audio/cues.json]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { serve, launch, openFilm, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const fmt = opt("fmt", "16x9");
const out = resolve(ROOT, opt("out", "out/audio/cues.json"));
const srv = await serve();
const browser = await launch();
const { page } = await openFilm(browser, srv.url, fmt);
const data = await page.evaluate(() => ({
  duration: FILM.duration,
  timeline: FILM.tl,
  cues: FILM.cues.map((c) => ({ ...c, pan: +(0.75 * FILM.panFor(c)).toFixed(3) })),
}));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(data, null, 1));
console.log(`${data.cues.length} cues -> ${out}`);
const kinds = {};
for (const c of data.cues) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
console.log(kinds);
await browser.close();
await srv.close();
process.exit(0);
