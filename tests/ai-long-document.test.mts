// Chat with PDF on a long document: the browser used to send the whole text
// with every question. Over 10 MB (about 1,100 pages of CJK text) the body
// was cut, the route couldn't parse it, and every question failed with
// "Couldn't send that question.". The server only ever reads up to the
// plan's budget, so the browser now sends no more than that, and says how
// many pages the PDF has so the model still knows what it's missing.
import { z } from "zod";
import { LIMITS } from "../lib/limits.ts";
import { documentToSend, fitDocument, fitSentDocument, MAX_DOCUMENT_CHARS } from "../lib/ai/document.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

/** Page-tagged text like toPagedText() makes. */
const paged = (pages: number, page: (n: number) => string) =>
  Array.from({ length: pages }, (_, i) => `[Page ${i + 1}]\n${page(i + 1)}`).join("\n\n");

// Vercel caps a function's request body at 4.5 MB, and the proxy at 10 MB.
const BODY_LIMIT = 4.5 * 1024 * 1024;
const bodyBytes = (sent: object) =>
  Buffer.byteLength(JSON.stringify({ documentName: "book.pdf", ...sent, messages: [{ role: "user", content: "Summarize" }] }));

check("the browser's budget is the largest plan's", MAX_DOCUMENT_CHARS === Math.max(...Object.values(LIMITS).map((l) => l.aiDocumentChars)));

// 2,000 pages of English (about 12.5 MB of text).
{
  const text = paged(2000, (n) => `Chapter ${n}. ` + "The quick brown fox jumps over the lazy dog. ".repeat(140));
  check("the whole book is over the proxy's 10 MB", Buffer.byteLength(text) > 10 * 1024 * 1024);
  const sent = documentToSend(text, 2000);
  check("sends at most the largest budget", sent.documentText.length <= MAX_DOCUMENT_CHARS, sent.documentText.length);
  check("sends whole pages from the start", sent.documentText.startsWith("[Page 1]\n") && /\.$/.test(sent.documentText));
  check("says how many pages the PDF has", sent.totalPages === 2000);
  check("the request fits under 4.5 MB", bodyBytes(sent) < BODY_LIMIT, bodyBytes(sent));

  // The server cuts again to each plan's budget and keeps the coverage note.
  for (const tier of ["guest", "free", "pro"] as const) {
    const fitted = fitSentDocument(sent.documentText, LIMITS[tier].aiDocumentChars, sent.totalPages);
    check(`${tier}: the model is told it has pages 1-${fitted.lastPage} of 2000`,
      fitted.truncated && fitted.totalPages === 2000 && fitted.lastPage !== null && fitted.lastPage < 2000 &&
        fitted.text.length <= LIMITS[tier].aiDocumentChars,
      { truncated: fitted.truncated, lastPage: fitted.lastPage, totalPages: fitted.totalPages });
  }
  // Same pages as when the server cut the whole text itself.
  for (const tier of ["guest", "free", "pro"] as const) {
    const before = fitDocument(text, LIMITS[tier].aiDocumentChars);
    const now = fitSentDocument(sent.documentText, LIMITS[tier].aiDocumentChars, sent.totalPages);
    check(`${tier}: reads the same pages as before`, before.text === now.text && before.lastPage === now.lastPage && before.totalPages === now.totalPages);
  }
}

// 1,100 pages of Chinese: 3 bytes a character.
{
  const text = paged(1100, () => "这是一份很长的报告，包含许多页面和数字。".repeat(160));
  check("1,100 pages of CJK text are over 10 MB", Buffer.byteLength(text) > 10 * 1024 * 1024);
  const sent = documentToSend(text, 1100);
  check("CJK: the request fits under 4.5 MB", bodyBytes(sent) < BODY_LIMIT, bodyBytes(sent));
  check("CJK: says how many pages the PDF has", sent.totalPages === 1100);
}

// Pages without text have no marker, so the count comes from the PDF itself.
{
  const text = paged(400, (n) => (n % 2 ? "Text ".repeat(800) : "Words ".repeat(800)));
  const sent = documentToSend(text, 450);
  const fitted = fitSentDocument(sent.documentText, LIMITS.pro.aiDocumentChars, sent.totalPages);
  check("the PDF's page count is used, not the last marker", fitted.totalPages === 450);
}

// Short documents go as they are, with no page count, and aren't marked cut.
{
  const text = paged(12, (n) => `Page ${n} text.`);
  const sent = documentToSend(text, 12);
  check("a short document is sent unchanged", sent.documentText === text && sent.totalPages === undefined);
  const fitted = fitSentDocument(sent.documentText, LIMITS.guest.aiDocumentChars, sent.totalPages);
  check("and is not marked as cut", !fitted.truncated && fitted.lastPage === 12 && fitted.totalPages === 12);
}

// The route accepts the page count.
{
  const schema = z.object({ documentText: z.string().min(1), totalPages: z.number().int().positive().optional() });
  const sent = documentToSend(paged(2000, () => "x".repeat(400)), 2000);
  check("the body with a page count parses", schema.safeParse(JSON.parse(JSON.stringify(sent))).success);
  const route = await import("node:fs").then((fs) => fs.readFileSync(new URL("../app/api/ai/chat/route.ts", import.meta.url), "utf8"));
  check("the route reads totalPages", /totalPages: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/.test(route) &&
    /fitSentDocument\(documentText, .+, totalPages\)/.test(route));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll long document checks passed.");
