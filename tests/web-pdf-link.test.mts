// HTML to PDF on the web app's side: POST /api/render/link (the grant the
// media worker verifies), the address checks the page and the route share,
// HTML files read in the browser, and the tool hidden until the flag is set.
// The worker's own guard, on every request a page makes, is tested in
// media-worker/test_render.py and tests/render-worker.test.mts (npm run test:render).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// The route loads lib/usage.ts through require(); so must this test, or it
// would get a second copy whose store the route never sees.
const usage = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");
const { memoryUsageStore, WEB_PDF_BUCKET, WEB_PDF_LINKS_PER_MINUTE } = usage;
const { handleWebPdfLink, handleWebPdfRefund, renderKey, WEB_PDF_REFUNDS_PER_DAY } = await import("../lib/web-pdf-route.ts");
const { signToken, verifyToken } = await import("../lib/media-server.ts");
const { LIMITS } = await import("../lib/limits.ts");
const web = await import("../lib/web-pdf.ts");
type Deps = import("../lib/web-pdf-route.ts").WebPdfDeps;
type Tier = import("../lib/limits.ts").Tier;

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  total++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail).slice(0, 500)})` : ""}`);
  if (!ok) failed++;
}

const logged: string[] = [];
console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));

const SECRET = "web-pdf-test-secret";
const KEY = renderKey(SECRET);
// One proxy in front, so each test address is its own guest.
const ENV = { TRUSTED_PROXY_HOPS: "1" };
const guest = (ip: string) => usage.usageSubject(new Request("http://x", { headers: { "x-forwarded-for": ip } }), null, undefined, ENV);
const SAME_SITE = { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" };
const OPTIONS = { size: "a4", orientation: "portrait", margins: "small", background: true, media: "screen" };
const PUBLIC_DNS: Record<string, string[]> = {
  "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
  "news.example.org": ["8.8.8.8"],
  "intranet-looking.com": ["10.0.0.5"],
  "meta.example.net": ["169.254.169.254"],
  "mixed.example.net": ["8.8.4.4", "192.168.1.10"],
  "mapped.example.net": ["::ffff:127.0.0.1"],
};

let lookups: string[] = [];
function deps(o: { tier?: Tier; user?: { id: string } | null; store?: ReturnType<typeof memoryUsageStore>; env?: NodeJS.ProcessEnv; enabled?: boolean; configured?: boolean; dns?: (h: string) => Promise<string[]> } = {}): Deps {
  return {
    enabled: o.enabled ?? true,
    config: () => (o.configured === false ? { ok: false, reason: "missing-url" } : { ok: true, url: "https://media.example.test", secret: SECRET }),
    resolveTier: async () => ({ user: o.user ?? null, tier: o.tier ?? "guest" }),
    lookup:
      o.dns ??
      (async (host) => {
        lookups.push(host);
        return PUBLIC_DNS[host] ?? [];
      }),
    store: o.store ?? memoryUsageStore(),
    env: { ...ENV, ...o.env },
  };
}

async function post(d: Deps, body: unknown, o: { ip?: string; headers?: Record<string, string> } = {}) {
  const res = await handleWebPdfLink(
    new Request("http://localhost/api/render/link", {
      method: "POST",
      headers: { ...SAME_SITE, "x-forwarded-for": o.ip ?? "192.0.2.10", ...o.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json, cache: res.headers.get("cache-control") };
}
const urlBody = (url: string, options: Record<string, unknown> = OPTIONS) => ({ mode: "url", url, options });

// ---------- The flag and the setup ----------
{
  lookups = [];
  const off = await post(deps({ enabled: false }), urlBody("https://example.com"));
  check("flag off: the route answers as if it weren't there", off.status === 404 && lookups.length === 0, off);
  const unset = await post(deps({ configured: false }), urlBody("https://example.com"));
  check("no worker configured: a plain 'not switched on' and the reason in the log", unset.status === 503 && /isn't switched on/.test(unset.json.error) && logged.some((l) => /MEDIA_WORKER_URL/.test(l)), unset);
}

// ---------- Other sites' pages ----------
{
  const store = memoryUsageStore();
  const d = deps({ store });
  const cross = await post(d, urlBody("https://example.com"), { headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
  check("another site's page is refused", cross.status === 403, cross);
  const origin = await post(d, urlBody("https://example.com"), { headers: { "sec-fetch-site": "", origin: "https://evil.example" } });
  check("an Origin that isn't this site is refused", origin.status === 403, origin);
  const plain = await post(d, urlBody("https://example.com"), { headers: { "content-type": "text/plain" } });
  check("a body that isn't JSON is refused (no preflight-free posts)", plain.status === 403, plain);
  check("and none of them spent anything", (await store.count(guest("192.0.2.10"), WEB_PDF_BUCKET, "day")) === 0);
}

// ---------- Addresses ----------
{
  const store = memoryUsageStore();
  const bad: [string, string][] = [
    ["file:///etc/passwd", "scheme"],
    ["ftp://example.com/x", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,<h1>x</h1>", "scheme"],
    ["chrome://settings", "scheme"],
    ["view-source:https://example.com", "scheme"],
    ["http://127.0.0.1/", "private"],
    ["http://127.1/", "private"],
    ["http://2130706433/", "private"],
    ["http://0x7f000001/", "private"],
    ["http://0177.0.0.1/", "private"],
    ["http://[::1]/", "private"],
    ["http://[::ffff:127.0.0.1]/", "private"],
    ["http://[::ffff:a9fe:a9fe]/", "private"],
    ["http://[fd00:ec2::254]/", "private"],
    ["http://[fe80::1]/", "private"],
    ["http://169.254.169.254/latest/meta-data/", "private"],
    ["http://100.100.100.200/", "private"],
    ["http://10.1.2.3/", "private"],
    ["http://192.168.0.1/", "private"],
    ["http://172.20.0.1/", "private"],
    ["http://0.0.0.0/", "private"],
    ["http://224.0.0.1/", "private"],
    ["http://localhost:3000/", "local-name"],
    ["http://app.localhost/", "local-name"],
    ["http://printer.local/", "local-name"],
    ["http://metadata.google.internal/", "local-name"],
    ["http://intranet/", "local-name"],
    ["https://user:secret@example.com/", "credentials"],
    ["https://example.com:22/", "port"],
    ["https://example.com:25/", "port"],
    ["not a url at all", "invalid"],
  ];
  for (const [url, reason] of bad) {
    const r = await post(deps({ store }), urlBody(url));
    check(`${url || "(empty)"} → ${reason}`, r.status === 400 && r.json.reason === reason && typeof r.json.error === "string", r.json);
  }
  const left = await usage.dailyLeft(guest("192.0.2.10"), WEB_PDF_BUCKET, LIMITS.guest.webPdfsPerDay, store);
  check("addresses turned away spend none of the day's pages", left === LIMITS.guest.webPdfsPerDay, left);
}

// ---------- Names that lead somewhere private ----------
{
  for (const [host, reason] of [["intranet-looking.com", "private"], ["meta.example.net", "private"], ["mixed.example.net", "private"], ["mapped.example.net", "private"], ["no-such-site.example.com", "not-found"]] as const) {
    const r = await post(deps(), urlBody(`https://${host}/`));
    check(`${host} (looked up) → ${reason}`, r.status === 400 && r.json.reason === reason, r.json);
  }
  const slow = await post(deps({ dns: async () => { throw new Error("timeout"); } }), urlBody("https://example.com"));
  check("no DNS answer in time: the worker decides (a grant is made)", slow.status === 200 && typeof slow.json.token === "string", slow.json);
}

// ---------- The grant ----------
{
  lookups = [];
  const r = await post(deps({ tier: "free", user: { id: "user-1" } }), urlBody("Example.com/news?id=7#top", { ...OPTIONS, size: "letter", orientation: "landscape", margins: "none", background: false, media: "print" }));
  const grant = verifyToken<Record<string, any>>(r.json.token ?? "", KEY);
  check("a grant for the page is made", r.status === 200 && r.json.workerUrl === "https://media.example.test" && r.cache === "no-store", r);
  check("it names the page as the worker opens it: https added, no fragment", grant?.u === "https://example.com/news?id=7" && grant?.k === "render" && grant?.m === "url", grant);
  check("with its options in render.py's keys", JSON.stringify(grant?.o) === JSON.stringify({ f: "letter", l: 1, g: "none", b: 0, p: "print" }), grant?.o);
  check("the plan's page limit, who it's counted to, and a one-time reference", grant?.x === LIMITS.free.webPdfPages && grant?.s === "u:user-1" && /^[\w-]{8,64}$/.test(grant?.c) && typeof grant?.t === "number", grant);
  check("short-lived (10 minutes)", typeof grant?.e === "number" && grant.e - Date.now() / 1000 <= 601 && grant.e - Date.now() / 1000 > 590, grant?.e);
  check("the site was looked up first", lookups.includes("example.com"), lookups);
  check("a token signed with another secret isn't this one", verifyToken(r.json.token, "other-secret") === null);
  check("nor one signed with the shared secret itself: page grants have their own key", verifyToken(r.json.token, SECRET) === null && KEY !== SECRET, KEY);
  const pro = verifyToken<Record<string, any>>((await post(deps({ tier: "pro", user: { id: "p" } }), urlBody("https://example.com"))).json.token ?? "", KEY);
  check("Pro grants allow more pages", pro?.x === LIMITS.pro.webPdfPages && LIMITS.pro.webPdfPages > LIMITS.free.webPdfPages, pro?.x);
  const ip = await post(deps(), urlBody("http://93.184.216.34/"));
  check("a public address given as an IP needs no lookup", ip.status === 200 && verifyToken<Record<string, any>>(ip.json.token, KEY)?.u === "http://93.184.216.34/", ip.json);
  const badOptions = await post(deps(), urlBody("https://example.com", { ...OPTIONS, size: "a0" }));
  check("unknown options are refused", badOptions.status === 400, badOptions.json);
}

// ---------- Pasted and uploaded HTML ----------
{
  const html = "<h1>Bonjour, élève</h1>";
  const bytes = Buffer.byteLength(html);
  const sha256 = createHash("sha256").update(html).digest("hex");
  lookups = [];
  const r = await post(deps(), { mode: "html", bytes, sha256, options: OPTIONS });
  const grant = verifyToken<Record<string, any>>(r.json.token ?? "", KEY);
  check("HTML: the grant names its size and SHA-256, never its text", r.status === 200 && grant?.m === "html" && grant?.n === bytes && grant?.d === sha256 && !("u" in grant) && !JSON.stringify(grant).includes("Bonjour"), grant);
  check("and nothing is looked up", lookups.length === 0, lookups);
  const big = await post(deps(), { mode: "html", bytes: web.MAX_HTML_BYTES + 1, sha256, options: OPTIONS });
  check(`HTML over ${web.formatHtmlLimit()} is refused before anything is spent`, big.status === 413 && big.json.reason === "too-big", big.json);
  const badHash = await post(deps(), { mode: "html", bytes, sha256: "xyz", options: OPTIONS });
  check("a malformed hash is refused", badHash.status === 400, badHash.json);
  const noMode = await post(deps(), { url: "https://example.com", options: OPTIONS });
  check("a body without a mode is refused", noMode.status === 400, noMode.json);
}

// ---------- Allowances ----------
{
  const store = memoryUsageStore();
  const statuses: number[] = [];
  let last: Awaited<ReturnType<typeof post>> | null = null;
  for (let i = 0; i <= LIMITS.guest.webPdfsPerDay; i++) {
    // A new minute's worth each time: only the day's allowance is under test here.
    last = await post(deps({ store }), urlBody("https://example.com"), { ip: "198.51.100.7" });
    statuses.push(last.status);
    await store.refund(guest("198.51.100.7"), "web-pdf-link", "minute");
  }
  check(`guests get ${LIMITS.guest.webPdfsPerDay} a day, then the upgrade prompt`, statuses.slice(0, -1).every((s) => s === 200) && last?.status === 429 && last.json.reason === "quota" && last.json.upgrade === true, statuses);
  const remaining = (await post(deps({ store }), urlBody("https://example.com"), { ip: "198.51.100.8" })).json.remaining;
  check("each grant says how many are left today", remaining === LIMITS.guest.webPdfsPerDay - 1, remaining);

  const pro = memoryUsageStore();
  for (let i = 0; i < LIMITS.pro.webPdfsPerDay; i++) await pro.consume("u:pro-1", WEB_PDF_BUCKET, 1e9, "day");
  const spent = await post(deps({ store: pro, tier: "pro", user: { id: "pro-1" } }), urlBody("https://example.com"));
  check("Pro has a daily allowance too, without the upgrade prompt", spent.status === 429 && spent.json.upgrade === false && /today's web pages/.test(spent.json.error), spent.json);

  const burst = memoryUsageStore();
  const tries: number[] = [];
  for (let i = 0; i <= WEB_PDF_LINKS_PER_MINUTE; i++) tries.push((await post(deps({ store: burst, tier: "pro", user: { id: "fast" } }), urlBody("https://intranet-looking.com/"))).status);
  check(`every try counts against ${WEB_PDF_LINKS_PER_MINUTE} a minute, refused ones too`, tries.slice(0, -1).every((s) => s === 400) && tries.at(-1) === 429, tries);

  const site = memoryUsageStore();
  const env = { WEB_PDF_GLOBAL_DAILY_LIMIT: "2" };
  const a = await post(deps({ store: site, env }), urlBody("https://example.com"), { ip: "203.0.113.1" });
  const b = await post(deps({ store: site, env }), urlBody("https://example.com"), { ip: "203.0.113.2" });
  const c = await post(deps({ store: site, env }), urlBody("https://example.com"), { ip: "203.0.113.3" });
  const third = guest("203.0.113.3");
  check("the site-wide daily cap turns the next visitor away as busy", a.status === 200 && b.status === 200 && c.status === 503 && c.json.reason === "busy", [a.status, b.status, c.status, c.json]);
  check("and gives that visitor's page back", (await site.count(third, WEB_PDF_BUCKET, "day")) === 0);
}

// ---------- Tries given back ----------
{
  const WORKER = "https://media.example.test";
  const config = () => ({ ok: true as const, url: WORKER, secret: SECRET });
  type Answer = Record<string, unknown> | "down";
  const asked: string[] = [];
  const worker = (answer: Answer) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${String(input)} ${(init?.headers as Record<string, string>)?.Authorization}`);
      if (answer === "down") throw new Error("down");
      return Response.json(answer);
    }) as typeof fetch;
  const refund = async (token: string, answer: Answer, store: ReturnType<typeof memoryUsageStore>, headers: Record<string, string> = {}) => {
    const res = await handleWebPdfRefund(
      new Request("http://localhost/api/render/refund", { method: "POST", headers: { ...SAME_SITE, ...headers }, body: JSON.stringify({ token }) }),
      { config, store, fetch: worker(answer) }
    );
    return { status: res.status, body: (await res.json()) as { refunded: boolean } };
  };
  const t = () => Math.floor(Date.now() / 1000);
  const grant = (c: string, extra: Record<string, unknown> = {}) => signToken({ k: "render", m: "url", u: "https://example.com/", s: "ip:refund", c, t: t(), ...extra }, KEY);
  const spend = async (store: ReturnType<typeof memoryUsageStore>) => usage.consumeWebPdf("ip:refund", "guest", { store, env: {} });

  const store = memoryUsageStore();
  await spend(store);
  const failed = await refund(grant("grant-failed-01"), { used: true, status: "error", refundable: true, since: 1 }, store);
  check("a try the worker says never loaded is given back", failed.status === 200 && failed.body.refunded === true && (await store.count("ip:refund", WEB_PDF_BUCKET, "day")) === 0, failed);
  check("the worker is asked with the shared secret, about that grant", asked.at(-1) === `${WORKER}/render/refs/grant-failed-01/void Bearer ${SECRET}`, asked.at(-1));
  await spend(store);
  const twice = await refund(grant("grant-failed-01"), { used: true, status: "error", refundable: true, since: 1 }, store);
  check("once per grant", twice.body.refunded === false && (await store.count("ip:refund", WEB_PDF_BUCKET, "day")) === 1, twice);
  const kept = await refund(grant("grant-kept-001"), { used: true, status: "error", refundable: false, since: 1 }, store);
  check("one that held a browser (a timeout, too big, too much memory) is kept", kept.status === 409 && kept.body.refunded === false, kept);
  const made = await refund(grant("grant-made-001"), { used: true, status: "ready", refundable: false, since: 1 }, store);
  check("a PDF that was made is kept", made.body.refunded === false, made);
  const unused = await refund(grant("grant-unused-1"), { used: false, since: t() - 60 }, store);
  check("a grant the worker never got is given back (and voided there)", unused.body.refunded === true, unused);
  const restarted = await refund(grant("grant-restart1"), { used: false, since: t() + 60 }, store);
  check("not when the worker restarted since the grant: it may have run it", restarted.body.refunded === false, restarted);
  const down = await refund(grant("grant-down-001"), "down", store);
  check("not when the worker doesn't answer", down.body.refunded === false, down);
  const yesterday = await refund(grant("grant-old-0001", { t: t() - 2 * 86400 }), { used: true, status: "error", refundable: true, since: 1 }, store);
  check("not for a try counted on another day", yesterday.body.refunded === false, yesterday);
  const cross = await refund(grant("grant-cross-01"), { used: true, status: "error", refundable: true, since: 1 }, store, { "sec-fetch-site": "cross-site" });
  check("not from another site's page", cross.status === 403, cross);
  const download = await refund(signToken({ k: "mp4", u: "https://www.youtube.com/watch?v=aaaaaaaaaaa", s: "ip:refund", c: "grant-mp4-0001", t: t() }, SECRET), { used: true, status: "error", refundable: true, since: 1 }, store);
  check("a download's grant isn't a page grant", download.status === 400, download);

  const capped = memoryUsageStore();
  const given: boolean[] = [];
  for (let i = 0; i <= WEB_PDF_REFUNDS_PER_DAY; i++) {
    await spend(capped);
    given.push((await refund(grant(`grant-cap-${String(i).padStart(4, "0")}`), { used: true, status: "error", refundable: true, since: 1 }, capped)).body.refunded);
  }
  check(`at most ${WEB_PDF_REFUNDS_PER_DAY} given back a day`, given.slice(0, -1).every(Boolean) && given.at(-1) === false, given);
}

// A page grant posted to the downloads' refund route credits nothing.
{
  const env = process.env as Record<string, string | undefined>;
  env.MEDIA_WORKER_URL = "https://media.example.test";
  env.MEDIA_WORKER_SECRET = SECRET;
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ used: true, status: "error", since: 1 });
  }) as typeof fetch;
  const { POST } = await import("../app/api/media/refund/route.ts");
  const t = Math.floor(Date.now() / 1000);
  const ask = async (payload: Record<string, unknown>, key: string) =>
    (await POST(new Request("http://localhost/api/media/refund", { method: "POST", headers: SAME_SITE, body: JSON.stringify({ token: signToken(payload, key) }) }))).json();
  const page = await ask({ k: "render", m: "url", u: "https://example.com/", s: "ip:x", c: "grant-page-0001", t }, SECRET);
  check("the downloads' refund route refuses a page grant, even one signed with the shared secret", page.refunded === false && calls === 0, { page, calls });
  const office = await ask({ k: "office", s: "ip:x", c: "grant-offi-0001", t }, SECRET);
  check("and any grant that isn't a download's", office.refunded === false && calls === 0, { office, calls });
  globalThis.fetch = realFetch;
  delete env.MEDIA_WORKER_URL;
  delete env.MEDIA_WORKER_SECRET;
}

// ---------- The shared checks ----------
{
  for (const ip of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "0.0.0.0", "224.0.0.251", "255.255.255.255", "198.18.0.1",
    "[::1]", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001::1", "2001:db8::1", "not-an-ip"]) {
    check(`blocked: ${ip}`, web.blockedAddress(ip));
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "[2a00:1450:4001:80b::200e]", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
    check(`public: ${ip}`, !web.blockedAddress(ip));
  }
  const ok = (input: string, want: string) => {
    const got = web.webPageUrl(input);
    check(`${JSON.stringify(input)} opens as ${want}`, "url" in got && got.url === want, got);
  };
  ok("example.com", "https://example.com/");
  ok("  https://Example.com/A?b=1#c ", "https://example.com/A?b=1");
  ok("http://example.com:8080/x", "http://example.com:8080/x");
  ok("example.com:8443/x", "https://example.com:8443/x");
  ok("https://bücher.de/", "https://xn--bcher-kva.de/");
  check("an empty box asks for an address", JSON.stringify(web.webPageUrl("  ")) === '{"problem":"empty"}');
  const empty = await post(deps(), urlBody(""));
  check("an empty address never reaches the checks", empty.status === 400, empty.json);
  check("defaults: Letter in the US and Canada, A4 elsewhere", web.defaultSize("en-US") === "letter" && web.defaultSize("fr-CA") === "letter" && web.defaultSize("en-ZA") === "a4" && web.defaultSize("en") === "a4" && web.defaultSize(undefined) === "a4");
}

// ---------- The homepage ----------
{
  check("an .html, .htm or .xhtml file, or one typed text/html, goes to HTML to PDF",
    ["a.html", "B.HTM", "c.xhtml"].every((name) => web.isHtmlFile({ name })) && web.isHtmlFile({ name: "page", type: "text/html" }) && !web.isHtmlFile({ name: "a.pdf", type: "application/pdf" }) && !web.isHtmlFile({ name: "notes.txt" }));
  check("the homepage names HTML only while the tool is on",
    web.dropHint(false, false) === "Drop a PDF, image, text file or PPTX." && web.dropHint(false, true) === "Drop a PDF, image, text, HTML or PPTX file." && web.dropHint(true, true) === "Drop a PDF, image, text, Word, Excel, HTML or PPTX file." && web.dropHint(true, false) === "Drop a PDF, image, text, Word, Excel or PPTX file.");
}

// ---------- HTML files, read in the browser ----------
{
  const latin = new Uint8Array([...Buffer.from('<meta charset="windows-1252"><p>caf'), 0xe9, ...Buffer.from("</p>")]);
  check("an older page's <meta charset> is honoured", web.decodeHtml(latin).includes("café"), web.decodeHtml(latin));
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("<p>ナ</p>")]);
  check("a UTF-8 byte order mark is dropped", web.decodeHtml(bom) === "<p>ナ</p>");
  const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from("<p>Ж</p>", "utf16le")]);
  check("UTF-16 by its byte order mark", web.decodeHtml(utf16) === "<p>Ж</p>");
  check("an unknown charset falls back to UTF-8", web.decodeHtml(new Uint8Array(Buffer.from('<meta charset="x-nonsense"><p>é</p>'))).includes("é"));
  const lone = "a\uD800b\uDC00c😀";
  const clean = web.wellFormed(lone);
  check("lone surrogates become U+FFFD; pairs stay", clean === "a�b�c😀", clean);
  check("the digest is SHA-256 of the UTF-8 the worker hashes", (await web.htmlDigest(clean)) === createHash("sha256").update(Buffer.from(new TextEncoder().encode(clean))).digest("hex"));
  check("the size is in UTF-8 bytes", web.htmlBytes("é") === 2);
}

// ---------- Hidden until the flag is set ----------
{
  const probe = (flag: string | undefined) => {
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_ENABLE_HTML_TO_PDF;
    if (flag) env.NEXT_PUBLIC_ENABLE_HTML_TO_PDF = flag;
    const out = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", `
        const { TOOLS, getTool, relatedTools } = await import("./lib/tools.tsx");
        const { filterTools } = await import("./components/tool-filter.ts");
        const { cspSettings } = await import("./lib/csp.ts");
        const map = await import("./app/sitemap.ts");
        const sitemap = (map.default?.default ?? map.default)();
        const found = (q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "html-to-pdf");
        globalThis.fetch = async () => Response.json({ ok: true, ytdlp: "2026.10.26", jsRuntime: "deno", playlists: true, render: true, renderSandbox: false });
        const health = await (await import("./app/api/media/health/route.ts")).GET(new Request("http://localhost/api/media/health"));
        console.log(JSON.stringify({
          listed: !!getTool("html-to-pdf"),
          convert: getTool("html-to-pdf")?.category,
          sitemap: sitemap.some((e) => e.url.endsWith("/tools/html-to-pdf")),
          search: ["url to pdf", "webpage to pdf", "save web page as pdf", "html"].map(found),
          related: getTool("html-to-pdf") ? relatedTools("html-to-pdf").map((t) => t.slug) : [],
          worker: cspSettings().mediaWorkerUrl ?? null,
          health: (await health.json()).htmlToPdf,
        }));`],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", env: { ...env, MEDIA_WORKER_URL: "media.example.test", MEDIA_WORKER_SECRET: "probe", NODE_ENV: "test" } }
    );
    try {
      return JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      return { error: out.stderr.slice(0, 400) };
    }
  };
  const off = probe(undefined);
  check("flag off: not listed, not in the sitemap or search, no worker in the CSP", off.listed === false && off.sitemap === false && off.search.every((s: boolean) => !s) && off.worker === null, off);
  const on = probe("1");
  check("flag on: listed under Convert, in the sitemap", on.listed === true && on.convert === "convert" && on.sitemap === true, on);
  check("found as URL to PDF, webpage to PDF, save web page as PDF and HTML", on.search.every(Boolean), on.search);
  check("with related tools that exist", on.related.length === 4 && on.related.includes("markdown-to-pdf"), on.related);
  check("and the worker's origin in the pages' CSP (the browser talks to it)", on.worker === "https://media.example.test", on.worker);
  check("the setup check says it's off while the flag is", off.health?.ready === false && /NEXT_PUBLIC_ENABLE_HTML_TO_PDF=1/.test(off.health?.problem), off.health);
  check("and, once on, whether the worker renders and with Chromium's sandbox", on.health?.ready === true && on.health?.sandbox === false, on.health);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
