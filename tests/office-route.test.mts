/**
 * Word and Excel to PDF on the server (lib/office-server.ts): POST
 * /api/convert/link and /api/convert/refund through their real handlers,
 * with a usage store, an environment and a worker of the test's own.
 *
 * The switch (off: nothing signed), other sites' pages, bad bodies, types
 * the tool doesn't take, empty files, each plan's size limit and daily
 * allowance, the per-minute limit, what a grant says (size, type, options,
 * who, when, two minutes), its key (a download grant is no conversion grant
 * and the other way round), refunds by the worker's record (failed, never
 * used, still stopping, sent), and a grant signed here verifying in the
 * worker's own Python (media-worker/office.py).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { memoryUsageStore, OFFICE_LINKS_PER_MINUTE, usageSubject } = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");
const { handleOfficeLink, handleOfficeRefund, officeKey, OFFICE_BUCKET, OFFICE_REFUNDS_PER_DAY, OFFICE_TOKEN_TTL, OFFICE_OFF_MESSAGE } = await import("../lib/office-server.ts");
import { readFileSync } from "node:fs";
const { signToken, verifyToken } = await import("../lib/media-server.ts");
const { LIMITS } = await import("../lib/limits.ts");
type Tier = import("../lib/limits.ts").Tier;
type Deps = import("../lib/office-server.ts").OfficeDeps;

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra: unknown = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? "  — " + JSON.stringify(extra).slice(0, 400) : ""}`);
};

const SECRET = "office-route-secret";
const ON: NodeJS.ProcessEnv = {
  NEXT_PUBLIC_ENABLE_OFFICE_CONVERT: "1",
  MEDIA_WORKER_URL: "convert.example.com/",
  MEDIA_WORKER_SECRET: ` ${SECRET}\n`,
} as NodeJS.ProcessEnv;
const SAME_SITE = { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" };
const MB = 1024 * 1024;

// The minute and the day move only when the test says so.
let clock = Date.UTC(2026, 10, 27, 9, 0, 0);
const later = (ms: number) => (clock += ms);

function deps(o: { tier?: Tier; user?: { id: string } | null; store?: ReturnType<typeof memoryUsageStore>; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Deps {
  return {
    resolveTier: async () => ({ user: o.user ?? null, tier: o.tier ?? "guest" }),
    store: o.store ?? memoryUsageStore(() => clock),
    env: o.env ?? ON,
    fetch: o.fetch,
    now: () => clock,
    settleMs: 1500,
  };
}

function req(body: unknown, headers: Record<string, string> = SAME_SITE, path = "/api/convert/link") {
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function link(d: Deps, body: Record<string, unknown>, headers?: Record<string, string>) {
  const res = await handleOfficeLink(req({ tool: "word-to-pdf", ext: "docx", size: 20_000, ...body }, headers), d);
  return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
}

// Off until the owner switches it on, and while the worker isn't set up.
{
  const store = memoryUsageStore(() => clock);
  const off = await link(deps({ store, env: { ...ON, NEXT_PUBLIC_ENABLE_OFFICE_CONVERT: "" } as NodeJS.ProcessEnv }), {});
  check("switched off: 503 and nothing signed", off.status === 503 && off.body.error === OFFICE_OFF_MESSAGE && !off.body.token, off);
  const noWorker = await link(deps({ store, env: { NEXT_PUBLIC_ENABLE_OFFICE_CONVERT: "1" } as NodeJS.ProcessEnv }), {});
  check("switched on without a worker: 503", noWorker.status === 503 && !noWorker.body.token, noWorker);
  check("neither counts anything", (await store.count(usageSubject(req({}), null, undefined, ON), OFFICE_BUCKET, "day")) === 0);
}

// Other sites' pages and bad bodies.
{
  const d = deps();
  for (const [name, headers] of [
    ["another site's Origin", { ...SAME_SITE, origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site: cross-site", { "content-type": "application/json", "sec-fetch-site": "cross-site" }],
    ["a form post (text/plain)", { "content-type": "text/plain", origin: "http://localhost" }],
  ] as const) {
    const r = await link(d, {}, headers);
    check(`refused: ${name}`, r.status === 403 && !r.body.token, r);
  }
  const refundCross = await handleOfficeRefund(req({ token: "x".repeat(20) }, { "content-type": "application/json", "sec-fetch-site": "cross-site" }, "/api/convert/refund"), d);
  check("refund from another site: 403", refundCross.status === 403);
  const bad = await handleOfficeLink(req("{not json"), d);
  check("a body that isn't JSON: 400", bad.status === 400);
  for (const body of [{ tool: "pptx-to-pdf" }, { size: -1 }, { size: 1.5 }, { ext: "" }, { ext: "../x" }, { ext: "docx\u0000" }, { options: { fit: "yes" } }, { options: { orientation: "sideways" } }]) {
    const r = await link(d, body);
    check(`bad field ${JSON.stringify(body)}: 400`, r.status === 400, r);
  }
}

// Types each tool takes, said before anything is counted.
{
  const store = memoryUsageStore(() => clock);
  const user = { id: "types" };
  const d = deps({ store, tier: "pro", user });
  const cases: [string, string, string | null][] = [
    ["word-to-pdf", "Letter.DOCX", null],
    ["word-to-pdf", "old.doc", null],
    ["word-to-pdf", "notes.odt", null],
    ["word-to-pdf", "memo.rtf", null],
    ["excel-to-pdf", "Budget.xlsx", null],
    ["excel-to-pdf", "old.xls", null],
    ["excel-to-pdf", "sheet.ods", null],
    ["excel-to-pdf", "export.csv", null],
    ["word-to-pdf", "Budget.xlsx", "That's a spreadsheet. Use Excel to PDF."],
    ["excel-to-pdf", "Letter.docx", "That's a Word file. Use Word to PDF."],
    ["word-to-pdf", "macro.docm", "Files with macros can't be converted. Save it as .docx first."],
    ["excel-to-pdf", "macro.xlsm", "Files with macros can't be converted. Save it as .xlsx first."],
    ["word-to-pdf", "scan.pdf", "That's already a PDF."],
    ["word-to-pdf", "deck.pptx", "That's a PowerPoint file. Use PPTX to PDF."],
    ["excel-to-pdf", "numbers.numbers", "Export it from Numbers as an Excel file (.xlsx) first."],
    ["word-to-pdf", "README", "Choose a .docx, .doc, .odt or .rtf file."],
    ["excel-to-pdf", "photo.jpg", "Choose a .xlsx, .xls, .ods or .csv file."],
  ];
  let granted = 0;
  for (const [tool, name, error] of cases) {
    later(61_000);
    // The page sends the extension only.
    const r = await link(d, { tool, ext: name.includes(".") ? name.split(".").pop() : "none" });
    if (!error) granted++;
    check(`${tool}: ${name} ${error ? "refused" : "taken"}`, error ? r.status === 415 && r.body.error === error : r.status === 200 && !!r.body.token, r);
  }
  const empty = await link(d, { size: 0 });
  check("an empty file: 422", empty.status === 422 && empty.body.error === "This file is empty.", empty);
  check("only granted files count", (await store.count(usageSubject(req({}), user, undefined, ON), OFFICE_BUCKET, "day")) === granted);
}

// What a grant says.
{
  const r = await link(deps(), { tool: "excel-to-pdf", ext: "XLSX", size: 12_345, options: { sheets: "first" } });
  const payload = verifyToken<Record<string, any>>(r.body.token, officeKey(SECRET));
  check("the worker's address, normalised as the CSP names it", r.body.workerUrl === "https://convert.example.com", r.body.workerUrl);
  check("a grant names the size and type (the page never sends the name)", payload?.k === "office" && payload.x === "xlsx" && payload.z === 12_345, payload);
  check("sheet options: given ones kept, the rest default", JSON.stringify(payload?.o) === JSON.stringify({ fit: true, orientation: "auto", sheets: "first" }), payload?.o);
  check("who and when are recorded for a refund", payload?.s === usageSubject(req({}), null, undefined, ON) && typeof payload?.c === "string" && payload.t === Math.floor(clock / 1000), payload);
  const left = payload!.e - Math.floor(Date.now() / 1000);
  check(`it lasts ${OFFICE_TOKEN_TTL} s`, left > OFFICE_TOKEN_TTL - 5 && left <= OFFICE_TOKEN_TTL, left);
  check("the trimmed secret signs it (a pasted newline doesn't matter)", officeKey(SECRET) === officeKey(ON.MEDIA_WORKER_SECRET!.trim()));
  check("a conversion grant doesn't verify with the download key", verifyToken(r.body.token, SECRET) === null);
  const word = verifyToken<Record<string, any>>((await link(deps(), { options: { sheets: "first" } })).body.token, officeKey(SECRET));
  check("Word files carry no sheet options", JSON.stringify(word?.o) === "{}", word?.o);
}

// Each plan's file size.
for (const tier of ["guest", "free", "pro", "team"] as Tier[]) {
  const max = LIMITS[tier].officeMaxBytes;
  const user = tier === "guest" ? null : { id: `size-${tier}` };
  const fits = await link(deps({ tier, user }), { size: max });
  later(61_000);
  const over = await link(deps({ tier, user }), { size: max + 1 });
  const paid = tier === "pro" || tier === "team";
  check(
    `${tier}: up to ${max / MB} MB, then 413${paid ? "" : " with the upgrade"}`,
    fits.status === 200 && over.status === 413 && over.body.reason === "size" && over.body.upgrade === !paid && over.body.error === `Files up to ${max / MB} MB on your plan.`,
    over
  );
}
check("the numbers: 25 MB guest and free, 100 MB Pro and Team", LIMITS.guest.officeMaxBytes === 25 * MB && LIMITS.free.officeMaxBytes === 25 * MB && LIMITS.pro.officeMaxBytes === 100 * MB && LIMITS.team.officeMaxBytes === 100 * MB);

// Each plan's daily allowance; a minute's limit on asking.
check("the numbers: 5 a day guest, 10 free, 200 Pro and Team", LIMITS.guest.officeConversionsPerDay === 5 && LIMITS.free.officeConversionsPerDay === 10 && LIMITS.pro.officeConversionsPerDay === 200 && LIMITS.team.officeConversionsPerDay === 200);
for (const tier of ["guest", "free", "pro"] as Tier[]) {
  const store = memoryUsageStore(() => clock);
  const user = tier === "guest" ? null : { id: `quota-${tier}` };
  const d = deps({ tier, user, store });
  const limit = LIMITS[tier].officeConversionsPerDay;
  const seen: number[] = [];
  for (let i = 0; i < limit; i++) {
    if (i % OFFICE_LINKS_PER_MINUTE === 0) later(61_000);
    seen.push((await link(d, {})).body.remaining);
  }
  later(61_000);
  const spent = await link(d, {});
  const paid = tier === "pro";
  check(
    `${tier}: ${limit} a day, counting down, then 429${paid ? "" : " with the upgrade"}`,
    seen[0] === limit - 1 && seen.at(-1) === 0 && spent.status === 429 && spent.body.reason === "quota" && spent.body.upgrade === !paid && !spent.body.token,
    { first: seen[0], last: seen.at(-1), spent }
  );
}
{
  const d = deps({ tier: "pro", user: { id: "burst" } });
  later(61_000);
  for (let i = 0; i < OFFICE_LINKS_PER_MINUTE; i++) await link(d, {});
  const burst = await link(d, {});
  check(`${OFFICE_LINKS_PER_MINUTE} asks a minute, then 429 for a minute`, burst.status === 429 && burst.body.reason === "burst" && burst.headers.get("retry-after") === "60" && !burst.body.upgrade, burst);
  later(61_000);
  check("and fine the next minute", (await link(d, {})).status === 200);
}
{
  // Refused asks count toward the minute too, so they can't be repeated without end.
  const d = deps();
  later(61_000);
  for (let i = 0; i < OFFICE_LINKS_PER_MINUTE; i++) await link(d, { size: 999 * MB });
  check("too-big asks count toward the minute", (await link(d, {})).body.reason === "burst");
}

// Refunds: the worker's record decides.
{
  type Verdict = { used: boolean; status?: string; since: number };
  const worker = (answers: Verdict[]) => {
    const calls: { url: string; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json(answers[Math.min(calls.length - 1, answers.length - 1)]);
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const refund = async (d: Deps, token: string) => {
    const res = await handleOfficeRefund(req({ token }, SAME_SITE, "/api/convert/refund"), d);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const started = Math.floor(clock / 1000) - 3600;
  const store = memoryUsageStore(() => clock);
  const subject = usageSubject(req({}), null, undefined, ON);
  later(61_000);
  const grant = async () => (await link(deps({ store }), {})).body.token as string;
  const used = async () => store.count(subject, OFFICE_BUCKET, "day");

  const t1 = await grant();
  const before = await used();
  const failed = worker([{ used: true, status: "error", since: started }]);
  const r1 = await refund(deps({ store, fetch: failed.f }), t1);
  const c1 = verifyToken<Record<string, any>>(t1, officeKey(SECRET))!.c;
  check("a failed conversion is given back", r1.status === 200 && r1.body.refunded === true && (await used()) === before - 1, r1);
  check("the worker is asked with the secret, about that grant", failed.calls[0]?.url === `https://convert.example.com/refs/${c1}/void` && failed.calls[0]?.auth === `Bearer ${SECRET}`, failed.calls);
  const again = await refund(deps({ store, fetch: failed.f }), t1);
  check("and only once", again.body.refunded === false && (await used()) === before - 1, again);

  const t2 = await grant();
  const sent = await refund(deps({ store, fetch: worker([{ used: true, status: "ready", since: started }]).f }), t2);
  check("a PDF that was sent isn't given back", sent.status === 409 && sent.body.refunded === false, sent);

  const t3 = await grant();
  const unused = await refund(deps({ store, fetch: worker([{ used: false, since: started }]).f }), t3);
  check("a grant never used (the upload never got there) is given back", unused.body.refunded === true, unused);

  const t4 = await grant();
  const restarted = await refund(deps({ store, fetch: worker([{ used: false, since: Math.floor(clock / 1000) + 10 }]).f }), t4);
  check("not when the worker restarted since the grant (it can't vouch)", restarted.status === 409, restarted);

  const t5 = await grant();
  const stopping = worker([{ used: true, status: "working", since: started }, { used: true, status: "working", since: started }, { used: true, status: "error", since: started }]);
  const cancelled = await refund(deps({ store, fetch: stopping.f }), t5);
  check("a cancelled conversion still stopping is waited for, then given back", cancelled.body.refunded === true && stopping.calls.length === 3, { cancelled, calls: stopping.calls.length });

  const t6 = await grant();
  const busy = worker([{ used: true, status: "working", since: started }]);
  const running = await refund(deps({ store, fetch: busy.f }), t6);
  check("one still converting after the wait isn't", running.status === 409 && busy.calls.length >= 3, { running, calls: busy.calls.length });

  const t7 = await grant();
  const timedOut = await refund(deps({ store, fetch: worker([{ used: true, status: "timeout", since: started }]).f }), t7);
  check("a conversion that ran out of time isn't given back", timedOut.status === 409 && timedOut.body.refunded === false, timedOut);

  const download = signToken({ k: "mp4", u: "https://www.youtube.com/watch?v=x", s: subject, c: "media-ref-1234", t: Math.floor(clock / 1000) }, SECRET);
  const asMedia = await refund(deps({ store, fetch: failed.f }), download);
  check("a download grant can't be refunded as a conversion", asMedia.status === 400 && asMedia.body.refunded === false, asMedia);
  const forged = signToken({ k: "office", s: subject, c: "forged-12345", t: Math.floor(clock / 1000) }, "another-secret");
  check("nor a grant signed with another key", (await refund(deps({ store, fetch: failed.f }), forged)).status === 400);
}

// Failures are given back only a few times a day per person.
{
  const store = memoryUsageStore(() => clock);
  const user = { id: "refund-cap" };
  const started = Math.floor(clock / 1000) - 3600;
  const failed = (async () => Response.json({ used: true, status: "error", since: started })) as unknown as typeof fetch;
  const given: boolean[] = [];
  for (let i = 0; i <= OFFICE_REFUNDS_PER_DAY; i++) {
    later(61_000);
    const token = (await link(deps({ store, tier: "pro", user }), {})).body.token;
    const res = await handleOfficeRefund(req({ token }, SAME_SITE, "/api/convert/refund"), deps({ store, tier: "pro", user, fetch: failed }));
    given.push(((await res.json()) as { refunded: boolean }).refunded);
  }
  check(`${OFFICE_REFUNDS_PER_DAY} failures a day are given back, then no more`, given.slice(0, OFFICE_REFUNDS_PER_DAY).every(Boolean) && given.at(-1) === false, given);
}

// The page sends the file's extension and size, never its name.
{
  const page = readFileSync(new URL("../components/tools/OfficeToPdf.tsx", import.meta.url), "utf8");
  const sent = /fetch\("\/api\/convert\/link"[\s\S]*?body: JSON\.stringify\(([^\n]*)\)/.exec(page)?.[1] ?? "";
  check("the link request carries the extension, not the name", /ext: officeExtension\(file\.name\)/.test(sent) && !/name:/.test(sent), sent);
}

// The worker verifies what this signs (media-worker/office.py, standard library only).
{
  const token = (await link(deps(), { tool: "excel-to-pdf", ext: "csv", size: 77, options: { orientation: "landscape" } })).body.token;
  const script = [
    "import json, os, sys",
    "sys.path.insert(0, 'media-worker')",
    "import office",
    "payload, reason = office.verify(sys.argv[1])",
    "print(json.dumps({'reason': reason, 'job': office.job_from(payload) if payload else None}))",
  ].join("\n");
  let out: Record<string, any> | null = null;
  try {
    out = JSON.parse(execFileSync("python3", ["-c", script, token], { env: { ...process.env, MEDIA_WORKER_SECRET: SECRET }, encoding: "utf8" }));
  } catch (err) {
    console.log(`SKIP  the Python check (${String(err).slice(0, 80)})`);
  }
  if (out) {
    check(
      "a grant from here verifies in the worker, with its size, type and options",
      out.reason === null && out.job?.ext === "csv" && out.job?.size === 77 && out.job?.options?.orientation === "landscape" && out.job?.options?.fit === true,
      out
    );
  }
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
