/**
 * The Sample Finder in a real browser: homepage → YouTube link → song →
 * results; a low-confidence pick; "Not this song?" → Type it; typed songs;
 * a TikTok sound; MusicBrainz busy; a shared link opening from the cache;
 * the TikTok downloader's "Find samples" link; keyboard tabs; reduced
 * motion; 1440, 390, 360 and 320px wide; and, last, the guest's daily limit.
 * Also: a shared link that isn't cached (or names another song) never shows
 * its words as the song; Back after "Find its samples"; a song MusicBrainz
 * doesn't have; MusicBrainz busy or failing with nothing on our list; focus
 * after "Keep this song"; one view at a time while they swap; a press before
 * the page is ready; warnings only once typing pauses; tap sizes.
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
  // Empty tabs stay readable (they can still be chosen): only the 0 says they're empty.
  const zero = page.getByTestId("tab-samples");
  check("zero tabs aren't dimmed", !(await zero.getAttribute("class"))!.includes("opacity-") && (await zero.evaluate((el) => getComputedStyle(el).opacity)) === "1" && (await zero.textContent()) === "Samples0", await zero.textContent());
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
  check("…and no claim about what MusicBrainz has", (await page.getByText("Nothing on record yet.", { exact: true }).count()) === 0 && (await page.getByText("Add it on MusicBrainz", { exact: true }).count()) === 0 && (await page.getByTestId("tab-sampled").textContent()) === "Sampled in");
  await shot(page, "busy");
  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.getByTestId("busy-note").waitFor({ timeout: 40_000 });
  check("Try again keeps focus in the card (on the song's title)", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "song-title");
  await ctx.close();
}

async function shareFlow(browser: Browser) {
  const { ctx, page } = await newPage(browser, { permissions: ["clipboard-read", "clipboard-write"] });
  await typeAndFind(page, "Kanye West – Stronger");
  await resultsDone(page);
  // The numbers are final as soon as the results land: nothing counts up in a sentence or a tab.
  check("the fact line and tabs show their final numbers at once", (await page.getByTestId("tab-fact").textContent()) === "Stronger (2007) samples a 2001 record, 6 years apart." && (await page.getByTestId("tab-samples").textContent()) === "Samples1", [await page.getByTestId("tab-fact").textContent(), await page.getByTestId("tab-samples").textContent()]);
  check("screen readers hear \"1 connection found.\"", (await page.getByTestId("results-summary").textContent()) === "1 connection found.", await page.getByTestId("results-summary").textContent());
  await page.getByTestId("share").click();
  await page.getByText("Link copied", { exact: true }).first().waitFor();
  check("\"Link copied\" is announced", (await page.getByTestId("share-status").textContent()) === "Link copied" && (await page.getByTestId("share-status").getAttribute("aria-live")) === "polite");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check("Share copies a ?q=&rec= link", /\/tools\/sample-finder\?q=Kanye\+West\+%E2%80%93\+Stronger&rec=00000000-0000-4000-8000-00000000a001$/.test(link), link);
  const second = await ctx.newPage();
  const bodies: string[] = [];
  second.on("request", (r) => r.url().endsWith("/api/samples/lookup") && bodies.push(r.postData() ?? ""));
  await second.goto(link);
  await resultsDone(second);
  check("the shared link asks the cache only", bodies.length === 1 && JSON.parse(bodies[0]).cacheOnly === true, bodies);
  check("…and renders the full result", (await second.getByTestId("results").getAttribute("data-state")) === "done" && (await second.getByTestId("song-title").textContent()) === "Stronger" && (await second.getByTestId("relation-row").count()) >= 1);

  // The same recording under someone else's words: MusicBrainz's own are shown, and put in the address.
  const mixed = await ctx.newPage();
  await mixed.goto(`${BASE}/tools/sample-finder?q=${encodeURIComponent("Foo Fighters – Everlong")}&rec=${id("a001")}`);
  await resultsDone(mixed);
  check("a shared link's words never rename the song: Stronger by Kanye West", (await mixed.getByTestId("song-title").textContent()) === "Stronger" && (await mixed.getByTestId("song-artist").textContent())!.startsWith("Kanye West"), await mixed.getByTestId("song-artist").textContent());
  check("…and the address says so too", mixed.url().includes("q=Kanye+West") && !mixed.url().includes("Foo"), mixed.url());
  await ctx.close();
}

async function uncachedShare(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  const words = "PDF Wizard Support – Your account is locked, call +1 555 0100 to restore it";
  await page.goto(`${BASE}/tools/sample-finder?q=${encodeURIComponent(words)}&rec=${id("abcde")}`);
  await page.getByTestId("input-hint").waitFor({ timeout: 30_000 });
  check("a shared link nobody looked up: no song card, no headline", (await page.getByTestId("song-card").count()) === 0 && (await page.getByTestId("results").count()) === 0);
  check("…its words wait in the box, to look up if wanted", (await page.getByTestId("sample-input").inputValue()) === words && (await page.getByTestId("input-hint").textContent()) === "Press Find samples to look this song up.");
  await shot(page, "shared-uncached");
  // A remix's share link, not cached: nothing claims it's the original.
  await page.goto(`${BASE}/tools/sample-finder?q=${encodeURIComponent("Daft Punk – Harder, Better, Faster, Stronger (The Neptunes remix)")}&rec=${id("d003")}`);
  await page.getByTestId("input-hint").waitFor({ timeout: 30_000 });
  check("…a remix's too: its full title in the box, no original's rows", (await page.getByTestId("sample-input").inputValue()).endsWith("(The Neptunes remix)") && (await page.getByTestId("relation-row").count()) === 0);
  await ctx.close();
}

async function backAfterExplore(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/`);
  await typeAndFind(page, "Kanye West – Stronger");
  await resultsDone(page);
  await page.getByTestId("explore").first().click();
  await page.getByTestId("song-title").filter({ hasText: "Harder, Better, Faster, Stronger" }).waitFor({ timeout: 30_000 });
  await resultsDone(page);
  check("Find its samples → the related song, in the address", page.url().includes(`rec=${id("d001")}`), page.url());
  await page.goBack();
  await page.getByTestId("song-title").filter({ hasText: /^Stronger$/ }).waitFor({ timeout: 30_000 });
  await resultsDone(page);
  check("Back → the song before it, not out of the tool", page.url().includes(`rec=${id("a001")}`) && (await page.getByTestId("relation-row").first().textContent())!.includes("Harder, Better, Faster, Stronger"), page.url());
  check("…with focus on its title", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "song-title");
  await page.goForward();
  await page.getByTestId("song-title").filter({ hasText: "Harder, Better, Faster, Stronger" }).waitFor({ timeout: 30_000 });
  check("Forward → the related song again", page.url().includes(`rec=${id("d001")}`));
  await page.goBack();
  await page.goBack();
  await page.waitForURL((u) => !u.pathname.startsWith("/tools/"), { timeout: 30_000 });
  check("Back again leaves the tool", new URL(page.url()).pathname === "/", page.url());
  await ctx.close();
}

async function notOnMusicBrainz(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "https://www.youtube.com/watch?v=unknownVid1");
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  await resultsDone(page);
  check("a clear reading MusicBrainz hasn't got → the song, not \"Which song is this?\"", (await page.getByTestId("song-title").textContent()) === "Nowhere Song" && (await page.getByTestId("candidate-picker").count()) === 0);
  check("…saying MusicBrainz doesn't have it", (await page.getByTestId("missing-note").textContent()) === "MusicBrainz doesn't have this song yet, and it isn't on our list.");
  check("…with no empty tabs and no \"Add it\" link", (await page.getByTestId("relation-tabs").count()) === 0 && (await page.getByText("Add it on MusicBrainz", { exact: true }).count()) === 0);

  // Type it with just a title MusicBrainz doesn't know: shown, not asked again.
  await typeAndFind(page, "https://www.youtube.com/watch?v=lowConfVid1");
  await page.getByTestId("candidate-picker").waitFor({ timeout: 30_000 });
  await page.locator("#type-title").fill("Nowhere Tune");
  await page.getByTestId("type-it").getByRole("button", { name: "Find this song" }).click();
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  await resultsDone(page);
  check("Type it that finds nothing → the song card, not the same question", (await page.getByTestId("song-title").textContent()) === "Nowhere Tune" && (await page.getByTestId("song-artist").textContent()) === "Artist unknown");
  await ctx.close();
}

async function uncheckedStates(browser: Browser) {
  const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
  // MusicBrainz busy, and a song our list doesn't have.
  await typeAndFind(page, "Someone – Song zz503");
  await page.getByTestId("busy-note").waitFor({ timeout: 30_000 });
  check("busy, not on our list → says just that", (await page.getByTestId("busy-note").textContent())!.startsWith("MusicBrainz is busy and our list doesn't have this song. Try again in a minute."), await page.getByTestId("busy-note").textContent());
  check("…no \"0 found\", \"Nothing on record yet\" or \"Add it on MusicBrainz\"", (await page.getByTestId("total-badge").count()) === 0 && (await page.getByText("Nothing on record yet.", { exact: true }).count()) === 0 && (await page.getByText("Add it on MusicBrainz", { exact: true }).count()) === 0);
  await page.waitForTimeout(1200); // the site's rest after that 503

  // The lookup itself failing, for a song with a hand-checked row.
  await page.route("**/api/samples/lookup", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await typeAndFind(page, "Kanye West – Stronger");
  await page.getByTestId("tool-error").waitFor({ timeout: 30_000 });
  check("lookup fails → the error, and the hand-checked row", (await page.getByTestId("tool-error").textContent())!.includes("Couldn't look that up.") && (await page.getByTestId("relation-row").count()) === 1);
  check("…zero counts aren't claimed", (await page.getByTestId("tab-sampled").textContent()) === "Sampled in" && (await page.getByTestId("total-badge").textContent()) === "1 found", await page.getByTestId("tab-sampled").textContent());
  await page.getByTestId("tab-sampled").click();
  check("…an empty tab says MusicBrainz couldn't be checked, with no \"Add it\" link", (await page.getByTestId("empty-tab").filter({ visible: true }).textContent()) === "Couldn't check MusicBrainz.", await page.getByTestId("empty-tab").filter({ visible: true }).textContent());
  const retry = await page.getByTestId("tool-error").getByRole("button", { name: "Try again" }).boundingBox();
  check("320px: the error's Try again is a full tap target", !!retry && retry.height >= 44, retry);
  await page.unroute("**/api/samples/lookup");

  // The card's actions at 320px: one line each.
  await typeAndFind(page, "Kanye West – Stronger");
  await resultsDone(page);
  // Lines of each label's own text (its icon aside).
  const lines = await page.evaluate(`[...document.querySelectorAll('[data-testid="song-card"] button')].map((b) => {
    const tops = new Set();
    for (const node of b.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
    }
    return [b.textContent.trim(), tops.size];
  })`) as [string, number][];
  check("320px: \"Not this song?\", \"Share\" and \"New search\" don't break over two lines", lines.length === 3 && lines.every(([, n]) => n === 1), lines);
  check("320px: no horizontal scroll", await noSideScroll(page));
  await shot(page, "card-results-320");

  // Type it, in an error at 320px.
  await typeAndFind(page, "https://www.tiktok.com/@catperson/video/7300000000000000002");
  await page.getByTestId("tool-error").waitFor({ timeout: 30_000 });
  const typeIt = await page.getByRole("button", { name: "Type it" }).boundingBox();
  check("320px: Type it is a full tap target", !!typeIt && typeIt.height >= 44, typeIt);
  await ctx.close();
}

async function focusAfterPicker(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await typeAndFind(page, "Kanye West – Stronger");
  await resultsDone(page);
  const notThis = page.getByTestId("not-this-song");
  check("\"Not this song?\" says it's closed", (await notThis.getAttribute("aria-expanded")) === "false");
  await notThis.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("type-it").waitFor();
  check("…and open", (await notThis.getAttribute("aria-expanded")) === "true" && (await notThis.getAttribute("aria-controls")) === "sample-picker");
  await page.getByRole("button", { name: "Keep this song" }).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("type-it").waitFor({ state: "detached" });
  check("Keep this song → focus back on \"Not this song?\"", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "not-this-song");
  await page.keyboard.press("Enter");
  await page.locator("#type-title").waitFor();
  await page.locator("#type-title").focus();
  await page.keyboard.press("Escape");
  await page.getByTestId("type-it").waitFor({ state: "detached" });
  check("Escape closes the picker, focus back on \"Not this song?\"", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "not-this-song" && (await notThis.getAttribute("aria-expanded")) === "false");
  await ctx.close();
}

/** Records, every frame, whether the box and the song card were both on screen. (A string: no helpers the test runner adds.) */
async function watchOverlap(page: Page) {
  await page.evaluate(`(() => {
    window.__both = 0;
    const tick = () => {
      if (document.querySelector('[data-testid="sample-input"]') && document.querySelector('[data-testid="song-card"]')) window.__both++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}
const overlapFrames = (page: Page) => page.evaluate(() => (window as unknown as { __both: number }).__both);

async function oneViewAtATime(browser: Browser, reduced: boolean) {
  const label = reduced ? "reduced motion" : "390px";
  const { ctx, page } = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(reduced ? { reducedMotion: "reduce" as const } : {}) });
  await page.goto(`${BASE}/tools/sample-finder`);
  await page.getByTestId("sample-input").waitFor();
  await page.getByTestId("sample-input").fill("Daft Punk – Harder, Better, Faster, Stronger");
  await watchOverlap(page);
  await page.getByRole("button", { name: "Find samples" }).click();
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  await resultsDone(page);
  check(`${label}: the box and the song card are never on screen together`, (await overlapFrames(page)) === 0, await overlapFrames(page));
  if (reduced) {
    // "Find its samples" low on the page: the jump up is instant, not a smooth scroll.
    await page.getByTestId("tab-sampled").click();
    await page.getByTestId("explore").filter({ visible: true }).first().waitFor();
    const { before, seen } = await page.evaluate(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="explore"]')].find((b) => b.offsetParent !== null)!;
      // Read on down the page, the song card well above the screen.
      window.scrollBy(0, document.querySelector('[data-testid="song-card"]')!.getBoundingClientRect().top + 300);
      await new Promise((r) => setTimeout(r, 100));
      const at = Math.round(window.scrollY);
      button.click();
      const out: number[] = [];
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 25));
        out.push(Math.round(window.scrollY));
      }
      return { before: at, seen: out };
    });
    const distinct = [...new Set(seen)];
    check("reduced motion: Find its samples jumps, with no smooth scroll", distinct.length <= 2 && seen[0] !== before, { before, seen });
  }
  await ctx.close();
}

async function earlyPress(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  // The page's scripts arrive late: the visitor types and presses Enter first.
  let held = 0;
  await page.route("**/_next/static/chunks/**", async (r) => {
    if (held++ < 400) await new Promise((x) => setTimeout(x, 4000));
    await r.continue();
  });
  const searches: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/samples/identify") && searches.push(r.postData() ?? ""));
  await page.goto(`${BASE}/tools/sample-finder`, { waitUntil: "domcontentloaded" });
  const input = page.getByTestId("sample-input");
  await input.waitFor();
  check("before the page is ready, Find samples isn't disabled", !(await page.getByRole("button", { name: "Find samples" }).isDisabled()));
  await input.fill("Johnny Cash – Hurt");
  await input.press("Enter");
  await page.getByTestId("song-title").filter({ hasText: "Hurt" }).waitFor({ timeout: 60_000 });
  check("a press before the page was ready still searches, once", searches.length === 1 && JSON.parse(searches[0]).input === "Johnny Cash – Hurt", searches);
  await page.unroute("**/_next/static/chunks/**");
  await ctx.close();
}

async function typingWarnings(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/tools/sample-finder`);
  const input = page.getByTestId("sample-input");
  await input.waitFor();
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const region = document.getElementById("sample-input-status")!;
    new MutationObserver(() => w.__said.push(region.textContent ?? "")).observe(region, { subtree: true, childList: true, characterData: true });
  });
  await input.click();
  await input.pressSequentially("https://www.youtube.com/watch?v=lowConfVid1", { delay: 40 });
  await page.getByTestId("input-tag").waitFor();
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said.filter(Boolean));
  check("typing a link key by key: no warning on the way, nothing read out", said.length === 0, said);
  check("…and the kind of link shows once it's whole", (await page.getByTestId("input-tag").textContent()) === "YouTube link");
  await input.fill("https://www.youtube.com/@KanyeWest");
  await page.getByTestId("input-problem").waitFor({ timeout: 5_000 });
  check("a channel link → says to paste one video's (after a pause)", (await page.getByTestId("input-problem").textContent()) === "That's a channel. Paste one video's link.");
  await input.fill("https://open.spotify.com/track/7oDd86yk8itslrA9HRP2ki");
  await input.blur();
  check("a Spotify link → says Spotify can't be read (on leaving the box)", (await page.getByTestId("input-problem").textContent()) === "Spotify links can't be read. Type Artist – Title.");
  // A TikTok photo post is a link we read.
  await input.fill("https://www.tiktok.com/@liftsalot/photo/7300000000000000003");
  await page.getByTestId("input-tag").waitFor();
  await page.getByRole("button", { name: "Find samples" }).click();
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  check("a TikTok photo post → its sound's song", (await page.getByTestId("song-title").textContent()) === "Stronger" && (await page.getByTestId("song-from").textContent())!.includes("@liftsalot"));
  await ctx.close();
}

async function slowMusicBrainz(browser: Browser) {
  const { ctx, page } = await newPage(browser);
  await page.route("**/api/samples/identify", async (r) => {
    await new Promise((x) => setTimeout(x, 4500));
    await r.continue();
  });
  await typeAndFind(page, "Nas – Made You Look");
  await page.getByTestId("input-slow").waitFor({ timeout: 6_000 });
  check("a long wait says what it's waiting for", (await page.getByTestId("input-slow").textContent()) === "Still checking MusicBrainz…" && (await page.locator("#sample-input-status").getAttribute("aria-live")) === "polite");
  await page.getByTestId("song-card").waitFor({ timeout: 30_000 });
  await page.unroute("**/api/samples/identify");
  await ctx.close();
}

async function downloaderLink(browser: Browser) {
  const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/tools/tiktok-to-mp4`);
  const box = page.locator("#media-url");
  await box.waitFor();
  await box.fill("https://youtu.be/strongerVID");
  const link = page.getByRole("link", { name: "Find this song's samples →" });
  await link.waitFor();
  const size = await link.boundingBox();
  check("320px: the downloader's Find samples link is a full tap target", !!size && size.height >= 44, size);
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
  await uncachedShare(browser);
  await backAfterExplore(browser);
  await notOnMusicBrainz(browser);
  await uncheckedStates(browser);
  await focusAfterPicker(browser);
  await oneViewAtATime(browser, false);
  await oneViewAtATime(browser, true);
  await earlyPress(browser);
  await typingWarnings(browser);
  await slowMusicBrainz(browser);
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
