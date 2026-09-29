import JSZip from "jszip";
import { parsePptx, PPTX_MESSAGES, pptxErrorMessage } from "../lib/pptx/parse.ts";
import { autoNumberLabel, bulletChar, numberParagraphs, resolveTarget } from "../lib/pptx/ooxml.ts";
import { parseXml, path } from "../lib/pptx/xml.ts";
import type { ParaInfo } from "../lib/pptx/ooxml.ts";
import { buildPptx, para, slideXml, sp } from "./pptx-fixture.mts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

/* ---------------- xml reader ---------------- */
{
  const doc = parseXml(`<?xml version="1.0"?><!-- c --><a:r x='1 &gt; 0' y="a&amp;b"><a:t>&lt;img&gt; &#8226;</a:t><a:t><![CDATA[<b>raw</b>]]></a:t><a:br/></a:r>`);
  const r = path(doc, "a:r");
  check("xml: attributes decoded, both quote styles", r?.attrs.x === "1 > 0" && r?.attrs.y === "a&b");
  check("xml: text entities + CDATA", r?.children[0].text === "<img> •" && r?.children[1].text === "<b>raw</b>");
  check("xml: self-closing child", r?.children[2].name === "a:br" && r.children.length === 3);
  check("resolveTarget", resolveTarget("ppt/slides/slide1.xml", "../slideLayouts/slideLayout2.xml") === "ppt/slideLayouts/slideLayout2.xml");
}

/* ---------------- numbering + symbols ---------------- */
{
  check("autonum labels",
    autoNumberLabel("arabicPeriod", 3) === "3." && autoNumberLabel("alphaLcParenR", 2) === "b)" &&
    autoNumberLabel("romanUcPeriod", 4) === "IV." && autoNumberLabel("arabicParenBoth", 12) === "(12)");
  const p = (level: number, num: boolean): ParaInfo => ({
    level, marL: 0, indent: 0, noRunSize: true,
    bullet: num ? { type: "num", scheme: "arabicPeriod", startAt: 1 } : { type: "char", char: "x" },
  });
  const nums = numberParagraphs([p(0, true), p(1, false), p(0, true), p(0, false), p(0, true)]);
  check("numbering continues past deeper levels, restarts after a break", nums.join(",") === "1,,2,,1", nums.join(","));
  check("wingdings bullet mapped", bulletChar("§", "Wingdings") === "▪" && bulletChar("", "Symbol") === "•");
}

/* ---------------- deck parsing ---------------- */
const bodyParas =
  para("First point") +
  para("Nested point", '<a:pPr lvl="1"/>') +
  para("No bullet here", '<a:pPr><a:buNone/></a:pPr>');
const numbered =
  para("One", '<a:pPr marL="228600" indent="-228600"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
  para("Two", '<a:pPr marL="228600" indent="-228600"><a:buAutoNum type="arabicPeriod"/></a:pPr>');
const cxn = `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom>
<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;
// Document order: title(2), body(3), line(4), numbered(6), evil(7).
const slide1 = slideXml(
  sp(2, "Title 1", { ph: '<p:ph type="title"/>', paras: para("Hello") }) +
  sp(3, "Content 2", { ph: '<p:ph idx="1"/>', paras: bodyParas }) +
  cxn +
  sp(6, "List", { txBox: true, box: [50, 400, 300, 80], paras: numbered }) +
  // A font name that tries to break out of the style attribute pptxtojson builds.
  sp(7, "Evil", { txBox: true, box: [50, 480, 300, 40], paras: para("x", "", `<a:rPr lang="en-US"><a:latin typeface='A" onmouseover="alert(1)'/></a:rPr>`) })
);
const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/><a:chOff x="1270000" y="1270000"/><a:chExt cx="2540000" cy="1270000"/></a:xfrm></p:grpSpPr>
${sp(21, "A", { box: [100, 100, 100, 100], geom: "rect", fill: "00FF00" })}
${sp(22, "B", { box: [200, 100, 100, 100], geom: "ellipse", fill: "0000FF" })}
</p:grpSp>`;
const slide2 = slideXml(group, true);

const bytes = await buildPptx([slide1, slide2], [2, 1]);
const deck = await parsePptx(bytes);

check("slide size in points", Math.abs(deck.width - 720) < 0.01 && Math.abs(deck.height - 540) < 0.01, `${deck.width}x${deck.height}`);
check("slides follow sldIdLst, not file names", deck.slides.map((s) => s.part).join(",") === "ppt/slides/slide2.xml,ppt/slides/slide1.xml");
check("hidden flag read from show=\"0\"", deck.slides[0].hidden === true && deck.slides[1].hidden === false);

const s1 = deck.slides[1];
check("z-order restored across tags", s1.elements.map((e) => e.id).join(",") === "2,3,4,6,7", s1.elements.map((e) => `${e.type}#${e.id}`).join(","));

// ids are the p:cNvPr ids from the slide XML
const zip = await JSZip.loadAsync(bytes);
const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
const xmlIds = Array.from(xml.matchAll(/<p:cNvPr id="(\d+)"/g), (m) => m[1]).filter((id) => id !== "1");
check("element id == p:cNvPr id", xmlIds.join(",") === s1.elements.map((e) => e.id).join(","), xmlIds.join(","));

const body = s1.elements.find((e) => e.id === "3")!;
const bp = body.paragraphs ?? [];
check("inherited bullets from master body style",
  bp.length === 3 && bp[0].bullet.type === "char" && (bp[0].bullet as { char: string }).char === "•" &&
  bp[1].bullet.type === "char" && (bp[1].bullet as { char: string }).char === "–" && bp[2].bullet.type === "none",
  JSON.stringify(bp.map((p) => p.bullet)));
check("inherited indents in points", bp[0].marL === 27 && bp[0].indent === -27 && Math.abs(bp[1].marL - 58.5) < 0.01, `${bp[0].marL}/${bp[0].indent}/${bp[1].marL}`);
check("spcPct read as a fraction of a line", bp[0].spcBef?.pct === 0.2, JSON.stringify(bp[0].spcBef));
check("bullet colour resolved through the theme", (bp[1].bullet as { color?: string }).color === "#C0504D");
check("placeholder type from the layout", body.phType === "obj" || body.phType === "body", String(body.phType));

const list = s1.elements.find((e) => e.id === "6")!;
check("explicit autonumber", list.paragraphs?.every((p) => p.bullet.type === "num") === true && list.paragraphs?.[0].marL === 18);
check("theme font reference in bullet font resolved", (list.paragraphs?.[0].bullet as { font?: string }).font === "Calibri", JSON.stringify(list.paragraphs?.[0].bullet));
check("theme hyperlink colour", s1.linkColor === "#0000FF", String(s1.linkColor));

const title = s1.elements.find((e) => e.id === "2")!;
check("title has no bullet", title.paragraphs?.[0].bullet.type === "none");

check("layout decorations: master under layout", s1.layoutElements.map((e) => e.id).join(",") === "10,5", s1.layoutElements.map((e) => e.id).join(","));

const g = deck.slides[0].elements[0] as { type: string; elements?: { id: string }[] };
check("group children keep their ids", g.type === "group" && g.elements?.map((e) => e.id).join(",") === "21,22");

// The raw pptxtojson HTML really is unsafe: this is what the sanitizer is for.
const evil = s1.elements.find((e) => e.id === "7") as { content?: string };
check("raw content carries the injected attribute (sanitizer needed)", /onmouseover/.test(evil.content ?? ""), (evil.content ?? "").slice(0, 120));

/* ---------------- errors ---------------- */
async function err(input: Uint8Array) {
  try {
    await parsePptx(input);
    return "";
  } catch (e) {
    return pptxErrorMessage(e);
  }
}
const cfb = new Uint8Array(512);
cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
check("legacy .ppt", (await err(cfb)) === PPTX_MESSAGES.legacy);
const enc = new Uint8Array(1024);
enc.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
enc.set(Array.from("EncryptedPackage").flatMap((c) => [c.charCodeAt(0), 0]), 600);
check("password-protected .pptx", (await err(enc)) === PPTX_MESSAGES.encrypted);
check("random bytes", (await err(new TextEncoder().encode("hello world, not a deck"))) === PPTX_MESSAGES.invalid);
const docx = new JSZip();
docx.file("[Content_Types].xml", "<Types/>");
docx.file("word/document.xml", "<w:document/>");
check("zip that isn't a deck", (await err(await docx.generateAsync({ type: "uint8array" }))) === PPTX_MESSAGES.invalid);
const truncated = bytes.slice(0, Math.floor(bytes.length / 2));
check("truncated .pptx", (await err(truncated)) === PPTX_MESSAGES.invalid);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
