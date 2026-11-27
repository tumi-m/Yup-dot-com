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

// pdf.js worker: the legacy build, like the app's own pdf.js (lib/pdf/worker.ts).
// Its own path, so browsers that cached the modern worker don't keep it.
const pdfjs = version("pdfjs-dist");
copy(
  join(pkgDir("pdfjs-dist"), "legacy", "build", "pdf.worker.min.mjs"),
  join(out, "pdfjs", pdfjs, "legacy", "pdf.worker.min.mjs")
);

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

// MozJPEG encoder/decoder (lib/image-codec.ts), loaded only when a tool needs it.
const jsquash = version("@jsquash/jpeg");
copy(join(pkgDir("@jsquash/jpeg"), "codec", "enc", "mozjpeg_enc.wasm"), join(out, "jsquash-jpeg", jsquash, "mozjpeg_enc.wasm"));
copy(join(pkgDir("@jsquash/jpeg"), "codec", "dec", "mozjpeg_dec.wasm"), join(out, "jsquash-jpeg", jsquash, "mozjpeg_dec.wasm"));

// Noto Sans and Noto Sans Mono (SIL Open Font License 1.1) for Text and
// Markdown to PDF and Translate PDF (lib/pdf/text-to-pdf/fonts.ts): each
// style split by alphabet, so a text only fetches the files it needs. Mono
// has no Devanagari. The licence goes with them.
const SUBSETS = ["latin", "latin-ext", "greek", "greek-ext", "cyrillic", "cyrillic-ext", "vietnamese"];
const noto = {
  "@fontsource/noto-sans": { styles: ["400-normal", "700-normal", "400-italic", "700-italic"], subsets: [...SUBSETS, "devanagari"] },
  "@fontsource/noto-sans-mono": { styles: ["400-normal", "700-normal"], subsets: SUBSETS },
};
const fontVersions = [];
for (const [pkg, { styles, subsets }] of Object.entries(noto)) {
  const family = pkg.split("/")[1];
  const v = version(pkg);
  fontVersions.push(`${family} ${v}`);
  const dir = join(out, family, v);
  for (const subset of subsets) {
    for (const style of styles) {
      const file = `${family}-${subset}-${style}.woff`;
      copy(join(pkgDir(pkg), "files", file), join(dir, file));
    }
  }
  copy(join(pkgDir(pkg), "LICENSE"), join(dir, "LICENSE.txt"));
}

// Language models (LSTM "best_int" variants — what OEM 1 loads)
const langs = ["eng", "spa", "fra", "deu", "por", "ita", "nld"];
for (const lang of langs) {
  const src = join(pkgDir(`@tesseract.js-data/${lang}`), "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (!existsSync(src)) throw new Error(`Missing OCR language data for ${lang}`);
  copy(src, join(out, "tessdata", "4.0.0_best_int", `${lang}.traineddata.gz`));
}

console.log(`vendor assets ready: pdfjs ${pdfjs}, tesseract ${tess}, ${langs.length} OCR languages, ffmpeg ${ffmpegPkg} (core ${ffmpegCore}), mozjpeg ${jsquash}, ${fontVersions.join(", ")}`);
