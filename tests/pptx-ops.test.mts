// Lossless .pptx package operations (lib/pptx/package.ts).
// Fixtures are generated with python-pptx at test time; every output is
// re-opened with python-pptx, converted with LibreOffice (when installed) and
// re-parsed with pptxtojson.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { parse as pptxToJson } from "pptxtojson/dist/index.js";
import {
  deleteSlide,
  duplicateSlide,
  getNotesText,
  getSlideTexts,
  listSlides,
  moveSlide,
  openDeck,
  relativeTarget,
  reorderSlides,
  resolveTarget,
  saveDeck,
  setShapeText,
} from "../lib/pptx/package.ts";
import { parseXml, serializeXml, stripInvalidXmlChars } from "../lib/pptx/xml-dom.ts";

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, extra = "") {
  total++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const here = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "pptx-ops-"));
execFileSync("python3", [join(here, "fixtures/make_pptx_fixtures.py"), work], { stdio: "pipe" });
const RICH = readFileSync(join(work, "rich.pptx"));
const PLAIN = readFileSync(join(work, "plain.pptx"));

async function entries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const out = new Map<string, Uint8Array>();
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) out.set(name, await zip.files[name].async("uint8array"));
  }
  return out;
}
const text = (m: Map<string, Uint8Array>, name: string) => new TextDecoder().decode(m.get(name) ?? new Uint8Array());
const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((v, k) => v === b[k]);

/* Outputs collected for the batched python-pptx / LibreOffice / pptxtojson checks. */
interface Output {
  name: string;
  path: string;
  bytes: Uint8Array;
  pages: number;
  verify: (py: PyDeck) => void;
  /** Checks on the text LibreOffice rendered, one string per page. */
  rendered?: (pages: string[]) => void;
}
interface PyDeck {
  error?: string;
  slides: { part: string; title: string | null; texts: { id: string; text: string }[]; notes: string | null }[];
  sldIds: string[];
  rIds: string[];
  sections: { name: string; ids: string[] }[];
  shows: string[][];
}
const outputs: Output[] = [];
function emit(name: string, bytes: Uint8Array, pages: number, verify: (py: PyDeck) => void, rendered?: (pages: string[]) => void) {
  const path = join(work, name + ".pptx");
  writeFileSync(path, bytes);
  outputs.push({ name, path, bytes, pages, verify, rendered });
}
async function pdfPages(data: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: false }).promise;
  const out: string[] = [];
  for (let k = 1; k <= doc.numPages; k++) {
    const tc = await (await doc.getPage(k)).getTextContent();
    out.push(tc.items.map((i) => ("str" in i ? i.str : "")).join(" ").replace(/\s+/g, " "));
  }
  await doc.destroy();
  return out;
}
const titles = (py: PyDeck) => py.slides.map((s) => s.title ?? s.texts[0]?.text ?? "").join(",");
const sec = (py: PyDeck) => py.sections.map((s) => `${s.name}[${s.ids.join(" ")}]`).join(" ");

/* ------------------------------------------------------------------ */
/* XML layer                                                           */
/* ------------------------------------------------------------------ */
{
  let exact = 0;
  let count = 0;
  for (const src of [RICH, PLAIN]) {
    for (const [name, data] of await entries(src)) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      count++;
      const s = new TextDecoder().decode(data);
      if (serializeXml(parseXml(s)) === s) exact++;
    }
  }
  check("xml: every part round-trips byte-exact", exact === count && count > 50, `${exact}/${count}`);

  const tricky =
    '<?xml version="1.0"?>\r\n<!-- c --><r xmlns="urn:d" xmlns:q=\'urn:q\'  a = "1&amp;2" q:b=\'x"y\'>' +
    "<q:e/>t&lt;&#x41;<![CDATA[<raw>]]><?pi x?><e2 ></e2 ></r>\n";
  check("xml: tricky input round-trips", serializeXml(parseXml(tricky)) === tricky);
  const d = parseXml(tricky);
  check("xml: namespaces resolved", d.root.ns === "urn:d" && (d.root.children[0] as { ns: string }).ns === "urn:q");
  check("xml: invalid characters stripped, pairs kept",
    stripInvalidXmlChars("a\u0001b\u0000") === "ab" && stripInvalidXmlChars("x\uD83D\uDE00y") === "x\uD83D\uDE00y" &&
      stripInvalidXmlChars("x\uD83Dy\uDE00z") === "xyz" && stripInvalidXmlChars("\uFFFEq\tr\n") === "q\tr\n");
  check("xml: DOCTYPE rejected", throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')));
  check("xml: mismatched tags rejected", throws(() => parseXml("<a><b></a></b>")));
  check("xml: unbound prefix rejected", throws(() => parseXml("<a:x/>")));
  check(
    "paths: resolve/relative",
    resolveTarget("ppt/slides/slide1.xml", "../media/image1.png") === "ppt/media/image1.png" &&
      resolveTarget("ppt/slides/slide1.xml", "/ppt/x.xml") === "ppt/x.xml" &&
      relativeTarget("ppt/notesSlides/notesSlide3.xml", "ppt/slides/slide6.xml") === "../slides/slide6.xml" &&
      relativeTarget("ppt/presentation.xml", "ppt/slides/slide6.xml") === "slides/slide6.xml",
  );
}

/* ------------------------------------------------------------------ */
/* Open / list / no-op save                                            */
/* ------------------------------------------------------------------ */
const orig = await entries(RICH);
{
  const deck = await openDeck(RICH);
  const slides = listSlides(deck);
  check("open: 5 slides", deck.slideCount === 5 && slides.length === 5);
  check("open: slide size 720x540pt", deck.slideSize.widthPt === 720 && deck.slideSize.heightPt === 540);
  check(
    "open: parts, ids and notes",
    slides.map((s) => `${s.part}|${s.sldId}|${s.rId}|${s.notesPart ?? "-"}`).join(",") ===
      "ppt/slides/slide1.xml|256|rId7|-,ppt/slides/slide2.xml|257|rId8|ppt/notesSlides/notesSlide1.xml," +
        "ppt/slides/slide3.xml|258|rId10|ppt/notesSlides/notesSlide2.xml,ppt/slides/slide4.xml|259|rId11|-," +
        "ppt/slides/slide5.xml|260|rId12|-",
  );
  check("open: notes text", JSON.stringify(getNotesText(deck, 1)) === '["Notes for Beta"]' && getNotesText(deck, 0) === null);
  check("open: rejects non-pptx", (await openDeck(new Uint8Array([1, 2, 3])).then(() => false, () => true)));

  const texts0 = getSlideTexts(deck, 0);
  check(
    "texts: title + multi-paragraph body with a:br as \\n",
    JSON.stringify(texts0.map((t) => [t.id, t.placeholder, t.paragraphs])) ===
      JSON.stringify([["2", "title", ["Alpha"]], ["3", "body", ["Bold red plain tail", "Italic second", "Line one\nLine two"]]]),
  );
  const texts1 = getSlideTexts(deck, 1);
  check(
    "texts: grouped shapes + field",
    JSON.stringify(texts1.map((t) => [t.id, t.paragraphs[0]])) ===
      JSON.stringify([["3", "Group child one"], ["4", "Group child two"], ["5", "Slide 2"]]),
  );
  const texts2 = getSlideTexts(deck, 2);
  check(
    "texts: table cells addressed frame:row:col, entities decoded",
    texts2.filter((t) => t.kind === "tableCell").map((t) => `${t.id}=${t.paragraphs[0]}`).join("|") ===
      "4:0:0=H1|4:0:1=H2|4:1:0=c10|4:1:1=c11 & <x>",
  );
  const texts4 = getSlideTexts(deck, 4);
  check("texts: mc:AlternateContent shape listed once", texts4.filter((t) => t.paragraphs[0] === "Alt text").length === 1);

  const saved = await entries(await saveDeck(deck));
  let same = saved.size === orig.size;
  for (const [k, v] of orig) if (!sameBytes(v, saved.get(k))) same = false;
  check("save: untouched deck has identical parts", same);
  check("save: [Content_Types].xml is the first entry", [...saved.keys()][0] === "[Content_Types].xml");
  emit("noop", await saveDeck(deck), 5, (py) => {
    check("noop: python-pptx reads 5 slides", py.slides.length === 5, titles(py));
  });
}

/* ------------------------------------------------------------------ */
/* Move / reorder                                                      */
/* ------------------------------------------------------------------ */
{
  const deck = await openDeck(RICH);
  moveSlide(deck, 0, 3); // Alpha after Delta -> joins "Middle"
  check("move: order in memory", listSlides(deck).map((s) => s.sldId).join(",") === "257,258,259,256,260");
  const e = await entries(await saveDeck(deck, { renumber: false }));
  let untouched = true;
  for (const [k, v] of orig) if (k !== "ppt/presentation.xml" && !sameBytes(v, e.get(k))) untouched = false;
  check("move (no renumber): only presentation.xml changed", untouched);
  const bytes = await saveDeck(deck);
  const r = await entries(bytes);
  const renamed = [2, 3, 4, 1, 5].every((old, k) => sameBytes(r.get(`ppt/slides/slide${k + 1}.xml`), orig.get(`ppt/slides/slide${old}.xml`)));
  check("move: slide parts renumbered to presentation order, contents unchanged", renamed);
  check("move: renumbered rels point at the right parts",
    text(r, "ppt/notesSlides/_rels/notesSlide1.xml.rels").includes('Target="../slides/slide1.xml"') &&
      text(r, "ppt/slides/_rels/slide4.xml.rels").includes('Target="slide3.xml"') &&
      text(r, "[Content_Types].xml").includes('PartName="/ppt/slides/slide5.xml"'));
  emit("move", bytes, 5, (py) => {
    check("move: python order", titles(py) === "Group child one,Gamma,Delta,Alpha,Epsilon", titles(py));
    check("move: sections follow neighbour", sec(py) === "Intro[257] Middle[258 259 256] Empty[] End[260]", sec(py));
    check("move: custom show untouched", JSON.stringify(py.shows) === '[["rId7","rId10","rId11"]]');
  }, (pages) => {
    check("move: LibreOffice page order", ["Group child one", "Gamma", "Delta", "Alpha", "Epsilon"].every((t, k) => pages[k].includes(t)), pages.join(" | "));
  });

  const d2 = await openDeck(RICH);
  moveSlide(d2, 4, 0); // Epsilon first -> joins "Intro"
  emit("move-first", await saveDeck(d2), 5, (py) => {
    check("move to 0: sections", sec(py) === "Intro[260 256 257] Middle[258 259] Empty[] End[]", sec(py));
  });

  const d3 = await openDeck(RICH);
  reorderSlides(d3, [4, 2, 3, 0, 1]); // whole sections moved: End, Middle, Intro
  const r1 = await saveDeck(d3);
  emit("reorder-sections", r1, 5, (py) => {
    check("reorder: python order", titles(py) === "Epsilon,Gamma,Delta,Alpha,Group child one", titles(py));
    check("reorder: sections reordered as blocks", sec(py) === "End[260] Middle[258 259] Empty[] Intro[256 257]", sec(py));
  });
  const back = await openDeck(r1);
  reorderSlides(back, [3, 4, 1, 2, 0]);
  const e2 = await entries(await saveDeck(back));
  let identical = e2.size === orig.size;
  for (const [k, v] of orig) if (!sameBytes(v, e2.get(k))) identical = false;
  check("reorder round-trip: every part byte-identical to the original", identical);

  const d4 = await openDeck(RICH);
  reorderSlides(d4, [0, 2, 1, 3, 4]); // splits sections -> positional fallback
  emit("reorder-split", await saveDeck(d4), 5, (py) => {
    check("reorder split: sizes kept", sec(py) === "Intro[256 258] Middle[257 259] Empty[] End[260]", sec(py));
  });
  check("reorder: rejects non-permutation", throws(() => reorderSlides(d4, [0, 0, 1, 2, 3])));
  check("move: rejects out of range", throws(() => moveSlide(d4, 0, 5)));
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */
{
  const deck = await openDeck(RICH);
  deleteSlide(deck, 1); // Beta: notes + group
  const e = await entries(await saveDeck(deck, { renumber: false }));
  const bytes = await saveDeck(deck);
  const ct = text(e, "[Content_Types].xml");
  check("delete: slide + rels + notes + notes rels removed",
    !e.has("ppt/slides/slide2.xml") && !e.has("ppt/slides/_rels/slide2.xml.rels") &&
      !e.has("ppt/notesSlides/notesSlide1.xml") && !e.has("ppt/notesSlides/_rels/notesSlide1.xml.rels"));
  check("delete: shared parts kept", e.has("ppt/notesMasters/notesMaster1.xml") && e.has("ppt/slideLayouts/slideLayout7.xml") &&
    e.has("ppt/notesSlides/notesSlide2.xml") && e.has("ppt/media/image1.png"));
  check("delete: content-type overrides removed", !ct.includes("/ppt/slides/slide2.xml") && !ct.includes("notesSlide1.xml") && ct.includes("notesSlide2.xml"));
  check("delete: presentation rel removed", !text(e, "ppt/_rels/presentation.xml.rels").includes("slides/slide2.xml"));
  check("delete: app.xml slide count", text(e, "docProps/app.xml").includes("<Slides>4</Slides>") || !text(e, "docProps/app.xml").includes("<Slides>"));
  emit("delete-beta", bytes, 4, (py) => {
    check("delete: python sees 4 slides", py.slides.length === 4 && py.slides[1].title === "Gamma", titles(py));
    check("delete: sections updated", sec(py) === "Intro[256] Middle[258 259] Empty[] End[260]", sec(py));
    check("delete: remaining notes intact", py.slides[1].notes === "Notes for Gamma");
  });

  const d2 = await openDeck(RICH);
  deleteSlide(d2, 3); // Delta: in custom show, hyperlink target, has a chart
  const e2 = await entries(await saveDeck(d2, { renumber: false }));
  const b2 = await saveDeck(d2);
  check("delete: chart and its embedding removed", !e2.has("ppt/charts/chart1.xml") && !e2.has("ppt/embeddings/Microsoft_Excel_Sheet1.xlsx") &&
    !text(e2, "[Content_Types].xml").includes("chart1.xml"));
  check("delete: hyperlink rel to deleted slide removed", !text(e2, "ppt/slides/_rels/slide1.xml.rels").includes("slide4.xml"));
  check("delete: dangling a:hlinkClick removed", !text(e2, "ppt/slides/slide1.xml").includes("hlinkClick"));
  emit("delete-delta", b2, 4, (py) => {
    check("delete: custom show drops the slide", JSON.stringify(py.shows) === '[["rId7","rId10"]]', JSON.stringify(py.shows));
    check("delete: section Middle shrinks", sec(py) === "Intro[256 257] Middle[258] Empty[] End[260]", sec(py));
  });

  const d3 = await openDeck(RICH);
  deleteSlide(d3, 0);
  check("delete: media still used by another slide kept", (await entries(await saveDeck(d3))).has("ppt/media/image1.png"));
  deleteSlide(d3, 1); // Gamma (index shifted): last user of the image
  const e3 = await entries(await saveDeck(d3));
  check("delete: media removed once unused", !e3.has("ppt/media/image1.png"));
}

/* ------------------------------------------------------------------ */
/* Duplicate                                                           */
/* ------------------------------------------------------------------ */
{
  const deck = await openDeck(RICH);
  const at = duplicateSlide(deck, 2); // Gamma: notes, table, picture
  const s = listSlides(deck);
  check("dup: inserted right after, new ids", at === 3 && s[3].part === "ppt/slides/slide6.xml" && s[3].sldId === 261 && s[3].rId === "rId13",
    `${s[3].part} ${s[3].sldId} ${s[3].rId}`);
  check("dup: notes duplicated", s[3].notesPart === "ppt/notesSlides/notesSlide3.xml" && JSON.stringify(getNotesText(deck, 3)) === '["Notes for Gamma"]');
  const e = await entries(await saveDeck(deck, { renumber: false }));
  const bytes = await saveDeck(deck);
  check("dup: new notes rels point back to the copy", text(e, "ppt/notesSlides/_rels/notesSlide3.xml.rels").includes('Target="../slides/slide6.xml"') &&
    text(e, "ppt/notesSlides/_rels/notesSlide2.xml.rels").includes('Target="../slides/slide3.xml"'));
  check("dup: media shared by reference", text(e, "ppt/slides/_rels/slide6.xml.rels").includes("../media/image1.png") && [...e.keys()].filter((k) => k.startsWith("ppt/media/")).length === 1);
  check("dup: content types", text(e, "[Content_Types].xml").includes('PartName="/ppt/slides/slide6.xml"') && text(e, "[Content_Types].xml").includes('PartName="/ppt/notesSlides/notesSlide3.xml"'));
  check("dup: slide xml identical", sameBytes(e.get("ppt/slides/slide6.xml"), orig.get("ppt/slides/slide3.xml")));
  emit("dup-gamma", bytes, 6, (py) => {
    check("dup: python order", titles(py) === "Alpha,Group child one,Gamma,Gamma,Delta,Epsilon", titles(py));
    check("dup: python notes on copy", py.slides[3].notes === "Notes for Gamma");
    check("dup: python table text on copy", py.slides[3].texts.some((t) => t.id === "4:1:1" && t.text === "c11 & <x>"));
    check("dup: added to the same section", sec(py) === "Intro[256 257] Middle[258 261 259] Empty[] End[260]", sec(py));
  }, (pages) => {
    check("dup: LibreOffice renders the copy with its table", pages[3].includes("Gamma") && pages[3].includes("c11 & <x>") && pages[4].includes("Delta"), pages[3]);
  });

  const d2 = await openDeck(RICH);
  duplicateSlide(d2, 3); // Delta: chart
  const e2 = await entries(await saveDeck(d2, { renumber: false }));
  check("dup: chart deep-copied with its workbook", e2.has("ppt/charts/chart2.xml") && e2.has("ppt/embeddings/Microsoft_Excel_Sheet2.xlsx") &&
    text(e2, "ppt/slides/_rels/slide6.xml.rels").includes("../charts/chart2.xml") &&
    text(e2, "ppt/charts/_rels/chart2.xml.rels").includes("../embeddings/Microsoft_Excel_Sheet2.xlsx") &&
    text(e2, "[Content_Types].xml").includes("/ppt/charts/chart2.xml"));
  emit("dup-chart", await saveDeck(d2), 6, (py) => {
    check("dup chart: python reads", py.slides.length === 6 && py.slides[4].title === "Delta");
  });

  // Duplicate, then delete the original.
  const d3 = await openDeck(RICH);
  duplicateSlide(d3, 1);
  deleteSlide(d3, 1);
  const e3 = await entries(await saveDeck(d3, { renumber: false }));
  const b3 = await saveDeck(d3);
  check("dup+delete: original notes gone, copy's notes kept", !e3.has("ppt/notesSlides/notesSlide1.xml") && e3.has("ppt/notesSlides/notesSlide3.xml"));
  emit("dup-then-delete", b3, 5, (py) => {
    check("dup+delete: copy in place with notes", py.slides[1].notes === "Notes for Beta" && py.slides[1].texts.map((t) => t.text).join("|") === "Group child one|Group child two|Slide 2");
    check("dup+delete: section holds the copy", sec(py) === "Intro[256 261] Middle[258 259] Empty[] End[260]", sec(py));
  });

  // Duplicate a duplicate (created parts are copied too), in memory and after a save.
  const d6 = await openDeck(RICH);
  duplicateSlide(d6, 1);
  duplicateSlide(d6, 2);
  check("dup of dup: notes copied again", listSlides(d6)[3].notesPart === "ppt/notesSlides/notesSlide4.xml" &&
    JSON.stringify(getNotesText(d6, 3)) === '["Notes for Beta"]');
  deleteSlide(d6, 1);
  emit("dup-of-dup", await saveDeck(d6), 6, (py) => {
    check("dup of dup: python", py.slides.map((x) => x.notes).join("|") === "|Notes for Beta|Notes for Beta|Notes for Gamma||", py.slides.map((x) => x.notes).join("|"));
  });

  // Delete all but one.
  const d4 = await openDeck(RICH);
  while (d4.slideCount > 1) deleteSlide(d4, 0);
  check("delete: refuses to delete the only slide", throws(() => deleteSlide(d4, 0)));
  const b4 = await saveDeck(d4);
  const e4 = await entries(b4);
  const leftover = [...e4.keys()].filter((k) => /slides\/|notesSlides\/|charts\/|embeddings\/|media\//.test(k)).sort();
  check("delete all but one: no orphans, renumbered to slide1", leftover.join(",") === "ppt/slides/_rels/slide1.xml.rels,ppt/slides/slide1.xml" &&
    sameBytes(e4.get("ppt/slides/slide1.xml"), orig.get("ppt/slides/slide5.xml")), leftover.join(","));
  emit("one-left", b4, 1, (py) => {
    check("delete all but one: python", py.slides.length === 1 && py.slides[0].title === "Epsilon" && JSON.stringify(py.shows) === "[[]]", JSON.stringify(py.shows));
  });

  // Duplicating several times keeps numbering unique.
  const d5 = await openDeck(PLAIN);
  duplicateSlide(d5, 0);
  duplicateSlide(d5, 0);
  duplicateSlide(d5, 4);
  const ids = listSlides(d5).map((x) => x.sldId);
  check("dup: unique sldIds and parts", new Set(ids).size === 6 && new Set(listSlides(d5).map((x) => x.part)).size === 6 && Math.min(...ids) >= 256);
  emit("plain-dups", await saveDeck(d5), 6, (py) => {
    check("dup plain: order", py.slides.map((x) => x.title).join(",") === "Plain 1,Plain 1,Plain 1,Plain 2,Plain 3,Plain 3", titles(py));
  });
}

/* ------------------------------------------------------------------ */
/* Text editing                                                        */
/* ------------------------------------------------------------------ */
{
  const deck = await openDeck(RICH);
  setShapeText(deck, 0, "3", ["New bold", "Second", "Third", "Fourth extra"]);
  setShapeText(deck, 0, "2", ['Tom & "Jerry" <3']);
  const b = await saveDeck(deck);
  const x = text(await entries(b), "ppt/slides/slide1.xml");
  const body = x.slice(x.indexOf('name="Content Placeholder 2"'));
  const paras = body.slice(body.indexOf("<p:txBody>"), body.indexOf("</p:txBody>")).split("<a:p>").slice(1);
  check("set: first run formatting kept (bold/size/color)",
    paras[0].startsWith('<a:r><a:rPr b="1" sz="2800"><a:solidFill><a:srgbClr val="C01020"/></a:solidFill></a:rPr><a:t>New bold</a:t></a:r>'), paras[0]);
  check("set: pPr and italic kept", paras[1].includes('<a:pPr lvl="1"/>') && paras[1].includes('<a:rPr i="1" sz="1800"/><a:t>Second</a:t>'), paras[1]);
  check("set: a:br paragraph replaced by one run", paras[2] === '<a:r><a:rPr u="sng"/><a:t>Third</a:t></a:r></a:p>', paras[2]);
  check("set: extra paragraph reuses last pPr/rPr", paras[3].startsWith('<a:r><a:rPr u="sng"/><a:t>Fourth extra</a:t></a:r></a:p>'), paras[3]);
  check("set: escaped", x.includes("<a:t>Tom &amp; \"Jerry\" &lt;3</a:t>"));
  const re = await openDeck(b);
  check("set: getSlideTexts round-trip", JSON.stringify(getSlideTexts(re, 0).map((t) => t.paragraphs)) ===
    JSON.stringify([['Tom & "Jerry" <3'], ["New bold", "Second", "Third", "Fourth extra"]]));
  emit("set-text", b, 5, (py) => {
    check("set: python text", py.slides[0].texts[1].text === "New bold\nSecond\nThird\nFourth extra" && py.slides[0].title === 'Tom & "Jerry" <3',
      JSON.stringify(py.slides[0].texts));
  }, (pages) => {
    check("set: LibreOffice renders new text", ['Tom & "Jerry" <3', "New bold", "Second", "Third", "Fourth extra"].every((t) => pages[0].includes(t)) &&
      !pages[0].includes("Alpha"), pages[0]);
  });

  const d2 = await openDeck(RICH);
  setShapeText(d2, 0, "3", ["Only"]);
  setShapeText(d2, 1, "5", ["Slide 2", "added"]); // first paragraph unchanged -> a:fld kept
  setShapeText(d2, 1, "3", ["a\nb"]); // group child, line break
  setShapeText(d2, 2, "4:1:1", ["X & Y"]); // table cell
  setShapeText(d2, 3, "2", [""]); // empty title
  setShapeText(d2, 4, getSlideTexts(d2, 4).find((t) => t.paragraphs[0] === "Alt text")!.id, ["Both branches"]);
  const e2 = await entries(await saveDeck(d2));
  const s1 = text(e2, "ppt/slides/slide1.xml");
  check("set: fewer paragraphs removes the rest", (s1.slice(s1.indexOf('name="Content Placeholder 2"')).match(/<a:p>/g) ?? []).length === 1);
  const s2 = text(e2, "ppt/slides/slide2.xml");
  check("set: unchanged paragraph keeps its a:fld", s2.includes('type="slidenum"') && s2.includes("<a:t>added</a:t>"));
  check("set: \\n becomes a:br", /<a:t>a<\/a:t><\/a:r><a:br\/><a:r><a:t>b<\/a:t>/.test(s2) || /<a:t>a<\/a:t><\/a:r><a:br>.*?<\/a:br><a:r>.*?<a:t>b<\/a:t>/.test(s2));
  check("set: table cell", text(e2, "ppt/slides/slide3.xml").includes("<a:t>X &amp; Y</a:t>"));
  const s4 = text(e2, "ppt/slides/slide4.xml");
  const title4 = s4.slice(s4.indexOf('name="Title 1"'), s4.indexOf("</p:sp>", s4.indexOf('name="Title 1"')));
  check("set: empty text leaves an empty paragraph", /<a:p>(<a:endParaRPr[^>]*\/>)?<\/a:p>|<a:p\/>/.test(title4) && !title4.includes("<a:r>"), title4);
  const s5 = text(e2, "ppt/slides/slide5.xml");
  check("set: mc:Choice and mc:Fallback both edited", (s5.match(/Both branches/g) ?? []).length === 2 && !s5.includes("Alt text"));
  check("set: unknown shape throws", throws(() => setShapeText(d2, 0, "999", ["x"])));
  {
    // Two different shapes sharing a cNvPr id: only the listed (first) one is edited.
    const z = await JSZip.loadAsync(RICH);
    const x1 = (await z.file("ppt/slides/slide1.xml")!.async("string")).replace('<p:cNvPr id="3"', '<p:cNvPr id="2"');
    z.file("ppt/slides/slide1.xml", x1);
    const d = await openDeck(await z.generateAsync({ type: "uint8array" }));
    setShapeText(d, 0, "2", ["Only the title"]);
    const s = text(await entries(await saveDeck(d)), "ppt/slides/slide1.xml");
    check("set: duplicate shape id edits only the first shape",
      (s.match(/Only the title/g) ?? []).length === 1 && s.includes("Italic second"));
    z.file("ppt/slides/slide1.xml", "<p:sld");
    const err = await openDeck(await z.generateAsync({ type: "uint8array" })).then(() => null, (e: Error) => e);
    check("open: damaged slide XML rejected with PptxError", err?.constructor.name === "PptxError", String(err));
  }
  check("set: no-op edit keeps part untouched", await (async () => {
    const d = await openDeck(RICH);
    setShapeText(d, 0, "3", ["Bold red plain tail", "Italic second", "Line one\nLine two"]);
    return sameBytes((await entries(await saveDeck(d))).get("ppt/slides/slide1.xml"), orig.get("ppt/slides/slide1.xml"));
  })());
  emit("set-text-2", await saveDeck(d2), 5, (py) => {
    check("set 2: python", py.slides[1].texts.find((t) => t.id === "5")?.text === "Slide 2\nadded" &&
      ["a\vb", "a\nb"].includes(py.slides[1].texts.find((t) => t.id === "3")?.text ?? ""), // python-pptx reports a:br as \v
      JSON.stringify(py.slides[1].texts));
    check("set 2: python table cell", py.slides[2].texts.some((t) => t.id === "4:1:1" && t.text === "X & Y"));
  }, (pages) => {
    check("set 2: LibreOffice renders edits", pages[1].includes("added") && pages[2].includes("X & Y") && pages[4].includes("Both branches"), pages.join(" | "));
  });
}

/* ------------------------------------------------------------------ */
/* Non-default namespace prefixes                                      */
/* ------------------------------------------------------------------ */
{
  const zip = await JSZip.loadAsync(RICH);
  const pres = await zip.file("ppt/presentation.xml")!.async("string");
  const renamed = pres
    .replace(/<(\/?)p:/g, "<$1pp:")
    .replace('xmlns:p="', 'xmlns:pp="')
    .replace(/ r:id=/g, " rel:id=")
    .replace('xmlns:r="', 'xmlns:rel="');
  zip.file("ppt/presentation.xml", renamed);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const deck = await openDeck(bytes);
  duplicateSlide(deck, 0);
  deleteSlide(deck, 2);
  moveSlide(deck, 0, 1);
  const x = text(await entries(await saveDeck(deck, { renumber: false })), "ppt/presentation.xml");
  check("prefixes: new sldId uses the document's prefixes", x.includes('<pp:sldId id="261" rel:id="rId13"/>'), x.slice(x.indexOf("<pp:sldIdLst>"), x.indexOf("</pp:sldIdLst>")));
  emit("prefixes", await saveDeck(deck), 5, (py) => {
    check("prefixes: python order", py.slides.map((s) => s.title).join(",") === "Alpha,Alpha,Gamma,Delta,Epsilon", titles(py));
  });
}

/* ------------------------------------------------------------------ */
/* python-pptx, LibreOffice and pptxtojson on every output             */
/* ------------------------------------------------------------------ */
{
  const py = JSON.parse(
    execFileSync("python3", [join(here, "fixtures/inspect_pptx.py"), ...outputs.map((o) => o.path)], { maxBuffer: 64 << 20 }).toString(),
  ) as Record<string, PyDeck>;
  for (const o of outputs) {
    const r = py[o.path];
    check(`${o.name}: python-pptx opens`, !!r && !r.error, r?.error ?? "");
    if (r && !r.error) o.verify(r);
  }

  for (const o of outputs) {
    if (o.name === "prefixes") {
      console.log("SKIP  prefixes: pptxtojson assumes the conventional p:/a: prefixes");
      continue;
    }
    const ab = o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) as ArrayBuffer;
    const json = await pptxToJson(ab);
    const deck = await openDeck(o.bytes);
    let idsOk = json.slides.length === deck.slideCount;
    json.slides.forEach((slide: { elements: { id: string; elements?: { id: string }[] }[] }, k: number) => {
      const rendered = new Set<string>();
      for (const el of slide.elements) {
        rendered.add(el.id);
        for (const c of el.elements ?? []) rendered.add(c.id);
      }
      // Every editable shape except mc:AlternateContent ones (pptxtojson skips those) is rendered with the same id.
      for (const t of getSlideTexts(deck, k)) {
        if (t.paragraphs[0] === "Both branches" || t.paragraphs[0] === "Alt text") continue;
        if (!rendered.has(t.shapeId)) idsOk = false;
      }
    });
    check(`${o.name}: pptxtojson parses, ids match p:cNvPr`, idsOk);
  }

  // SOFFICE may point at a LibreOffice with Impress; the default install may lack it.
  const soffice = [process.env.SOFFICE, "/usr/bin/soffice", "/usr/bin/libreoffice"].find((p) => p && existsSync(p));
  if (!soffice) {
    console.log("SKIP  LibreOffice not installed: PDF conversion checks skipped");
  } else {
    const control = join(work, "control.pptx");
    writeFileSync(control, RICH);
    const pdfDir = join(work, "pdf");
    const r = spawnSync(
      soffice,
      [`-env:UserInstallation=file://${join(work, "lo-profile")}`, "--headless", "--convert-to", "pdf", "--outdir", pdfDir, control, ...outputs.map((o) => o.path)],
      { timeout: 300_000, stdio: "pipe" },
    );
    const made = existsSync(pdfDir) ? readdirSync(pdfDir) : [];
    if (!made.includes("control.pdf")) {
      console.log(`SKIP  LibreOffice at ${soffice} cannot convert the unmodified fixture (Impress missing?): PDF checks skipped`);
    } else {
      check("soffice: exit 0", r.status === 0, r.status === 0 ? "" : (r.stderr?.toString() ?? "").trim().slice(0, 300));
      for (const o of outputs) {
        const f = `${o.name}.pdf`;
        if (!made.includes(f)) {
          check(`${o.name}: LibreOffice converts`, false, "no pdf");
          continue;
        }
        const data = readFileSync(join(pdfDir, f));
        const pdf = await PDFDocument.load(data);
        check(`${o.name}: LibreOffice converts to ${o.pages} pages`, pdf.getPageCount() === o.pages, String(pdf.getPageCount()));
        if (o.rendered) o.rendered(await pdfPages(new Uint8Array(data)));
      }
    }
  }
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
