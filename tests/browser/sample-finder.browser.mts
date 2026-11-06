/**
 * The Sample Finder in a real browser: homepage → YouTube link → song →
 * results; a low-confidence pick; "Not this song?" → Type it; typed songs;
 * a TikTok sound; MusicBrainz busy; a shared link opening from the cache;
 * the TikTok downloader's "Find samples" link; keyboard tabs; reduced
 * motion; 1440, 390 and 360px wide; and, last, the guest's daily limit.
 *
 * Starts `next dev` with tests/fakes/samples-net.cjs preloaded, so YouTube
 * oEmbed, MusicBrainz and TikTok answer from tests/fixtures and nothing
 * leaves the machine. Or set BASE_URL to use a server already running with
 * that preload.
 *
 *   npm run test:browser            (CHROME_PATH, PORT optional)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const root = new URL("../../", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 3807);
const BASE = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const SHOTS = process.env.SHOTS_DIR ?? null;
const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

let server: ChildProcess | null = null;
/** What the project root held before: next dev writes a notes file there, removed again at the end. */
const rootBefore = new Set(readdirSync(root));

async function startServer() {
  if (process.env.BASE_URL) return;
  server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${root}tests/fakes/samples-net.cjs`].filter(Boolean).join(" "),
      MEDIA_SIGNING_SECRET: "browser-test-only-signing-secret",
      // Each browser context below sends its own X-Forwarded-For, so each is
      // its own guest with its own allowances (next dev passes it through).
      TRUSTED_PROXY_HOPS: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`${BASE}/tools/sample-finder`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("next dev didn't start");
}

async function stopServer() {
  if (server?.pid) {
    // The process group we started (npx and the next it runs), by its id.
    const group = -server.pid;
    try {
      process.kill(group, "SIGTERM");
    } catch {}
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(group, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      process.kill(group, "SIGKILL");
    } catch {}
  }
  if (!process.env.BASE_URL) {
    for (const f of readdirSync(root)) if (!rootBefore.has(f) && f.endsWith(".md")) rmSync(`${root}${f}`, { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const errors: string[] = [];
let visitor = 10;
async function newPage(browser: Browser, opts: Parameters<Browser["newContext"]>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  // A new guest each time (see TRUSTED_PROXY_HOPS above).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": `192.0.2.${visitor++}` }, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon|Download the React DevTools/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`);
  });
  return { ctx, page };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const resultsDone = (page: Page) =>
  page.locator('[data-testid="results"]:not([data-state="loading"]):not([data-state="idle"])').waitFor({ timeout: 30_000 });

async function noSideScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function typeAndFind(page: Page, text: string) {
  await page.goto(`${BASE}/tools/sample-finder`);
  const input = page.getByTestId("sample-input");
  await input.waitFor();
  await input.fill(text);
  await page.getByRole("button", { name: "Find samples" }).click();
}

/* ------------------------------------------------------------------ */
/* Flows                                                               */
/* ------------------------------------------------------------------ */

async function homepageFlow(browser: Browser, width: number) {
  const label = `${width}px`;
  const { ctx, page } = await newPage(browser, { viewport: { width, height: 900 } });
  await page.goto(`${BASE}/#media`);
  const box = page.locator("#journey-media-url");
  await box.waitFor();
  await box.fill("https://youtu.be/strongerVID");
  const action = page.getByRole("link", { name: "Find samples" });
  await action.waitFor();
  check(`${label} homepage: YouTube link → Find samples (downloads paused)`, (await action.count()) === 1);
  check(`${label} homepage: says downloads are paused`, await page.getByText("Downloads are paused. You can still find this song's samples.").isVisible());
  const thumbRequest = page.waitForRequest((r) => r.url().startsWith("https://i.ytimg.com/"), { timeout: 30_000 }).catch(() => null);
  await action.click();
  await page.waitForURL(/\/tools\/sample-finder/);
  const card = page.getByTestId("song-card");
  await card.waitFor({ timeout: 30_000 });
  check(`${label} song card: title and artist`, (await page.getByTestId("song-title").textContent()) === "Stronger" && (await page.getByTestId("song-artist").textContent())!.startsWith("Kanye West · 2007"));
  check(`${label} song card: from the video`, (await page.getByTestId("song-from").textContent())!.includes("Kanye West - Stronger (Official Music Video)"));
  const thumb = await thumbRequest;
  check(`${label} song card: the thumbnail comes from YouTube's image host, with no referrer`, !!thumb && !thumb.headers()["referer"], thumb?.headers());
  // The fake network can't serve i.ytimg.com, so here the image fails: the drawn record takes its place.
  await page.getByTestId("song-vinyl").waitFor({ timeout: 10_000 }).catch(() => {});
  check(`${label} song card: a thumbnail that fails → the drawn record`, (await page.getByTestId("song-vinyl").count()) === 1);
  await resultsDone(page);
  check(`${label} address bar: the song, not the video link`, /\?q=Kanye\+West\+%E2%80%93\+Stronger&rec=00000000-0000-4000-8000-00000000a001/.test(page.url()) && !page.url().includes("youtu"), page.url());
  const samplesTab = page.getByTestId("tab-samples");
  await page.waitForTimeout(900); // the counts count up
  check(`${label} tabs: Samples 1, selected`, (await samplesTab.getAttribute("aria-selected")) === "true" && (await samplesTab.textContent())!.includes("1"), await samplesTab.textContent());
  const row = page.getByTestId("relation-row").first();
  check(`${label} row: Harder, Better, Faster, Stronger, hand-checked`, (await row.textContent())!.includes("Harder, Better, Faster, Stronger") && (await row.getAttribute("data-source")) === "catalog");
  check(`${label} row: element chip`, (await row.getByTestId("element-chip").textContent()) === "Vocals / lyrics");
  check(`${label} row: years apart`, (await row.textContent())!.includes("2001 · 6 years apart"));
  const listen = row.getByTestId("listen-link");
  const href = (await listen.getAttribute("href"))!;
  check(`${label} Listen: a YouTube search, new tab, no opener`, href.startsWith("https://www.youtube.com/results?search_query=Daft+Punk+Harder") && (await listen.getAttribute("target")) === "_blank" && (await listen.getAttribute("rel")) === "noopener noreferrer", href);
  check(`${label} fact line`, (await page.getByTestId("tab-fact").textContent())!.includes("samples a 2001 record"));
  check(`${label} no horizontal scroll`, await noSideScroll(page));
  await shot(page, `results-${width}`);
  await ctx.close();
}

async function lowConfidenceAndTypeIt(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "https://www.youtube.com/watch?v=lowConfVid1");
  const picker = page.getByTestId("candidate-picker");
  await picker.waitFor({ timeout: 30_000 });
  check("low confidence: asks which song", await page.getByText("Which song is this?").isVisible());
  const options = page.getByTestId("candidate");
  check("low confidence: both songs offered", (await options.count()) === 2, await options.allTextContents());
  check("…and Type it doesn't offer the uploader's channel as the artist", (await page.locator("#type-artist").inputValue()) === "" && (await page.locator("#type-title").inputValue()) === "Stronger");
  await shot(page, "picker");
  await options.filter({ hasText: "Kanye West" }).click();
  await page.getByTestId("song-card").waitFor();
  await resultsDone(page);
  check("picked an alternative → its results", (await page.getByTestId("song-artist").textContent())!.startsWith("Kanye West") && (await page.getByTestId("relation-row").count()) >= 1);

  // Not this song? → Type it
  await page.getByTestId("not-this-song").click();
  const form = page.getByTestId("type-it");
  await form.waitFor();
  check("Not this song? opens the picker with Type it", await form.isVisible());
  await page.locator("#type-artist").fill("Daft Punk");
  await page.locator("#type-title").fill("Harder, Better, Faster, Stronger");
  await form.getByRole("button", { name: "Find this song" }).click();
  await page.getByTestId("song-title").filter({ hasText: "Harder, Better, Faster, Stronger" }).waitFor({ timeout: 30_000 });
  await resultsDone(page);
  await page.waitForTimeout(900);
  check("typed song → its connections", (await page.getByTestId("tab-sampled").textContent())!.includes("1") && (await page.getByTestId("tab-remixes").textContent())!.includes("1"));
  await page.getByTestId("tab-remixes").click();
  check("remixes tab lists the remix", (await page.getByRole("tabpanel").textContent())!.includes("Neptunes"));
  await ctx.close();
}

async function typedAndCovers(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "Johnny Cash – Hurt");
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  await resultsDone(page);
  check("typed Artist – Title → the song", (await page.getByTestId("song-title").textContent()) === "Hurt");
  check("no video → a drawn record", (await page.getByTestId("song-vinyl").count()) === 1);
  check("covers tab opens first", (await page.getByTestId("tab-covers").getAttribute("aria-selected")) === "true");
  const panel = await page.getByRole("tabpanel").textContent();
  check("This covers: Nine Inch Nails, 1994", panel!.includes("This covers") && panel!.includes("Nine Inch Nails") && panel!.includes("1994"), panel);
  check("zero tabs are dimmed", (await page.getByTestId("tab-samples").getAttribute("class"))!.includes("opacity-60"));
  await ctx.close();
}

async function tiktokFlow(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "https://www.tiktok.com/@liftsalot/video/7300000000000000001");
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  check("TikTok with a song → that song", (await page.getByTestId("song-title").textContent()) === "Stronger" && (await page.getByTestId("song-from").textContent())!.includes("@liftsalot"));
  await typeAndFind(page, "https://www.tiktok.com/@catperson/video/7300000000000000002");
  await page.getByTestId("tool-error").waitFor();
  check("TikTok original sound → says so, offers Type it", (await page.getByTestId("tool-error").textContent())!.includes("original sound") && (await page.getByRole("button", { name: "Type it" }).count()) === 1);
  await ctx.close();
}

async function busyFlow(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "Avicii – Levels");
  await page.getByTestId("busy-note").waitFor({ timeout: 40_000 });
  check("MusicBrainz busy → the note and a retry", (await page.getByTestId("busy-note").textContent())!.includes("MusicBrainz is busy") && (await page.getByRole("button", { name: "Try again" }).count()) === 1);
  check("…with the hand-checked results", (await page.getByTestId("relation-row").first().textContent())!.includes("Something's Got a Hold on Me"));
  await shot(page, "busy");
  await ctx.close();
}

async function shareFlow(browser: Browser) {
  const { ctx, page } = await newPage(browser, { permissions: ["clipboard-read", "clipboard-write"] });
  await typeAndFind(page, "Kanye West – Stronger");
  await resultsDone(page);
  await page.getByTestId("share").click();
  await page.getByText("Link copied").waitFor();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check("Share copies a ?q=&rec= link", /\/tools\/sample-finder\?q=Kanye\+West\+%E2%80%93\+Stronger&rec=00000000-0000-4000-8000-00000000a001$/.test(link), link);
  const second = await ctx.newPage();
  const bodies: string[] = [];
  second.on("request", (r) => r.url().endsWith("/api/samples/lookup") && bodies.push(r.postData() ?? ""));
  await second.goto(link);
  await resultsDone(second);
  check("the shared link asks the cache only", bodies.length === 1 && JSON.parse(bodies[0]).cacheOnly === true, bodies);
  check("…and renders the full result", (await second.getByTestId("results").getAttribute("data-state")) === "done" && (await second.getByTestId("song-title").textContent()) === "Stronger" && (await second.getByTestId("relation-row").count()) >= 1);
  await ctx.close();
}

async function downloaderLink(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/tools/tiktok-to-mp4`);
  const box = page.locator("#media-url");
  await box.waitFor();
  await box.fill("https://youtu.be/strongerVID");
  const link = page.getByRole("link", { name: "Find this song's samples →" });
  await link.waitFor();
  check("TikTok downloader: YouTube link → paused note with Find samples", (await page.getByText("YouTube downloads are paused for now.").count()) === 1 && (await link.getAttribute("href")) === `/tools/sample-finder?url=${encodeURIComponent("https://www.youtube.com/watch?v=strongerVID")}`);
  await link.click();
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  check("…which opens the song straight away", (await page.getByTestId("song-title").textContent()) === "Stronger");
  await ctx.close();
}

async function keyboardFlow(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "Daft Punk – Harder, Better, Faster, Stronger");
  await resultsDone(page);
  await page.waitForTimeout(800); // the results land and count up
  await page.getByTestId("tab-samples").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100); // Radix moves focus on the next tick
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check("ArrowRight moves to Sampled in and opens it", focused === "tab-sampled" && (await page.getByTestId("tab-sampled").getAttribute("aria-selected")) === "true", focused);
  check("the tab is in the address", page.url().includes("tab=sampled"), page.url());
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  check("End jumps to Remixes", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "tab-remixes");
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  check("Tab leaves the tabs for the panel", next === "tabpanel", next);
  await page.keyboard.press("Tab");
  check("…then the first Listen link", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "listen-link");
  await ctx.close();
}

async function reducedMotion(browser: Browser) {
  const { ctx, page } = await newPage(browser, { reducedMotion: "reduce" });
  await typeAndFind(page, "Kanye West – Stronger");
  const row = page.getByTestId("relation-row").first();
  await row.waitFor({ timeout: 30_000 });
  const transform = await row.evaluate((el) => getComputedStyle(el).transform);
  check("reduced motion: rows don't move in", transform === "none", transform);
  await resultsDone(page);
  check("reduced motion: results still show", (await page.getByTestId("relation-row").count()) >= 1);
  await ctx.close();
}

async function narrow(browser: Browser) {
  const { ctx, page } = await newPage(browser, { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/tools/sample-finder`);
  await page.getByTestId("sample-input").waitFor();
  check("360px: no horizontal scroll on the empty tool", await noSideScroll(page));
  await page.getByTestId("sample-input").fill("Daft Punk – Harder, Better, Faster, Stronger");
  await page.getByRole("button", { name: "Find samples" }).click();
  await resultsDone(page);
  check("360px: no horizontal scroll with results", await noSideScroll(page));
  await shot(page, "results-360");
  await ctx.close();
}

async function limitFlow(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/tools/sample-finder`);
  await page.getByTestId("sample-input").waitFor();
  // Use up the rest of the guest's day on songs with nothing connected.
  const statuses = await page.evaluate(async (ids) => {
    const out: number[] = [];
    for (const rec of ids) {
      const r = await fetch("/api/samples/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rec, artist: "Someone", title: `Song ${rec}` }) });
      out.push(r.status);
      if (r.status === 429) break;
    }
    return out;
  }, Array.from({ length: 12 }, (_, i) => id(`ff${String(i).padStart(2, "0")}`)));
  check("guest: lookups run out within 10", statuses.includes(429) && statuses.filter((s) => s === 200).length <= 10, statuses);
  // A song nobody has looked up yet (one already cached would be free).
  await typeAndFind(page, "Etta James – Something's Got a Hold on Me");
  await page.getByTestId("limit-banner").waitFor({ timeout: 30_000 });
  check("limit reached → the banner", (await page.getByTestId("limit-banner").textContent())!.includes("Daily lookups used"));
  check("…and the hand-checked results are still there", (await page.getByTestId("relation-row").count()) >= 2);
  await page.getByTestId("limit-banner").click();
  await page.getByRole("dialog").waitFor();
  check("…which offers more lookups", (await page.getByRole("dialog").textContent())!.includes("Daily lookups used"));
  await shot(page, "limit");
  await ctx.close();
}

/* ------------------------------------------------------------------ */

let browser: Browser | null = null;
try {
  await startServer();
  browser = await chromium.launch({ executablePath: CHROME, args: ["--disable-dev-shm-usage", "--disable-gpu"] });
  for (const width of [1440, 390]) await homepageFlow(browser, width);
  await lowConfidenceAndTypeIt(browser);
  await typedAndCovers(browser);
  await tiktokFlow(browser);
  await busyFlow(browser);
  await shareFlow(browser);
  await downloaderLink(browser);
  await keyboardFlow(browser);
  await reducedMotion(browser);
  await narrow(browser);
  await limitFlow(browser);
  check("no page errors", errors.length === 0, errors);
} catch (err) {
  check(`ran to the end (${err instanceof Error ? err.message.split("\n")[0] : err})`, false);
} finally {
  await browser?.close();
  await stopServer();
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
