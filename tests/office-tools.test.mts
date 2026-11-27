/**
 * Word and Excel to PDF on the site, with the switch on (this file turns it
 * on before loading anything) and off (shownTools): listed, searched, in the
 * sitemap, given a panel, related tools and copy that says the file is
 * uploaded; hidden everywhere while off; the CSP naming the worker only
 * while a tool that needs it is on; and the page's own checks of a file and
 * of the worker's answers (lib/office.ts).
 */
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_ENABLE_OFFICE_CONVERT = "1";

const { TOOLS, shownTools, relatedTools, getTool } = await import("../lib/tools.tsx");
const { filterTools } = await import("../components/tool-filter.ts");
const { panelSpec } = await import("../components/tools/panel-spec.tsx");
const { OFFICE_COPY } = await import("../components/tools/office-copy.ts");
const { cspSettings, contentSecurityPolicy } = await import("../lib/csp.ts");
const sitemap = (await import("../app/sitemap.ts")).default;
const office = await import("../lib/office.ts");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra: unknown = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? "  — " + JSON.stringify(extra).slice(0, 300) : ""}`);
};
const SLUGS = ["word-to-pdf", "excel-to-pdf"];

// Switched on.
check("both tools are listed", SLUGS.every((s) => TOOLS.some((t) => t.slug === s)));
check("in Convert, with their own panel", SLUGS.every((s) => getTool(s)?.category === "convert" && JSON.stringify(panelSpec(getTool(s)!)) === JSON.stringify({ kind: "office", tool: s })));
const urls = sitemap().map((u) => u.url);
check("in the sitemap", SLUGS.every((s) => urls.some((u) => u.endsWith(`/tools/${s}`))));
const found = (q: string) => filterTools(TOOLS, "all", q).map((t) => t.slug);
for (const [q, first] of [
  ["word to pdf", "word-to-pdf"],
  ["docx to pdf", "word-to-pdf"],
  ["doc to pdf", "word-to-pdf"],
  ["odt", "word-to-pdf"],
  ["excel to pdf", "excel-to-pdf"],
  ["xlsx to pdf", "excel-to-pdf"],
  ["spreadsheet to pdf", "excel-to-pdf"],
  ["pdf to word", "pdf-to-word"],
  ["pdf to excel", "pdf-to-excel"],
  ["word", "pdf-to-word"],
  ["csv to pdf", "txt-to-pdf"],
]) check(`search '${q}' lists ${first} first`, found(q)[0] === first, found(q));
check("search 'word' finds both directions", found("word").slice(0, 2).join() === "pdf-to-word,word-to-pdf", found("word"));
check("search 'csv' finds Excel to PDF too", found("csv to pdf").includes("excel-to-pdf"));
check("related: each other, PPTX to PDF and the way back", relatedTools("word-to-pdf").map((t) => t.slug).join() === "excel-to-pdf,pptx-to-pdf,pdf-to-word,merge-pdf" && relatedTools("excel-to-pdf").map((t) => t.slug).join() === "word-to-pdf,pptx-to-pdf,pdf-to-excel,merge-pdf");

// Switched off.
const off = shownTools({ youtube: false, office: false });
check("off: not listed, so no page, no search result, no sitemap entry", !off.some((t) => SLUGS.includes(t.slug)) && off.length === TOOLS.length - 2);
check("off: everything else stays", off.every((t) => TOOLS.includes(t)));

// The pages' copy says the file is uploaded and deleted.
for (const s of SLUGS) {
  const copy = OFFICE_COPY[s as keyof typeof OFFICE_COPY];
  const upload = copy.faq.find((f) => f.q === "Is my file uploaded?");
  check(`${s}: says plainly the file is uploaded and deleted straight after`, !!upload && upload.a.startsWith("Yes.") && /deleted as soon as the PDF is sent/.test(upload.a) && copy.steps.length === 3);
}

// The CSP names the worker only while a tool that needs it is on.
{
  env.MEDIA_WORKER_URL = "convert.example.com/x";
  delete env.NEXT_PUBLIC_ENABLE_YOUTUBE;
  const connect = () => contentSecurityPolicy("n", cspSettings()).split("; ").find((d) => d.startsWith("connect-src ")) ?? "";
  check("on: the page may upload to the worker (https, origin only)", cspSettings().mediaWorkerUrl === "https://convert.example.com" && connect().includes(" https://convert.example.com"), connect());
  env.NEXT_PUBLIC_ENABLE_OFFICE_CONVERT = "";
  check("off: it isn't named", cspSettings().mediaWorkerUrl === undefined && !connect().includes("convert.example.com"));
  env.NEXT_PUBLIC_ENABLE_OFFICE_CONVERT = "1";
  delete env.MEDIA_WORKER_URL;
}

// The homepage: a CSV offers Excel to PDF (as a table) and TXT to PDF while it is on.
{
  const { heroActions, TEXT_ACTIONS } = await import("../components/landing/hero-actions.ts");
  const csv = [{ name: "export.CSV", type: "text/csv" }];
  check("a dropped CSV: Excel to PDF first, then TXT to PDF", heroActions("pdf", csv, true).join() === "excel-to-pdf,txt-to-pdf", heroActions("pdf", csv, true));
  check("switched off: the text tools as before", heroActions("pdf", csv, false) === TEXT_ACTIONS);
  check("a .txt still goes to the text tools", heroActions("pdf", [{ name: "a.txt", type: "text/plain" }], true) === TEXT_ACTIONS);
}

// The page's checks.
check("accept lists extensions and types", office.officeAccept("word-to-pdf").split(",").includes(".docx") && office.officeAccept("excel-to-pdf").includes("text/csv"));
check("PDF names", office.officePdfName("Q3 Report.final.XLSX") === "Q3 Report.final.pdf" && office.officePdfName(".docx") === "document.pdf");
check("format lists", office.officeFormatList("excel-to-pdf") === ".xlsx, .xls, .ods or .csv");
check("the tool for a dropped file", office.officeToolFor("a.ODS") === "excel-to-pdf" && office.officeToolFor("a.rtf") === "word-to-pdf" && office.officeToolFor("a.pdf") === null);
{
  const f = office.workerFailure;
  check("no answer: lost contact", f(0, null).message.startsWith("Lost contact"));
  check("an expired grant is retried once", f(401, { code: "expired", error: "This upload link expired. Please try again." }).retry === true);
  check("a wrong secret isn't, and blames no one", f(401, { code: "bad-signature" }).retry === false && /rejected this site/.test(f(401, { code: "bad-signature" }).message));
  check("the worker's own message is shown", f(422, { error: "This file is password-protected. Remove the password in Word or Excel, save it, and try again.", code: "encrypted" }).message.includes("password-protected"));
  check("a proxy's page without a message: busy", f(502, null).message.includes("busy"));
  check("an overlong message isn't shown", f(500, { error: "x".repeat(400) }).message === "Couldn't convert this file.");
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
