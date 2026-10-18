// Builds the demo proposal.pdf whose Compress PDF result the film shows ("1 file · 42 KB",
// "98% smaller"): three A4 pages, two of them with a full-width photo. The photos are drawn
// in code (sky, hills, buildings, grain), so the file is made-up and needs no stock media.
//   node scripts/demo-pdf.mjs [out/demo/proposal.pdf]
// Then drop it on the app's Compress PDF tool (Recommended quality) and read the result line.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"; // the app's own dependency
import { launch, ROOT } from "./lib.mjs";

const out = resolve(ROOT, process.argv[2] || "out/demo/proposal.pdf");
const browser = await launch();
const page = await browser.newPage();
const photos = await page.evaluate(async () => {
  const res = [];
  for (const seed of [3, 11]) {
    let a = seed;
    const R = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const c = document.createElement("canvas");
    c.width = 2400; c.height = 1600;
    const g = c.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 1000);
    sky.addColorStop(0, seed === 3 ? "#7fa7d9" : "#e9a46b");
    sky.addColorStop(1, seed === 3 ? "#dfe9f2" : "#f6dcb8");
    g.fillStyle = sky;
    g.fillRect(0, 0, 2400, 1600);
    for (let k = 0; k < 4; k++) {
      g.fillStyle = `hsl(${110 + k * 12}, 28%, ${42 - k * 7}%)`;
      g.beginPath();
      g.moveTo(0, 1600);
      for (let x = 0; x <= 2400; x += 40) g.lineTo(x, 760 + k * 170 + Math.sin(x / (300 + k * 90) + seed + k) * 90 + R() * 30);
      g.lineTo(2400, 1600);
      g.fill();
    }
    for (let i = 0; i < 26; i++) {
      const w = 60 + R() * 160, h = 120 + R() * 380, x = R() * 2400, y = 1100 - h + R() * 200;
      g.fillStyle = `hsl(${200 + R() * 40}, 12%, ${55 + R() * 30}%)`;
      g.fillRect(x, y, w, h);
      g.fillStyle = "rgba(30,40,60,0.35)";
      for (let r = y + 14; r < y + h - 14; r += 26) for (let q = x + 10; q < x + w - 16; q += 24) g.fillRect(q, r, 12, 14);
    }
    const img = g.getImageData(0, 0, 2400, 1600);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (R() + R() + R() - 1.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
    res.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
  }
  return res;
});
await browser.close();

const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
const b = await doc.embedFont(StandardFonts.HelveticaBold);
const imgs = [];
for (const ph of photos) imgs.push(await doc.embedJpg(Uint8Array.from(ph)));
const body = [
  "We propose to rebuild the company website so that customers can find",
  "services, prices and contact details in a few taps on any phone.",
  "The work covers content, design, build and a hand-over session.",
];
for (let n = 1; n <= 3; n++) {
  const pg = doc.addPage([595, 842]);
  pg.drawRectangle({ x: 0, y: 772, width: 595, height: 70, color: rgb(0.486, 0.227, 0.929) });
  pg.drawText("Project Proposal", { x: 50, y: 795, size: 26, font: b, color: rgb(1, 1, 1) });
  pg.drawText(`Section ${n}`, { x: 50, y: 720, size: 18, font: b });
  body.forEach((l, i) => pg.drawText(l, { x: 50, y: 690 - i * 18, size: 11, font: f, color: rgb(0.2, 0.2, 0.25) }));
  if (n === 1) {
    pg.drawText("Status", { x: 50, y: 560, size: 12, font: b });
    pg.drawRectangle({ x: 110, y: 548, width: 300, height: 30, borderColor: rgb(0.77, 0.71, 0.99), borderWidth: 1, color: rgb(0.96, 0.95, 1) });
    pg.drawLine({ start: { x: 50, y: 420 }, end: { x: 260, y: 420 }, thickness: 1, color: rgb(0.58, 0.64, 0.72) });
    pg.drawText("Signature", { x: 50, y: 405, size: 10, font: f, color: rgb(0.4, 0.4, 0.45) });
  } else {
    pg.drawImage(imgs[n - 2], { x: 50, y: 300, width: 495, height: 330 });
    pg.drawText(n === 2 ? "Timeline and site photos" : "Budget and next steps", { x: 50, y: 270, size: 12, font: b });
  }
  pg.drawText(`${n} / 3`, { x: 280, y: 30, size: 10, font: f });
}
const bytes = await doc.save();
await mkdir(dirname(out), { recursive: true });
await writeFile(out, bytes);
console.log(`${out}: ${bytes.length} bytes`);
process.exit(0);
