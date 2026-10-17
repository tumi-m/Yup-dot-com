/**
 * Builds the browser extension in extension/ into a .zip ready for the
 * Chrome Web Store and Edge Add-ons: dist/pdf-wizard-x-<version>.zip
 *
 *   npm run pack:extension
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import JSZip from "jszip";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const src = join(root, "extension");
const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    // Ship only what the browser loads.
    else if (/\.(json|js|css|png)$/.test(name)) files.push(path);
  }
})(src);

for (const required of ["manifest.json", "content.js", "content.css", ...Object.values(manifest.icons)]) {
  if (!files.some((f) => relative(src, f) === required)) throw new Error(`extension/${required} is missing`);
}

const zip = new JSZip();
for (const file of files.sort()) zip.file(relative(src, file), readFileSync(file), { createFolders: false });
const out = join(root, "dist", `pdf-wizard-x-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`${relative(root, out)}: ${files.length} files, version ${manifest.version}`);
