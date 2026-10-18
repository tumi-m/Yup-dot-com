// Protect PDF must encrypt strings as well as streams. It used to write the
// title, bookmarks and link addresses as plain text inside an encrypted file,
// so every reader "decrypted" them into noise (and anyone could read them).
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import { protectPdf, unlockPdf } from "../lib/pdf/security.ts";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failed++;
}

const d = await PDFDocument.create();
const page = d.addPage([300, 300]);
page.drawText("Quarterly figures", { x: 20, y: 150, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
d.setTitle("Quarterly Report");
d.setAuthor("Ann Example");
const ctx = d.context;
const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 100, 100], A: { S: "URI", URI: PDFString.of("https://example.com/q3") } }));
page.node.set(PDFName.of("Annots"), ctx.obj([link]));
const outlines = ctx.nextRef();
const item = ctx.register(ctx.obj({ Title: PDFHexString.fromText("Chapter One"), Parent: outlines, Dest: [page.ref, PDFName.of("Fit")] }));
ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
d.catalog.set(PDFName.of("Outlines"), outlines);
const plain = await d.save();

const locked = await protectPdf(plain, { userPassword: "pw" });

const doc = await pdfjs.getDocument({ data: locked.slice(), password: "pw", verbosity: 0 }).promise;
const info = (await doc.getMetadata()).info as { Title?: string; Author?: string };
check("title reads back with the password", info.Title === "Quarterly Report", info.Title);
check("author reads back with the password", info.Author === "Ann Example", info.Author);
const outline = await doc.getOutline();
check("bookmark reads back", outline?.[0]?.title === "Chapter One", outline?.[0]?.title);
const annots = await (await doc.getPage(1)).getAnnotations();
check("link address reads back", annots[0]?.url === "https://example.com/q3", annots[0]?.url);
const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
check("page text reads back", text.includes("Quarterly figures"), text);
await doc.destroy();

const raw = new TextDecoder("latin1").decode(locked);
const hex = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("").toUpperCase();
const leaks = ["Quarterly Report", hex("Quarterly"), "example.com", hex("Chapter")].filter((s) => raw.toUpperCase().includes(s.toUpperCase()));
check("nothing readable without the password", leaks.length === 0, leaks);

let refused = false;
try {
  await pdfjs.getDocument({ data: locked.slice(), verbosity: 0 }).promise;
} catch {
  refused = true;
}
check("still needs the password to open", refused);

const back = await SecurePDFDocument.load(await unlockPdf(locked, "pw"), { updateMetadata: false });
check("unlocked copy keeps the title", back.getTitle() === "Quarterly Report", back.getTitle());

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
