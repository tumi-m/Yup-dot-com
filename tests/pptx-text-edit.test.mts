// Text edits keep the formatting of what wasn't changed (lib/pptx/package.ts setShapeText).
import JSZip from "jszip";
import { getSlideTexts, openDeck, saveDeck, setShapeText } from "../lib/pptx/package.ts";
import { buildPptx, slideXml, sp } from "./pptx-fixture.mts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const run = (text: string, rPr: string) => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`;
const BOLD = '<a:rPr lang="en-US" b="1"/>';
const ITAL = '<a:rPr lang="en-US" i="1"/>';
const LINK = '<a:rPr lang="en-US"><a:hlinkClick r:id="rId9"/></a:rPr>';
const PLAIN = '<a:rPr lang="en-US"/>';

const box = (id: number, paras: string) => sp(id, `Box ${id}`, { box: [40, 40 + id * 60, 600, 50], txBox: true, paras });
const shapes =
  box(2, `<a:p>${run("Bold ", BOLD)}${run("Italic", ITAL)}${run(" plain", PLAIN)}</a:p>`) +
  box(3, `<a:p>${run("Visit example.com", LINK)}${run(" after link", PLAIN)}</a:p>`) +
  box(
    4,
    ["One", "Two", "Three", "Four", "Back"]
      .map((t, k) => `<a:p><a:pPr lvl="${[0, 1, 2, 3, 0][k]}"/>${run(t, PLAIN)}</a:p>`)
      .join("")
  ) +
  box(5, `<a:p>${run("Line one", BOLD)}<a:br>${BOLD}</a:br>${run("Line two", ITAL)}</a:p>`) +
  box(6, `<a:p>${run("Page ", PLAIN)}<a:fld id="{11111111-1111-1111-1111-111111111111}" type="slidenum">${PLAIN}<a:t>3</a:t></a:fld></a:p>`) +
  box(7, `<a:p>${run("Emoji 🚀 here", PLAIN)}</a:p>`);

const bytes = await buildPptx([slideXml(shapes)], [1]);

async function edit(id: string, paragraphs: string[]) {
  const deck = await openDeck(bytes);
  setShapeText(deck, 0, id, paragraphs);
  const out = await saveDeck(deck);
  const xml = await (await JSZip.loadAsync(out)).file("ppt/slides/slide1.xml")!.async("string");
  const start = xml.indexOf(`<p:cNvPr id="${id}"`);
  const body = xml.slice(xml.indexOf("<p:txBody>", start), xml.indexOf("</p:txBody>", start));
  const texts = getSlideTexts(await openDeck(out), 0).find((t) => t.id === id)?.paragraphs ?? [];
  return { body, texts };
}

{
  const { body, texts } = await edit("2", ["Bold Slanted plain"]);
  check("replace a word: its run's formatting is kept", body.includes(`${ITAL}<a:t>Slanted</a:t>`), body);
  check("replace a word: runs around it untouched", body.includes(`${BOLD}<a:t>Bold </a:t>`) && body.includes(`${PLAIN}<a:t> plain</a:t>`), body);
  check("replace a word: text round-trips", texts.join("|") === "Bold Slanted plain", texts.join("|"));
}
{
  const { body } = await edit("2", ["Bold Italic plain text"]);
  check("append: continues the last run", body.includes(`${PLAIN}<a:t> plain text</a:t>`) && body.includes(`${ITAL}<a:t>Italic</a:t>`), body);
}
{
  const { body } = await edit("2", ["Very Bold Italic plain"]);
  check("prepend: goes into the first run", body.includes(`${BOLD}<a:t>Very Bold </a:t>`), body);
}
{
  const { body, texts } = await edit("3", ["Visit example.com after the link"]);
  check("edit after a link: link not widened", body.includes(`${LINK}<a:t>Visit example.com</a:t>`) && body.includes(`${PLAIN}<a:t> after the link</a:t>`), body);
  check("edit after a link: text", texts[0] === "Visit example.com after the link", texts[0]);
}
{
  const { body, texts } = await edit("4", ["One", "Two", "Three", "Inserted", "Four", "Back"]);
  const levels = Array.from(body.matchAll(/<a:p><a:pPr lvl="(\d)"\/>/g), (m) => m[1]).join("");
  check("insert a line: other paragraphs keep their levels", levels === "012230", levels);
  check("insert a line: text", texts.join("|") === "One|Two|Three|Inserted|Four|Back", texts.join("|"));
}
{
  const { body, texts } = await edit("4", ["One", "Three", "Four", "Back"]);
  const levels = Array.from(body.matchAll(/<a:p><a:pPr lvl="(\d)"\/>/g), (m) => m[1]).join("");
  check("delete a line: the rest keep their levels", levels === "0230", levels);
  check("delete a line: text", texts.join("|") === "One|Three|Four|Back", texts.join("|"));
}
{
  const { body, texts } = await edit("4", ["New first", "One", "Two", "Three", "Four", "Back"]);
  const levels = Array.from(body.matchAll(/<a:p><a:pPr lvl="(\d)"\/>/g), (m) => m[1]).join("");
  check("insert at the top: takes the first paragraph's level, rest unchanged", levels === "001230", levels);
  check("insert at the top: text", texts.join("|") === "New first|One|Two|Three|Four|Back", texts.join("|"));
}
{
  const { body, texts } = await edit("3", ["Visit example.com after link", "New line"]);
  check("new paragraph after a link paragraph has no link", (body.match(/hlinkClick/g) ?? []).length === 1, body);
  check("new paragraph text", texts.join("|") === "Visit example.com after link|New line");
}
{
  const { body, texts } = await edit("5", ["Line one\nLine 2"]);
  check("line break kept, edited run keeps its format", body.includes(`${BOLD}<a:t>Line one</a:t>`) && body.includes("<a:br>") && body.includes(`${ITAL}<a:t>Line 2</a:t>`), body);
  check("line break text", texts[0] === "Line one\nLine 2", JSON.stringify(texts));
}
{
  const { body, texts } = await edit("5", ["Line oneLine two"]);
  check("removing a line break joins the runs", !body.includes("<a:br") && texts[0] === "Line oneLine two", body);
}
{
  const { body, texts } = await edit("5", ["Line one\nmiddle\nLine two"]);
  check("typing a new line break adds a:br", (body.match(/<a:br/g) ?? []).length === 2 && texts[0] === "Line one\nmiddle\nLine two", body);
}
{
  const { body, texts } = await edit("6", ["Slide 3"]);
  check("field untouched when the edit is before it", body.includes('type="slidenum"') && texts[0] === "Slide 3", body);
}
{
  const { body, texts } = await edit("6", ["Page 33"]);
  check("edited field becomes plain text", !body.includes("<a:fld") && texts[0] === "Page 33", body);
}
{
  const { texts } = await edit("7", ["Emoji 🚁 here"]);
  check("surrogate pairs are not split", texts[0] === "Emoji 🚁 here", JSON.stringify(texts));
  const { body } = await edit("7", [""]);
  check("clearing text leaves an empty paragraph with its end mark", !body.includes("<a:r>") && body.includes("<a:endParaRPr"), body);
}

{
  // Merged cells report their span (the editor lays its grid out with it).
  const tc = (t: string, attrs = "") => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1016000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/><a:gridCol w="1270000"/></a:tblGrid>
<a:tr h="508000">${tc("Wide", ' gridSpan="2"')}${tc("", ' hMerge="1"')}</a:tr><a:tr h="508000">${tc("Tall", ' rowSpan="2"')}${tc("B")}</a:tr><a:tr h="508000">${tc("", ' vMerge="1"')}${tc("C")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const deck = await openDeck(await buildPptx([slideXml(frame)]));
  const cells = getSlideTexts(deck, 0).map((t) => `${t.paragraphs[0]}@${t.row},${t.col}:${t.colSpan ?? 1}x${t.rowSpan ?? 1}`);
  check("table cells report their spans", cells.join(" ") === "Wide@0,0:2x1 Tall@1,0:1x2 B@1,1:1x1 C@2,1:1x1", cells.join(" "));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
