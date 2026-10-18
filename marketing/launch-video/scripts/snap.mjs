// Stills and contact sheets straight from the film page.
//   node scripts/snap.mjs --fmt 16x9 --out out/snap --beats            one frame per beat (+0.12 s)
//   node scripts/snap.mjs --fmt 16x9 --out out/snap --times 1,2.5,10   given times
//   node scripts/snap.mjs --fmt 16x9 --out out/snap --from 9 --to 11 --step 0.1
//   add --cols 6 --thumb 480 to change the sheet, --full to keep full-size PNGs
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve, launch, openFilm, seekShot, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = (k) => args.includes(`--${k}`);
const fmt = opt("fmt", "16x9");
const out = resolve(ROOT, opt("out", `out/snap-${fmt}`));
const cols = +opt("cols", fmt === "9x16" ? 8 : 5);
const thumb = +opt("thumb", fmt === "9x16" ? 270 : 384);
const label = opt("label", "");

let times = [];
if (flag("beats")) for (let t = 0; t < 38; t += 0.5) times.push(+(t + +opt("offset", 0.12)).toFixed(3));
else if (opt("times")) times = opt("times").split(",").map(Number);
else { const a = +opt("from", 0), b = +opt("to", 38), s = +opt("step", 1); for (let t = a; t <= b + 1e-9; t += s) times.push(+t.toFixed(3)); }

await mkdir(out, { recursive: true });
const srv = await serve();
const browser = await launch();
const { page } = await openFilm(browser, srv.url, fmt);
const shots = [];
for (const t of times) {
  const keep = flag("full") || times.length <= 12;
  const name = `t${t.toFixed(3).padStart(7, "0")}.png`;
  if (keep) await writeFile(join(out, name), await seekShot(page, t));
  const jpg = await seekShot(page, t, { type: "jpeg" });
  shots.push({ t, src: `data:image/jpeg;base64,${jpg.toString("base64")}` });
}
// contact sheet, laid out in the same browser
const ratio = fmt === "9x16" ? 16 / 9 : 9 / 16;
const sheet = await browser.newPage({ viewport: { width: cols * (thumb + 8) + 8, height: 400 } });
await sheet.setContent(`<html><body style="margin:0;background:#15121f;font:600 15px ui-monospace,monospace;color:#e9e4ff">
<div style="display:grid;grid-template-columns:repeat(${cols},${thumb}px);gap:8px;padding:8px">
${shots.map((s) => `<div style="position:relative"><img src="${s.src}" style="width:${thumb}px;height:${Math.round(thumb * ratio)}px;display:block"><span style="position:absolute;left:6px;top:4px;background:rgba(10,8,20,.72);padding:2px 6px;border-radius:4px">${s.t.toFixed(2)}${label ? " " + label : ""}</span></div>`).join("")}
</div></body></html>`);
const sheetPng = await sheet.screenshot({ fullPage: true });
await writeFile(join(out, "sheet.png"), sheetPng);
console.log(`${shots.length} frames -> ${join(out, "sheet.png")}`);
await browser.close();
await srv.close();
process.exit(0);
