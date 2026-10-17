// Shared helpers: a tiny static server for the project folder, Chromium, and the film page.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
export const FFMPEG = process.env.FFMPEG || join(ROOT, "node_modules/@ffmpeg-installer/linux-x64/ffmpeg");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav",
};

export async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const s = await stat(path);
      if (!s.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Chromium: CHROME_PATH, else Playwright's own, else any chromium under PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers. */
export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { if (existsSync(chromium.executablePath())) return undefined; } catch { /* not installed */ }
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = join(base, d, "chrome-linux/chrome");
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export async function launch() {
  return chromium.launch({
    executablePath: chromePath(),
    args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text", "--hide-scrollbars", "--disable-gpu-vsync"],
  });
}

export const SIZE = { "16x9": { w: 1920, h: 1080 }, "9x16": { w: 1080, h: 1920 } };

/** Open the film in render mode and wait until it has built. */
export async function openFilm(browser, base, fmt, scale = 1) {
  const { w, h } = SIZE[fmt];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[page] ${e.message}`));
  await page.goto(`${base}/film/film.html?fmt=${fmt}&render`, { waitUntil: "load" });
  await page.waitForFunction(() => window.FILM && window.FILM.isReady, null, { timeout: 60000 });
  return { ctx, page };
}

/** Seek to t and wait for two animation frames so the paint has landed. */
export async function seekShot(page, t, opts = {}) {
  await page.evaluate(async (tt) => {
    window.FILM.seek(tt);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, t);
  const o = { type: opts.type || "png", clip: opts.clip, animations: "disabled", caret: "hide" };
  if (o.type === "jpeg") o.quality = opts.quality || 82;
  return page.screenshot(o);
}
