/**
 * Builds the browser extension in extension/ into a .zip ready for the
 * Chrome Web Store and Edge Add-ons: dist/pdf-wizard-x-<version>.zip
 *
 * Only manifest.json and the files it names (content scripts and styles,
 * icons, pages and the files those pages load) go in. Nothing else in
 * extension/ can be shipped by accident: not the README, an editor's
 * settings or a git-ignored .env file. Anyone can download a store
 * package, so every packed file is also searched for secrets.
 *
 *   npm run pack:extension
 *   node scripts/pack-extension.mjs [extension dir] [output dir]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import JSZip from "jszip";
import secretScan from "../lib/secret-scan.cjs";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const src = resolve(process.argv[2] ?? join(root, "extension"));
const outDir = resolve(process.argv[3] ?? join(root, "dist"));

function fail(message) {
  console.error(`Extension not packed: ${message}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));

/** Every file manifest.json names. */
function manifestFiles(m) {
  const names = ["manifest.json"];
  const add = (v) => {
    if (typeof v === "string") names.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(add);
  };
  add(m.icons);
  for (const cs of m.content_scripts ?? []) [...(cs.js ?? []), ...(cs.css ?? [])].forEach(add);
  for (const action of [m.action, m.browser_action, m.page_action]) {
    if (action) [action.default_popup, action.default_icon].forEach(add);
  }
  add(m.background?.service_worker);
  (m.background?.scripts ?? []).forEach(add);
  [m.options_page, m.options_ui?.page, m.devtools_page, m.side_panel?.default_path].forEach(add);
  for (const w of m.web_accessible_resources ?? []) (typeof w === "string" ? [w] : w.resources ?? []).forEach(add);
  return names;
}

/** Local files an extension page loads (<script src>, <link href>, <img src>). */
function pageFiles(page, html) {
  const found = [];
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/gi)) {
    if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(m[1])) found.push(posix.join(posix.dirname(page), m[1]));
  }
  return found;
}

const files = new Set();
const queue = manifestFiles(manifest);
while (queue.length) {
  const name = posix.normalize(queue.shift().replace(/^\.\//, ""));
  if (files.has(name)) continue;
  if (name.startsWith("/") || name.startsWith("..") || /[*?[\]{}]/.test(name)) {
    fail(`manifest.json names "${name}". List each file by its path inside extension/ (no wildcards).`);
  }
  if (name.split("/").some((part) => part.startsWith("."))) fail(`"${name}" is a hidden file; it won't be packed.`);
  const path = join(src, name);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`extension/${name} is missing.`);
  files.add(name);
  if (/\.html?$/i.test(name)) queue.push(...pageFiles(name, readFileSync(path, "utf8")));
}

const values = secretScan.serverValues(process.env);
for (const name of files) {
  const text = readFileSync(join(src, name)).toString("latin1");
  const found = secretScan.findSecrets(text)[0];
  if (found) fail(`extension/${name} holds ${found.kind}.`);
  const value = values.find(([, v]) => text.includes(v));
  if (value) fail(`extension/${name} holds the value of ${value[0]}.`);
}

const zip = new JSZip();
for (const name of [...files].sort()) zip.file(name, readFileSync(join(src, name)), { createFolders: false });
const out = join(outDir, `pdf-wizard-x-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`${relative(process.cwd(), out)}: ${files.size} files, version ${manifest.version}`);
console.log(`  ${[...files].sort().join("\n  ")}`);
