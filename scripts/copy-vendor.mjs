/**
 * Copies browser runtime assets from node_modules into public/vendor so the
 * app serves them from its own origin. Runs automatically before `dev` and
 * `build` (npm pre-scripts), including on Vercel.
 *
 * Why self-host instead of a CDN:
 * - the tools keep working behind firewalls/CSPs and during CDN outages
 * - no visitor data reaches a third party, matching the privacy promise
 * - paths are version-stamped, so assets can be cached forever and a pdf.js
 *   upgrade can never pair a new API with a stale cached worker
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const out = join(root, "public", "vendor");
// Some packages don't export package.json, so fall back to node_modules/<name>.
const pkgDir = (name) => {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    const dir = join(root, "node_modules", name);
    if (!existsSync(join(dir, "package.json"))) throw new Error(`Missing dependency ${name}`);
    return dir;
  }
};
const version = (name) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// pdf.js worker
const pdfjs = version("pdfjs-dist");
copy(join(pkgDir("pdfjs-dist"), "build", "pdf.worker.min.mjs"), join(out, "pdfjs", pdfjs, "pdf.worker.min.mjs"));

// Tesseract worker + LSTM engine builds (the loader picks one per browser)
const tess = version("tesseract.js");
copy(join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(out, "tesseract", tess, "worker.min.js"));
for (const f of [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
]) {
  copy(join(pkgDir("tesseract.js-core"), f), join(out, "tesseract", tess, "core", f));
}

// ffmpeg.wasm (MP3 conversion in the browser). The class worker and the ESM
// core are served from our origin, so no bundler has to resolve worker URLs.
const ffmpegPkg = version("@ffmpeg/ffmpeg");
for (const f of ["worker.js", "const.js", "errors.js"]) {
  copy(join(pkgDir("@ffmpeg/ffmpeg"), "dist", "esm", f), join(out, "ffmpeg", ffmpegPkg, f));
}
const ffmpegCore = version("@ffmpeg/core");
for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  copy(join(pkgDir("@ffmpeg/core"), "dist", "esm", f), join(out, "ffmpeg-core", ffmpegCore, f));
}

// Language models (LSTM "best_int" variants — what OEM 1 loads)
const langs = ["eng", "spa", "fra", "deu", "por", "ita", "nld"];
for (const lang of langs) {
  const src = join(pkgDir(`@tesseract.js-data/${lang}`), "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (!existsSync(src)) throw new Error(`Missing OCR language data for ${lang}`);
  copy(src, join(out, "tessdata", "4.0.0_best_int", `${lang}.traineddata.gz`));
}

console.log(`vendor assets ready: pdfjs ${pdfjs}, tesseract ${tess}, ${langs.length} OCR languages, ffmpeg ${ffmpegPkg} (core ${ffmpegCore})`);
