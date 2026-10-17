/**
 * Browser extension: the link helpers in extension/content.js, run in a
 * sandbox with a minimal DOM stand-in. Its in-page behaviour (button in the
 * action bar, menu, keyboard, opening the right tool) is checked in Chromium
 * with the extension loaded.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
check("manifest v3, no permissions requested", manifest.manifest_version === 3 && !manifest.permissions && !manifest.host_permissions);
check("runs only on X", manifest.content_scripts[0].matches.every((m: string) => /^https:\/\/(mobile\.)?(x|twitter)\.com\/\*$/.test(m)));
check("icons exist", Object.values(manifest.icons).every((p) => readFileSync(`extension/${p}`).length > 100));

const sandbox: Record<string, unknown> = {
  location: { origin: "https://x.com" },
  document: { querySelectorAll: () => [], documentElement: {}, addEventListener: () => {}, body: {} },
  MutationObserver: class { observe() {} },
  requestAnimationFrame: () => 0,
  getComputedStyle: () => ({ backgroundColor: "rgb(0, 0, 0)" }),
  matchMedia: () => ({ matches: false }),
  Element: class {},
  URL,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync("extension/content.js", "utf8"), sandbox);
const { statusUrl, toolUrl } = sandbox.__pdfWizardX as { statusUrl: (h: string) => string | null; toolUrl: (p: string, k: string) => string };

const cases: [string, string | null][] = [
  ["/NASA/status/1790866466429911046", "https://x.com/i/status/1790866466429911046"],
  ["https://twitter.com/a/status/12345/video/2", "https://x.com/i/status/12345/video/2"],
  ["/gifs/status/22222/photo/1", "https://x.com/i/status/22222"],
  ["/i/web/status/99999", "https://x.com/i/status/99999"],
  ["https://mobile.x.com/u/statuses/123456", "https://x.com/i/status/123456"],
  ["/NASA/status/1790866466429911046/analytics", "https://x.com/i/status/1790866466429911046"],
  ["https://evil.com/a/status/12345", null],
  ["https://x.com.evil.com/a/status/12345", null],
  ["/a/likes", null],
  ["javascript:alert(1)", null],
];
for (const [href, want] of cases) check(`statusUrl(${href})`, statusUrl(href) === want, String(statusUrl(href)));

const u = new URL(toolUrl("https://x.com/i/status/12345", "mp3"));
check("MP3 goes to the X to MP3 tool", u.origin === "https://pdfwizard.xyz" && u.pathname === "/tools/x-to-mp3" && u.searchParams.get("url") === "https://x.com/i/status/12345");
check("MP4 goes to the X to MP4 tool", new URL(toolUrl("https://x.com/i/status/1", "mp4")).pathname === "/tools/x-to-mp4");
check("visits from the extension are labelled", u.searchParams.get("utm_source") === "extension");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
