/**
 * HTML to PDF end to end: media-worker/worker.py (with render.py and real
 * Chromium) given grants built and signed by the web app's own code
 * (lib/web-pdf-route.ts, lib/media-server.ts), so the TS <-> Python contract
 * is checked: POST /render, GET /render/<id> and its file, DELETE. Each PDF
 * is read back with pdf.js.
 *
 * Local sites stand in for the web: the fixture's loopback port is the one
 * address the worker is told to let through (RENDER_TEST_ADDRESSES); a second
 * "hostile" port records anything that reaches it, and must stay silent.
 * Needs python3 with yt-dlp and Playwright, and Chromium (RENDER_CHROMIUM
 * may name it; PYTHON the interpreter):
 *   npm run test:render
 */
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signToken } from "../lib/media-server.ts";
import { renderKey, webPdfGrant } from "../lib/web-pdf-route.ts";
import { DEFAULT_OPTIONS, type WebPdfOptions } from "../lib/web-pdf.ts";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const SECRET = "render-test-" + Math.random().toString(36).slice(2);
// Page grants are signed with their own key, as the route signs them.
const KEY = renderKey(SECRET);
const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

// A file a page must never read.
const dir = mkdtempSync(join(tmpdir(), "pw-render-"));
const MARKER = `LOCAL-FILE-${Math.random().toString(36).slice(2)}`;
writeFileSync(join(dir, "secret.txt"), MARKER);

const hostileHits: string[] = [];
const hostile = createServer((req, res) => {
  hostileHits.push(req.url ?? "");
  res.end("<title>SECRET</title>INTERNAL SECRET");
});
const hostilePort = await listen(hostile);

const fixture = createServer((req, res) => {
  const path = req.url ?? "/";
  const html = (title: string, body: string) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset=utf-8><title>${title}</title>${body}`);
  };
  if (path === "/article") {
    return html(
      "Moon notes — ночь",
      `<style>.print { display: none } @media print { .print { display: block } .screen { display: none } }</style>
       <h1>Notes on the Moon</h1><p>The Moon is about 384,400 km away.</p>
       <p class="screen">SCREEN-ONLY-LINE</p><p class="print">PRINT-ONLY-LINE</p>
       <a href="https://example.com/more">Read more</a>`
    );
  }
  if (path.startsWith("/to-private")) {
    res.writeHead(302, { Location: `http://127.0.0.1:${hostilePort}/admin` });
    return res.end();
  }
  if (path === "/local-file") {
    return html("Local file", `<h1>Nothing local</h1><iframe src="file://${join(dir, "secret.txt")}"></iframe><img src="file://${join(dir, "secret.txt")}">`);
  }
  if (path === "/slow") {
    // Never answers: a job to cancel.
    return;
  }
  res.writeHead(404).end();
});
const fixturePort = await listen(fixture);
const site = (p: string) => `http://127.0.0.1:${fixturePort}${p}`;

const workerPort = 18_500 + Math.floor(Math.random() * 400);
const worker: ChildProcess = spawn(process.env.PYTHON || "python3", ["media-worker/worker.py"], {
  env: {
    ...process.env,
    PORT: String(workerPort),
    MEDIA_WORKER_SECRET: SECRET,
    RENDER_TEST_ADDRESSES: `127.0.0.1:${fixturePort}`,
    RENDER_LOAD_SECONDS: "8",
    RENDER_MAX_SECONDS: "30",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let workerLog = "";
worker.stdout?.on("data", (d) => (workerLog += d));
worker.stderr?.on("data", (d) => (workerLog += d));
const W = `http://127.0.0.1:${workerPort}`;
for (let i = 0; i < 100; i++) {
  if (await fetch(`${W}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

let refs = 0;
const ref = () => ({ s: "ip:test", c: `grant-render-${String(++refs).padStart(4, "0")}`, t: Math.floor(Date.now() / 1000) });
const urlToken = (u: string, options: Partial<WebPdfOptions> = {}, pages = 50) =>
  signToken(webPdfGrant({ u }, { ...DEFAULT_OPTIONS, ...options }, pages, ref()), KEY);
const htmlToken = (html: string, pages = 50) => {
  const data = Buffer.from(html);
  return signToken(webPdfGrant({ n: data.length, d: createHash("sha256").update(data).digest("hex") }, DEFAULT_OPTIONS, pages, ref()), KEY);
};

async function start(body: Record<string, unknown>) {
  const res = await fetch(`${W}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://pdfwizard.test" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, cors: res.headers.get("access-control-allow-origin") };
}

async function run(body: Record<string, unknown>) {
  const made = await start(body);
  if (made.status !== 202) return { ...made, state: null as Record<string, any> | null, pdf: null as Uint8Array | null };
  let state: Record<string, any> = {};
  for (let i = 0; i < 300; i++) {
    state = await (await fetch(`${W}/render/${made.body.id}`)).json();
    if (state.status !== "working") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  let pdf: Uint8Array | null = null;
  let disposition: string | null = null;
  if (state.status === "ready") {
    const file = await fetch(`${W}/render/${made.body.id}/file`);
    disposition = file.headers.get("content-disposition");
    pdf = new Uint8Array(await file.arrayBuffer());
  }
  return { ...made, id: made.body.id as string, state, pdf, disposition };
}

async function text(pdf: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false }).promise;
  let all = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    all += (content.items as { str: string }[]).map((it) => it.str).join(" ") + "\n";
  }
  return { text: all, pages: doc.numPages, links: (await (await doc.getPage(1)).getAnnotations()).map((a: { url?: string }) => a.url).filter(Boolean) };
}

try {
  const health = await fetch(`${W}/health`, { headers: { Authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
  check("/health tells the web app rendering is set up", health.render === true && "renderSandbox" in health, JSON.stringify(health));
  check("/health without the secret still says only that it's up", JSON.stringify(await fetch(`${W}/health`).then((r) => r.json())) === '{"ok":true}');

  // A page, on screen.
  const article = await run({ token: urlToken(site("/article")) });
  const read = article.pdf ? await text(article.pdf) : null;
  check("a web page comes back as a PDF", article.state?.status === "ready" && !!read && read.pages === 1 && article.state.pages === 1, JSON.stringify(article.state));
  check("its words are there, in any script, as selectable text", !!read && /Notes on the Moon/.test(read.text) && /384,400/.test(read.text), read?.text.slice(0, 200));
  check("as on screen by default: the screen line, not the print one", !!read && read.text.includes("SCREEN-ONLY-LINE") && !read.text.includes("PRINT-ONLY-LINE"), read?.text);
  check("links still open", !!read && read.links.includes("https://example.com/more"), JSON.stringify(read?.links));
  check("named after the page's title", article.state?.filename === "Moon notes — ночь.pdf" && /filename\*=UTF-8''Moon%20notes/.test(article.disposition ?? ""), `${article.state?.filename} ${article.disposition}`);
  check("the browser may read the answers (CORS)", article.cors === "*", String(article.cors));
  const again = await fetch(`${W}/render/${article.id}/file`);
  check("the PDF is deleted once it has been sent", again.status === 410, String(again.status));
  check("and its job says so", (await (await fetch(`${W}/render/${article.id}`)).json()).status === "gone");

  // The print version, on Letter, sideways.
  const printed = await run({ token: urlToken(site("/article"), { media: "print", size: "letter", orientation: "landscape" }) });
  const printedText = printed.pdf ? await text(printed.pdf) : null;
  check("Print version uses the site's print styles", !!printedText && printedText.text.includes("PRINT-ONLY-LINE") && !printedText.text.includes("SCREEN-ONLY-LINE"), printedText?.text);
  const box = printed.pdf ? Buffer.from(printed.pdf).toString("latin1").match(/\/MediaBox\s*\[([^\]]+)\]/)?.[1] : null;
  check("Letter landscape is 11 × 8.5 inches", box?.trim().split(/\s+/).map(Number).map(Math.round).join(" ") === "0 0 792 612", String(box));

  // Pasted HTML.
  const pasted = `<title>Pasted</title><h1>Pasted HTML — élève</h1><img src="http://127.0.0.1:${hostilePort}/pixel"><iframe src="file://${join(dir, "secret.txt")}"></iframe>`;
  const html = await run({ token: htmlToken(pasted), html: pasted });
  const htmlText = html.pdf ? await text(html.pdf) : null;
  check("pasted HTML comes back as a PDF, named after its title (no file name is sent)", html.state?.status === "ready" && html.state.filename === "Pasted.pdf" && !!htmlText && htmlText.text.includes("Pasted HTML — élève"), JSON.stringify(html.state));
  check("and nothing local or private was read into it", !!htmlText && !htmlText.text.includes(MARKER) && !htmlText.text.includes("SECRET"), htmlText?.text);
  check("HTML that isn't what the grant was made for is refused", (await start({ token: htmlToken(pasted), html: pasted + " " })).status === 400);
  const tooBig = "x".repeat(5 * 1024 * 1024 + 1);
  check("HTML over 5 MB is refused", (await start({ token: htmlToken(tooBig), html: tooBig })).status === 400);
  check("an HTML grant without its HTML is refused", (await start({ token: htmlToken(pasted) })).status === 400);

  // The guard, through the web app's own grants.
  const toPrivate = await run({ token: urlToken(site("/to-private")) });
  check("a redirect to a private address fails, with a reason", toPrivate.state?.status === "error" && /private or local network/.test(toPrivate.state.error), JSON.stringify(toPrivate.state));
  const local = await run({ token: urlToken(site("/local-file")) });
  const localText = local.pdf ? await text(local.pdf) : null;
  check("a page's file:// frame and picture read nothing", local.state?.status === "ready" && !!localText && localText.text.includes("Nothing local") && !localText.text.includes(MARKER), localText?.text);
  check("the hostile listener was never reached", hostileHits.length === 0, JSON.stringify(hostileHits));

  // Grants.
  const good = urlToken(site("/article"));
  const [body, sig] = good.split(".");
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: "http://169.254.169.254/" })).toString("base64url") + "." + sig;
  check("a grant edited to another address is refused", (await start({ token: swapped })).status === 401);
  const wrong = await start({ token: signToken(webPdfGrant({ u: site("/article") }, DEFAULT_OPTIONS, 50, ref()), "wrong") });
  check("a grant signed with another secret is refused as such", wrong.status === 401 && wrong.body.code === "bad-signature", JSON.stringify(wrong.body));
  const expired = await start({ token: signToken(webPdfGrant({ u: site("/article") }, DEFAULT_OPTIONS, 50, ref()), KEY, -5) });
  check("an expired grant is refused as expired", expired.status === 401 && expired.body.code === "expired", JSON.stringify(expired.body));
  const video = await start({ token: signToken({ u: site("/article"), k: "mp4", h: 720 }, SECRET) });
  check("a video download grant can't make a PDF (another key)", video.status === 401 && video.body.code === "bad-signature", JSON.stringify(video.body));
  const shared = await start({ token: signToken(webPdfGrant({ u: site("/article") }, DEFAULT_OPTIONS, 50, ref()), SECRET) });
  check("a page grant signed with the shared secret itself is refused", shared.status === 401, JSON.stringify(shared.body));
  const otherKind = await start({ token: signToken({ u: site("/article"), k: "mp4", h: 720 }, KEY) });
  check("a grant of another kind under the page key is refused", otherKind.status === 400, JSON.stringify(otherKind.body));
  const credentials = await start({ token: signToken({ ...webPdfGrant({ u: "http://user:pw@example.com/" }, DEFAULT_OPTIONS, 50, ref()) }, KEY) });
  check("an address with a user name and password is refused", credentials.status === 400, JSON.stringify(credentials.body));
  const fileUrl = await start({ token: signToken({ ...webPdfGrant({ u: "file:///etc/passwd" }, DEFAULT_OPTIONS, 50, ref()) }, KEY) });
  check("a file:// address is refused", fileUrl.status === 400, JSON.stringify(fileUrl.body));
  const once = urlToken(site("/article"));
  const first = await start({ token: once });
  const second = await start({ token: once });
  check("one grant, one PDF", first.status === 202 && second.status === 409 && second.body.code === "used", JSON.stringify(second.body));

  // Refunds: the worker voids a grant and says how its job ended.
  const voidRef = (c: string, auth = `Bearer ${SECRET}`) =>
    fetch(`${W}/render/refs/${c}/void`, { method: "POST", headers: { Authorization: auth } }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
  check("voiding needs the shared secret", (await voidRef("grant-render-none", "Bearer wrong")).status === 401);
  const never = await voidRef("grant-render-none");
  check("a grant never used reads as unused, with when the worker started", never.status === 200 && never.body.used === false && typeof never.body.since === "number", JSON.stringify(never.body));
  const voidedGrant = { s: "ip:test", c: "grant-render-none", t: Math.floor(Date.now() / 1000) };
  const late = await start({ token: signToken(webPdfGrant({ u: site("/article") }, DEFAULT_OPTIONS, 50, voidedGrant), KEY) });
  check("a voided grant can't start a job afterwards", late.status === 409, JSON.stringify(late.body));
  const blockedRef = ref();
  await run({ token: signToken(webPdfGrant({ u: site("/to-private") }, DEFAULT_OPTIONS, 50, blockedRef), KEY) });
  const blockedVoid = await voidRef(blockedRef.c);
  check("a page our rules refused is given back", blockedVoid.body.used === true && blockedVoid.body.status === "error" && blockedVoid.body.refundable === true, JSON.stringify(blockedVoid.body));
  const madeRef = ref();
  await run({ token: signToken(webPdfGrant({ u: site("/article") }, DEFAULT_OPTIONS, 50, madeRef), KEY) });
  const madeVoid = await voidRef(madeRef.c);
  check("a PDF that was made isn't", madeVoid.body.used === true && madeVoid.body.status === "ready" && madeVoid.body.refundable === false, JSON.stringify(madeVoid.body));

  // Cancel.
  const slow = await start({ token: urlToken(site("/slow")) });
  await new Promise((r) => setTimeout(r, 800));
  const del = await fetch(`${W}/render/${slow.body.id}`, { method: "DELETE" });
  await new Promise((r) => setTimeout(r, 500));
  const cancelled = await (await fetch(`${W}/render/${slow.body.id}`)).json();
  check("DELETE cancels a running job", del.status === 200 && cancelled.status === "error" && cancelled.error === "Cancelled.", JSON.stringify(cancelled));
  check("unknown jobs are 404", (await fetch(`${W}/render/aaaaaaaaaaaaaaaaaaaaaaaa`)).status === 404);
  check("the worker's video routes still answer as before", (await fetch(`${W}/jobs/aaaaaaaaaaaaaaaaaaaaaaaa`)).status === 404);
  check("the worker never logged a page's address", !workerLog.includes(`127.0.0.1:${fixturePort}`), workerLog.slice(-400));
} finally {
  worker.kill();
  fixture.close();
  hostile.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
