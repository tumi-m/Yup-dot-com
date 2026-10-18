// When the Paste button can't read the clipboard, phones were told to
// "Paste with Ctrl+V". They have no Ctrl key.
import { readFileSync } from "node:fs";
import { pasteBlockedHint, pasteBlockedMessage } from "../lib/clipboard.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

check("touch screen", pasteBlockedHint({ touch: true, mac: false }) === "Clipboard blocked. Long-press the box and choose Paste.");
check("iPhone and iPad", pasteBlockedHint({ touch: true, mac: true }) === "Clipboard blocked. Long-press the box and choose Paste.");
check("Windows and Linux", pasteBlockedHint({ touch: false, mac: false }) === "Clipboard blocked. Paste with Ctrl+V.");
check("Mac", pasteBlockedHint({ touch: false, mac: true }) === "Clipboard blocked. Paste with ⌘V.");
check("without a window", pasteBlockedMessage() === "Clipboard blocked. Paste with Ctrl+V.");

for (const file of ["landing/HeroJourney.tsx", "tools/MediaDownloader.tsx", "tools/SlidesImporter.tsx", "tools/PlaylistDownloader.tsx"]) {
  const src = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
  check(`${file}: no fixed Ctrl+V hint`, !src.includes("Ctrl+V") && src.includes("pasteBlockedMessage()"));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
