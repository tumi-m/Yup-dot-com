/**
 * Google Slides import: link parsing, the redirect allowlist (SSRF), private
 * deck detection, content-type checks, filenames, and the route handler's
 * quota rules. Uses a fake network.
 */
import {
  parseSlidesUrl, isPublishedSlidesUrl, slidesLinkProblem, exportUrl, isAllowedSlidesHost,
  fetchSlidesExport, SlidesError, filenameFromDisposition, slidesFilename, contentDisposition,
  handleSlidesExport, SLIDES_MIME, SLIDES_FAILURE_MESSAGE,
} from "../lib/google-slides.ts";
import { LIMITS } from "../lib/limits.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

// ---- URL parsing ----
const good = [
  `https://docs.google.com/presentation/d/${ID}/edit`,
  `https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`,
  `https://docs.google.com/presentation/d/${ID}/edit#slide=id.p1`,
  `https://docs.google.com/presentation/d/${ID}/view`,
  `https://docs.google.com/presentation/d/${ID}/present?slide=id.g1`,
  `https://docs.google.com/presentation/d/${ID}/pub?start=false`,
  `https://docs.google.com/presentation/d/${ID}`,
  `https://docs.google.com/presentation/d/${ID}/`,
  `https://docs.google.com/presentation/u/0/d/${ID}/edit`,
  `https://docs.google.com/u/1/presentation/d/${ID}/edit`,
  `docs.google.com/presentation/d/${ID}/edit?usp=drive_link`,
  `http://docs.google.com/presentation/d/${ID}/edit`,
  `  https://DOCS.GOOGLE.COM/presentation/d/${ID}/edit  `,
];
for (const g of good) check(`parses ${g.trim().slice(0, 70)}`, parseSlidesUrl(g)?.id === ID, JSON.stringify(parseSlidesUrl(g)));

const bad = [
  "",
  "not a link",
  `https://docs.google.com/document/d/${ID}/edit`,
  `https://docs.google.com/spreadsheets/d/${ID}/edit`,
  `https://drive.google.com/file/d/${ID}/view`,
  `https://docs.google.com.evil.com/presentation/d/${ID}/edit`,
  `https://evil.com/docs.google.com/presentation/d/${ID}/edit`,
  `https://docs.google.com:8443/presentation/d/${ID}/edit`,
  `https://user@docs.google.com/presentation/d/${ID}/edit`,
  `javascript:alert(1)//docs.google.com/presentation/d/${ID}`,
  "https://docs.google.com/presentation/d/short/edit",
  "https://docs.google.com/presentation/d/../../etc/passwd",
  `https://docs.google.com/presentation/d/${ID}%2F..%2Fx/edit`,
];
for (const b of bad) check(`rejects ${JSON.stringify(b).slice(0, 70)}`, parseSlidesUrl(b) === null);

const PUB = "https://docs.google.com/presentation/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pub?start=false";
check("published link rejected", parseSlidesUrl(PUB) === null && isPublishedSlidesUrl(PUB));
check("published link problem", slidesLinkProblem(PUB) === "published");
check("invalid link problem", slidesLinkProblem("https://example.com") === "invalid");
check("good link no problem", slidesLinkProblem(good[0]) === null);
check("exportUrl pdf", exportUrl(ID, "pdf") === `https://docs.google.com/presentation/d/${ID}/export/pdf`);
check("exportUrl pptx", exportUrl(ID, "pptx") === `https://docs.google.com/presentation/d/${ID}/export/pptx`);
check("exportUrl refuses bad id", (() => { try { exportUrl("a/b", "pdf"); return false; } catch (e) { return e instanceof SlidesError; } })());

// ---- host allowlist ----
const allowedHosts: [string, boolean][] = [
  ["https://docs.google.com/x", true],
  ["https://doc-0k-2c-docs.googleusercontent.com/export/abc", true],
  ["https://googleusercontent.com/x", false],
  ["https://.googleusercontent.com/x", false],
  ["http://doc-0k.googleusercontent.com/x", false],
  ["https://docs.google.com.evil.com/x", false],
  ["https://evilgoogleusercontent.com/x", false],
  ["https://googleusercontent.com.evil.com/x", false],
  ["https://169.254.169.254/latest/meta-data", false],
  ["https://docs.google.com:444/x", false],
  ["https://a:b@docs.google.com/x", false],
  ["https://localhost/x", false],
  ["file:///etc/passwd", false],
];
for (const [u, want] of allowedHosts) check(`host ${want ? "allowed" : "blocked"}: ${u}`, isAllowedSlidesHost(u) === want);

// ---- fake network ----
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake\n");
type Reply = { status: number; headers?: Record<string, string>; body?: BodyInit | null } | "throw";
function fakeFetch(route: (url: string) => Reply) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let cancelled = 0;
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = route(url);
    if (r === "throw") throw new Error("network down");
    const body = r.body === undefined ? null : r.body;
    const stream = body === null ? null : new Response(body).body!;
    const tracked = stream && new ReadableStream<Uint8Array>({
      async pull(c) { const reader = stream.getReader(); const { done, value } = await reader.read(); reader.releaseLock(); if (done) c.close(); else c.enqueue(value); },
      cancel() { cancelled++; return stream.cancel(); },
    });
    return new Response(tracked, { status: r.status, headers: r.headers });
  };
  return { f, calls, cancelled: () => cancelled };
}
async function kind(p: Promise<unknown>) {
  try { await p; return "ok"; } catch (e) { return e instanceof SlidesError ? e.kind : `other:${(e as Error).message}`; }
}
const pdfOk = (extra: Record<string, string> = {}): Reply => ({
  status: 200,
  headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length), ...extra },
  body: PDF_BYTES,
});
const redirect = (to: string): Reply => ({ status: 307, headers: { location: to } });
const G = "https://doc-10-8s-docs.googleusercontent.com/docs/securesc/abc/export?x=1";

// Direct success.
{
  const { f, calls } = fakeFetch(() => pdfOk({ "content-disposition": 'attachment; filename="Quarterly Review.pdf"' }));
  const file = await fetchSlidesExport(ID, "pdf", f);
  const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
  check("direct: bytes streamed", bytes.length === PDF_BYTES.length && bytes[0] === 0x25);
  check("direct: filename from disposition", file.filename === "Quarterly Review.pdf", file.filename);
  check("direct: content-length kept", file.contentLength === PDF_BYTES.length);
  check("direct: manual redirects", calls[0].init?.redirect === "manual" && calls[0].url === exportUrl(ID, "pdf"));
}

// Redirect chain to googleusercontent (relative + absolute).
{
  const { f, calls } = fakeFetch((u) =>
    u.endsWith("/export/pdf") ? redirect(`/presentation/d/${ID}/export/pdf?hop=2`)
      : u.includes("hop=2") ? redirect(G)
      : u === G ? pdfOk() : { status: 500 });
  const file = await fetchSlidesExport(ID, "pdf", f);
  check("redirects: followed within Google", calls.length === 3 && calls[2].url === G, calls.map((c) => c.url).join(" > "));
  check("redirects: fallback filename", file.filename === `slides-${ID}.pdf`);
}

// SSRF attempts.
for (const target of [
  "https://169.254.169.254/latest/meta-data/",
  "http://169.254.169.254/latest/meta-data/",
  "https://docs.google.com.evil.com/x.pdf",
  "https://evil.com/?docs.google.com",
  "http://doc-1.googleusercontent.com/x",
  "https://docs.google.com:8080/x",
  "//evil.com/x",
  "file:///etc/passwd",
]) {
  const { f, calls } = fakeFetch((u) => (u === exportUrl(ID, "pdf") ? redirect(target) : pdfOk()));
  const k = await kind(fetchSlidesExport(ID, "pdf", f));
  check(`SSRF: redirect to ${target} not followed`, k === "unreachable" && calls.length === 1, `${k}, ${calls.length} calls`);
}

// Redirect loop capped at 5 hops.
{
  const { f, calls } = fakeFetch((u) => redirect(`${u.split("?")[0]}?n=${Math.random()}`));
  const k = await kind(fetchSlidesExport(ID, "pdf", f));
  check("redirect loop capped", k === "unreachable" && calls.length === 6, `${k} after ${calls.length} requests`);
}
{
  let n = 0;
  const { f } = fakeFetch(() => (++n <= 5 ? redirect(`https://docs.google.com/r${n}`) : pdfOk()));
  check("exactly 5 redirects allowed", (await kind(fetchSlidesExport(ID, "pdf", f))) === "ok");
}

// Private decks.
{
  const { f } = fakeFetch(() => redirect("https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/..."));
  check("private: accounts.google.com redirect", (await kind(fetchSlidesExport(ID, "pdf", f))) === "private");
}
{
  const { f } = fakeFetch(() => redirect("https://docs.google.com/ServiceLogin?passive=1"));
  check("private: docs ServiceLogin redirect", (await kind(fetchSlidesExport(ID, "pdf", f))) === "private");
}
{
  const { f, cancelled } = fakeFetch(() => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<html>Sign in</html>" }));
  check("private: HTML sign-in page", (await kind(fetchSlidesExport(ID, "pdf", f))) === "private");
  check("private: HTML body released", cancelled() === 1);
}
for (const s of [401, 403]) {
  const { f } = fakeFetch(() => ({ status: s }));
  check(`private: HTTP ${s}`, (await kind(fetchSlidesExport(ID, "pdf", f))) === "private");
}
{
  const { f } = fakeFetch(() => ({ status: 404 }));
  check("404 → not-found", (await kind(fetchSlidesExport(ID, "pdf", f))) === "not-found");
}
{
  const { f } = fakeFetch(() => ({ status: 429 }));
  check("429 → rate-limited", (await kind(fetchSlidesExport(ID, "pdf", f))) === "rate-limited");
}
{
  const { f, calls } = fakeFetch(() => redirect("https://www.google.com/sorry/index?continue=https://docs.google.com/x"));
  check("bot-check redirect → rate-limited, not followed", (await kind(fetchSlidesExport(ID, "pdf", f))) === "rate-limited" && calls.length === 1);
}
{
  const { f } = fakeFetch(() => ({ status: 500 }));
  check("500 → unreachable", (await kind(fetchSlidesExport(ID, "pdf", f))) === "unreachable");
}
{
  const { f } = fakeFetch(() => "throw");
  check("network error → unreachable", (await kind(fetchSlidesExport(ID, "pdf", f))) === "unreachable");
}
{
  const { f } = fakeFetch(() => ({ status: 302 }));
  check("redirect without location → unreachable", (await kind(fetchSlidesExport(ID, "pdf", f))) === "unreachable");
}

// Content types.
{
  const { f } = fakeFetch(() => ({ status: 200, headers: { "content-type": "application/pdf" }, body: PDF_BYTES }));
  check("pptx request refuses a PDF", (await kind(fetchSlidesExport(ID, "pptx", f))) === "unreachable");
}
{
  const { f } = fakeFetch(() => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: PDF_BYTES }));
  check("octet-stream refused", (await kind(fetchSlidesExport(ID, "pdf", f))) === "unreachable");
}
{
  const { f } = fakeFetch(() => ({ status: 200, headers: { "content-type": `${SLIDES_MIME.pptx}; charset=binary` }, body: PDF_BYTES }));
  const file = await fetchSlidesExport(ID, "pptx", f).catch(() => null);
  check("pptx type with params accepted", file?.contentType === SLIDES_MIME.pptx && file.filename === `slides-${ID}.pptx`);
}
{
  const { f } = fakeFetch(() => pdfOk({ "content-encoding": "gzip" }));
  const file = await fetchSlidesExport(ID, "pdf", f);
  check("encoded body: length not passed on", file.contentLength === null);
}

// ---- filenames ----
check("disposition: quoted", filenameFromDisposition('attachment; filename="My Deck.pdf"') === "My Deck.pdf");
check("disposition: bare", filenameFromDisposition("attachment; filename=deck.pptx") === "deck.pptx");
check("disposition: RFC 5987 preferred",
  filenameFromDisposition(`attachment; filename="Pr_sentation.pdf"; filename*=UTF-8''Pr%C3%A9sentation%20%F0%9F%9A%80.pdf`) === "Présentation 🚀.pdf");
check("disposition: filename* first", filenameFromDisposition(`attachment; filename*=utf-8'en'caf%C3%A9.pdf; filename="cafe.pdf"`) === "café.pdf");
check("disposition: broken filename* falls back", filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A; filename="ok.pdf"`) === "ok.pdf");
check("disposition: none", filenameFromDisposition(null) === null && filenameFromDisposition("inline") === null);
check("filename: traversal stripped", slidesFilename('attachment; filename="../../etc/passwd.pdf"', ID, "pdf") === "passwd.pdf", slidesFilename('attachment; filename="../../etc/passwd.pdf"', ID, "pdf"));
check("filename: reserved chars", slidesFilename('attachment; filename="a<b>:c|d?.pdf"', ID, "pdf") === "a b c d.pdf", slidesFilename('attachment; filename="a<b>:c|d?.pdf"', ID, "pdf"));
check("filename: extension forced", slidesFilename('attachment; filename="deck.pdf"', ID, "pptx") === "deck.pptx");
check("filename: dots only → fallback", slidesFilename('attachment; filename="...."', ID, "pdf") === `slides-${ID}.pdf`);
check("filename: long capped", slidesFilename(`attachment; filename="${"x".repeat(400)}.pdf"`, ID, "pdf").length === 124);
{
  const cd = contentDisposition("Présentation \"Q3\".pdf");
  check("content-disposition ascii + utf8", cd.startsWith('attachment; filename="Pr_sentation _Q3_.pdf"; filename*=UTF-8\'\'Pr%C3%A9sentation%20%22Q3%22.pdf'), cd);
}

// ---- route handler ----
function deps(fetcher: ReturnType<typeof fakeFetch>["f"], opts: { tier?: "guest" | "free" | "pro"; user?: string; left?: number } = {}) {
  const consumed: { key: string; limit: number }[] = [];
  let left = opts.left ?? 10;
  return {
    consumed,
    d: {
      fetcher,
      resolveTier: async () => ({ user: opts.user ? { id: opts.user } : null, tier: opts.tier ?? "guest" }),
      consumeDaily: (key: string, limit: number) => { consumed.push({ key, limit }); return left-- > 0 ? left : -1; },
      clientIp: () => "203.0.113.9",
    },
  };
}
const req = (q: string) => new Request(`http://localhost/api/slides/export?${q}`);
const link = encodeURIComponent(good[1]);

{
  const { f } = fakeFetch(() => pdfOk({ "content-disposition": `attachment; filename*=UTF-8''Caf%C3%A9.pdf` }));
  const { d, consumed } = deps(f);
  const res = await handleSlidesExport(req(`url=${link}&format=pdf`), d);
  const bytes = new Uint8Array(await res.arrayBuffer());
  check("route: 200 streams file", res.status === 200 && bytes.length === PDF_BYTES.length);
  check("route: headers", res.headers.get("content-type") === "application/pdf"
    && res.headers.get("content-length") === String(PDF_BYTES.length)
    && res.headers.get("cache-control") === "private, no-store"
    && res.headers.get("content-disposition") === `attachment; filename="Caf_.pdf"; filename*=UTF-8''Caf%C3%A9.pdf`,
    res.headers.get("content-disposition") ?? "");
  check("route: quota consumed once, per IP, guest limit", consumed.length === 1 && consumed[0].key === "slides:ip:203.0.113.9" && consumed[0].limit === LIMITS.guest.linkImportsPerDay);
}
{
  const { f } = fakeFetch(() => pdfOk());
  const { d, consumed } = deps(f, { user: "u1", tier: "pro" });
  await (await handleSlidesExport(req(`url=${link}&format=pdf`), d)).arrayBuffer();
  check("route: quota keyed per user with plan limit", consumed[0]?.key === "slides:u:u1" && consumed[0].limit === 500);
}
const failures: [string, Reply, number, string][] = [
  ["private", redirect("https://accounts.google.com/v3/signin"), 403, SLIDES_FAILURE_MESSAGE.private],
  ["html", { status: 200, headers: { "content-type": "text/html" }, body: "<html>" }, 403, SLIDES_FAILURE_MESSAGE.private],
  ["not found", { status: 404 }, 404, SLIDES_FAILURE_MESSAGE["not-found"]],
  ["google 429", { status: 429 }, 429, SLIDES_FAILURE_MESSAGE["rate-limited"]],
  ["unreachable", { status: 503 }, 502, SLIDES_FAILURE_MESSAGE.unreachable],
  ["ssrf", redirect("https://169.254.169.254/"), 502, SLIDES_FAILURE_MESSAGE.unreachable],
];
for (const [name, reply, status, message] of failures) {
  const { f } = fakeFetch(() => reply);
  const { d, consumed } = deps(f);
  const res = await handleSlidesExport(req(`url=${link}&format=pdf`), d);
  const body = await res.json().catch(() => ({}));
  check(`route ${name}: ${status}, no quota spent`, res.status === status && body.error === message && consumed.length === 0,
    `${res.status} ${JSON.stringify(body)} consumed=${consumed.length}`);
}
for (const [name, q, message] of [
  ["bad link", `url=${encodeURIComponent("https://example.com/x")}&format=pdf`, SLIDES_FAILURE_MESSAGE.invalid],
  ["published link", `url=${encodeURIComponent(PUB)}&format=pdf`, SLIDES_FAILURE_MESSAGE.published],
  ["missing url", "format=pdf", SLIDES_FAILURE_MESSAGE.invalid],
  ["bad format", `url=${link}&format=docx`, "Choose PDF or PPTX."],
] as const) {
  const { f, calls } = fakeFetch(() => pdfOk());
  const { d, consumed } = deps(f);
  const res = await handleSlidesExport(req(q), d);
  const body = await res.json().catch(() => ({}));
  check(`route ${name}: 400 without network`, res.status === 400 && body.error === message && calls.length === 0 && consumed.length === 0, JSON.stringify(body));
}
{
  const { f, cancelled } = fakeFetch(() => pdfOk());
  const { d } = deps(f, { left: 0, tier: "free" });
  const res = await handleSlidesExport(req(`url=${link}&format=pdf`), d);
  const body = await res.json().catch(() => ({}));
  check("route: quota spent → 429 with upgrade", res.status === 429 && body.upgrade === true && body.reason === "quota", JSON.stringify(body));
  check("route: quota spent → upstream released", cancelled() === 1);
}
{
  const { f } = fakeFetch(() => pdfOk());
  const { d } = deps(f, { left: 0, tier: "pro" });
  const body = await (await handleSlidesExport(req(`url=${link}&format=pdf`), d)).json();
  check("route: pro over quota has no upgrade", body.upgrade === false);
}
check("limits: link imports per day", LIMITS.guest.linkImportsPerDay === 20 && LIMITS.free.linkImportsPerDay === 50
  && LIMITS.pro.linkImportsPerDay === 500 && LIMITS.team.linkImportsPerDay === 500);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
