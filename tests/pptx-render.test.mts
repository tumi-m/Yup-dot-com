// Rendering fidelity: deck model (lib/pptx/parse.ts + ooxml.ts) and <SlideView> markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import { parsePptx, type Deck } from "../lib/pptx/parse.ts";
import { SlideView, connectorPath } from "../components/slides/SlideView.tsx";
import { analyzeSlide, themeGradient, bulletChar, chartInfo, customTextRect, resolveColor } from "../lib/pptx/ooxml.ts";
import { niceAxis } from "../components/slides/ChartView.tsx";
import { parseXml, path } from "../lib/pptx/xml.ts";
import { buildPptx, slideXml } from "./pptx-fixture.mts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const render = (deck: Deck, i = 0) =>
  renderToStaticMarkup(
    createElement(SlideView, {
      slide: deck.slides[i],
      deckWidth: deck.width,
      deckHeight: deck.height,
      scale: 1,
      themeColors: deck.themeColors,
    })
  );

/* ---------------- built-in table style vs cells with their own fill ---------------- */
{
  const MEDIUM2_ACCENT1 = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";
  const tc = (text: string, fill = "") =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr>${fill}</a:tcPr></a:tc>`;
  const table = (id: number, styleId: string) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="${id === 4 ? 508000 : 508000}" y="${id === 4 ? 508000 : 3048000}"/><a:ext cx="5080000" cy="1524000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>
<a:tblGrid><a:gridCol w="2540000"/><a:gridCol w="2540000"/></a:tblGrid>
<a:tr h="508000">${tc("H1")}${tc("H2")}</a:tr>
<a:tr h="508000">${tc("Own", '<a:solidFill><a:srgbClr val="FFE080"/></a:solidFill>')}${tc("Styled")}</a:tr>
<a:tr h="508000">${tc("None", "<a:noFill/>")}${tc("Styled 2")}</a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const bytes = await buildPptx([slideXml(table(4, MEDIUM2_ACCENT1))]);
  const deck = await parsePptx(bytes).catch(() => null);
  check("table: a styled table without ppt/tableStyles.xml opens", !!deck);
  if (!deck) process.exit(1);
  const el = deck.slides[0].elements.find((e) => e.id === "4")!;
  check("table: built-in style not in the file", el.tableFlags?.styleInFile === false, JSON.stringify(el.tableFlags));
  check("table: cells with their own fill recorded", JSON.stringify(el.tableFlags?.ownFill) === "[[false,false],[true,false],[true,false]]", JSON.stringify(el.tableFlags?.ownFill));
  const html = render(deck);
  const cells = Array.from(html.matchAll(/<td[^>]*style="([^"]*)"/g), (m) => m[1]);
  const bg = (s: string) => /background-color:([^;]+)/.exec(s)?.[1] ?? "none";
  check("table: header row still styled when another cell has a fill", bg(cells[0]) === "#4F81BD" && bg(cells[1]) === "#4F81BD", cells.map(bg).join(","));
  check("table: own fill wins", bg(cells[2]).toUpperCase() === "#FFE080", bg(cells[2]));
  check("table: banded body cells styled", bg(cells[3]) !== "none" && bg(cells[5]) !== "none", cells.map(bg).join(","));
  check("table: a:noFill cell stays unfilled", bg(cells[4]) === "none", bg(cells[4]));

  // The same style defined in ppt/tableStyles.xml is pptxtojson's to apply.
  const zip = await JSZip.loadAsync(bytes);
  zip.file(
    "ppt/tableStyles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${MEDIUM2_ACCENT1}"><a:tblStyle styleId="${MEDIUM2_ACCENT1}" styleName="Medium Style 2 - Accent 1"><a:wholeTbl><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl></a:tblStyle></a:tblStyleLst>`
  );
  const inFile = await parsePptx(await zip.generateAsync({ type: "uint8array" }));
  check("table: style defined in the file detected", inFile.slides[0].elements.find((e) => e.id === "4")?.tableFlags?.styleInFile === true);
}

/* ---------------- colour modifiers ---------------- */
{
  const ctx = { scheme: { dk1: "000000", accent1: "4F81BD" }, map: { tx1: "dk1" } };
  const color = (inner: string) => resolveColor(path(parseXml(`<a:solidFill>${inner}</a:solidFill>`), "a:solidFill"), ctx);
  // Office (and LibreOffice) mix tints and shades in linear RGB: black at a
  // 75% tint is #898989 (the 2007 subtitle grey), not #404040.
  check("tint is applied in linear RGB", color('<a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr>') === "#898989",
    color('<a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr>'));
  check("shade is applied in linear RGB", color('<a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr>') === "#BCBCBC",
    color('<a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr>'));
  check("lumMod/lumOff unchanged", color('<a:schemeClr val="tx1"><a:lumMod val="75000"/><a:lumOff val="25000"/></a:schemeClr>') === "#404040");
}

/* ---------------- symbol-font bullets ---------------- */
{
  // LibreOffice writes its dash bullet as Symbol U+F02D (a minus sign).
  check("Symbol bullet in the private use area", bulletChar("\uF02D", "Symbol") === "\u2212", bulletChar("\uF02D", "Symbol"));
  check("Symbol bullet as its 8-bit code", bulletChar("\u00B7", "Symbol") === "\u2022");
  check("Wingdings bullet in the private use area", bulletChar("\uF06C", "Wingdings") === "\u25CF" && bulletChar("\uF0A7", "Wingdings") === "\u25AA");
  check("unknown Wingdings code falls back to a dot", bulletChar("w", "Wingdings") === "\u2022" && bulletChar("\uF077", "Wingdings") === "\u2022");
  check("ordinary bullet characters pass through", bulletChar("\u2013", "Arial") === "\u2013" && bulletChar("\u2022") === "\u2022");
}

/* ---------------- right-to-left paragraphs ---------------- */
{
  const rtlBox = `<p:sp><p:nvSpPr><p:cNvPr id="5" name="RTL"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5080000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr rtl="1" algn="r"/><a:r><a:rPr lang="ar-SA"/><a:t>مرحبا</a:t></a:r></a:p><a:p><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>`;
  const deck = await parsePptx(await buildPptx([slideXml(rtlBox)]));
  const paras = deck.slides[0].elements.find((e) => e.id === "5")?.paragraphs ?? [];
  check("rtl flag read per paragraph", paras[0]?.rtl === true && !paras[1]?.rtl, JSON.stringify(paras.map((p) => p.rtl)));
}

/* ---------------- charts ---------------- */
{
  const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const ser = (name: string) => `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx></c:ser>`;
  const space = (chart: string, txPr = "") => parseXml(`<c:chartSpace ${C}><c:chart>${chart}</c:chart>${txPr}</c:chartSpace>`);
  const pie = chartInfo(space(`<c:autoTitleDeleted val="0"/><c:plotArea><c:pieChart><c:varyColors val="1"/>${ser("Share")}</c:pieChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend>`,
    '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1400"/></a:pPr></a:p></c:txPr>'));
  check("chart: single series gets the automatic title", pie.title === "Share", JSON.stringify(pie));
  check("chart: legend position, font size, varyColors", pie.legendPos === "b" && pie.fontSize === 14 && pie.varyColors === true, JSON.stringify(pie));
  const two = chartInfo(space(`<c:autoTitleDeleted val="0"/><c:plotArea><c:barChart>${ser("A")}${ser("B")}</c:barChart></c:plotArea>`));
  check("chart: no automatic title for several series, no legend", two.title === undefined && two.legendPos === undefined, JSON.stringify(two));
  const deleted = chartInfo(space(`<c:autoTitleDeleted val="1"/><c:plotArea><c:barChart>${ser("A")}</c:barChart></c:plotArea><c:legend><c:legendPos val="r"/><c:delete val="1"/></c:legend>`));
  check("chart: deleted title and legend stay hidden", deleted.title === undefined && deleted.legendPos === undefined, JSON.stringify(deleted));
  const loStyle = chartInfo(space(`<c:plotArea><c:barChart>${ser("A")}${ser("B")}</c:barChart><c:valAx><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1800"/></a:pPr></a:p></c:txPr></c:valAx></c:plotArea>`));
  check("chart: text size from the axes when the chart has none", loStyle.fontSize === 18, JSON.stringify(loStyle));
  const rich = chartInfo(space(`<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales </a:t></a:r><a:r><a:t>2026</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea/>`));
  check("chart: rich title text", rich.title === "Sales 2026", JSON.stringify(rich));
  const a = niceAxis(-4.5, 22);
  check("chart: value axis on a 1-2-5 step", a.lo === -5 && a.hi === 25 && a.ticks.join(",") === "-5,0,5,10,15,20,25", a.ticks.join(","));
  const p = niceAxis(0, 1);
  check("chart: 0..1 axis", p.lo === 0 && p.hi === 1 && p.ticks.length === 6, p.ticks.join(","));
}

/* ---------------- custom shape text area ---------------- */
{
  // As LibreOffice writes a heart: the text area in guide formulas.
  const heart = parseXml(`<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1368000" cy="679680"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst>
<a:gd name="textAreaLeft" fmla="*/ 321480 w 1368000"/><a:gd name="textAreaRight" fmla="*/ 1045800 w 1368000"/>
<a:gd name="textAreaTop" fmla="*/ 79920 h 679680"/><a:gd name="textAreaBottom" fmla="*/ 426240 h 679680"/></a:gdLst>
<a:rect l="textAreaLeft" t="textAreaTop" r="textAreaRight" b="textAreaBottom"/></a:custGeom></p:spPr></p:sp>`);
  const r = customTextRect(path(heart, "p:sp")!);
  const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-6;
  check("custom geometry text rectangle from guides", near(r?.l, 321480 / 1368000) && near(r?.t, 79920 / 679680) && near(r?.r, 1045800 / 1368000) && near(r?.b, 426240 / 679680), JSON.stringify(r));
  const full = parseXml(`<p:sp><p:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm><a:custGeom><a:rect l="l" t="t" r="r" b="b"/></a:custGeom></p:spPr></p:sp>`);
  check("whole-box text rectangle is ignored", customTextRect(path(full, "p:sp")!) === undefined);
  const odd = parseXml(`<p:sp><p:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm><a:custGeom><a:gdLst><a:gd name="x" fmla="at2 1 2"/></a:gdLst><a:rect l="x" t="t" r="r" b="b"/></a:custGeom></p:spPr></p:sp>`);
  check("unknown guide operator: no rectangle", customTextRect(path(odd, "p:sp")!) === undefined);
}

/* ---------------- other apps' presentations under a .pptx name ---------------- */
{
  const odp = new JSZip();
  odp.file("mimetype", "application/vnd.oasis.opendocument.presentation");
  odp.file("content.xml", "<x/>");
  const key = new JSZip();
  key.file("Index/Document.iwa", "x");
  const code = async (z: JSZip) => parsePptx(await z.generateAsync({ type: "uint8array" })).then(() => "ok", (e) => e.code);
  check("renamed OpenDocument presentation: save as .pptx", (await code(odp)) === "legacy");
  check("renamed Keynote file: save as .pptx", (await code(key)) === "legacy");
  const other = new JSZip();
  other.file("a.txt", "x");
  check("other zip: not a valid .pptx", (await code(other)) === "invalid");
}

/* ---------------- capitals and highlight ---------------- */
{
  // Title style with cap="all" (as many templates have); one run highlighted.
  const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr cap="all"/></a:lvl1pPr></a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>Quarterly </a:t></a:r><a:r><a:rPr lang="en-US" cap="none"><a:highlight><a:srgbClr val="FFFF00"/></a:highlight></a:rPr><a:t>review</a:t></a:r></a:p></p:txBody></p:sp>`;
  const deck = await parsePptx(await buildPptx([slideXml(title)]));
  const runs = deck.slides[0].elements.find((e) => e.id === "2")?.paragraphs?.[0]?.runs ?? [];
  check("cap inherited from the list style, overridden per run", runs[0]?.cap === "all" && runs[1]?.cap === undefined, JSON.stringify(runs));
  check("highlight colour per run", runs[1]?.highlight === "#FFFF00" && !runs[0]?.highlight, JSON.stringify(runs));
  check("run texts in order", runs.map((r) => r.text).join("") === "Quarterly review");
}

/* ---------------- text direction, columns, picture transparency ---------------- */
{
  const tb = (id: number, bodyPr: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="T${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="2540000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody>${bodyPr}<a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Text ${id}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdX"><a:alphaModFix amt="40000"/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  const bytes = await buildPptx([slideXml(tb(2, '<a:bodyPr vert="vert270"/>') + tb(3, '<a:bodyPr numCol="2" spcCol="254000"/>') + tb(4, "<a:bodyPr/>") + pic)]);
  const deck = await parsePptx(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const info = await analyzeSlide(async (p) => (zip.file(p) ? zip.file(p)!.async("string") : null), "ppt/slides/slide1.xml");
  const els = deck.slides[0].elements;
  const el = (id: string) => els.find((e) => e.id === id);
  check("vert270 text direction read", el("2")?.vert === "vert270", String(el("2")?.vert));
  check("text columns read (count, gap in pt)", el("3")?.columns?.count === 2 && el("3")?.columns?.gap === 20, JSON.stringify(el("3")?.columns));
  check("plain text box: no direction or columns", !el("4")?.vert && !el("4")?.columns);
  check("picture transparency read", info.pictureAlpha["9"] === 0.4, JSON.stringify(info.pictureAlpha));
}

/* ---------------- flipped groups ---------------- */
{
  const child = (id: number, x: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="C${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>`;
  const grp = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm flipH="1"><a:off x="0" y="0"/><a:ext cx="3810000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="3810000" cy="1270000"/></a:xfrm></p:grpSpPr>${child(21, 0)}${child(22, 2540000)}</p:grpSp>`;
  const deck = await parsePptx(await buildPptx([slideXml(grp)]));
  const html = render(deck);
  const groupDiv = /<div data-element-id="20"[^>]*>/.exec(html)?.[0] ?? "";
  check("flipped group: no mirroring transform on the group (text stays readable)", !!groupDiv && !groupDiv.includes("scale(-1"), groupDiv);
  const lefts = Array.from(html.matchAll(/data-element-id="(21|22)"[^>]*style="[^"]*left:([\d.]+)(px)?[;"]/g), (m) => `${m[1]}:${m[2]}`);
  check("flipped group: children mirrored in place", lefts.join(",") === "21:200,22:0", lefts.join(","));
}

/* ---------------- connectors ---------------- */
{
  const c = (shapType: string, keypoints?: Record<string, number>) => connectorPath({ shapType, width: 100, height: 50, keypoints });
  check("bentConnector2 turns at the top right", c("bentConnector2") === "M 0 0 L 100 0 L 100 50", String(c("bentConnector2")));
  check("bentConnector4 uses its adjust values", c("bentConnector4", { adj1: 0.4, adj2: 1.2 }) === "M 0 0 L 20 0 L 20 30 L 100 30 L 100 50", String(c("bentConnector4", { adj1: 0.4, adj2: 1.2 })));
  check("curved connectors are curves from start to end", ["curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5"].every((k) => {
    const d = c(k) ?? "";
    return d.startsWith("M 0 0 C") && d.endsWith("100 50");
  }));
  check("right arrow head is half the short side long", c("rightArrow") === "M 0 12.5 L 75 12.5 L 75 0 L 100 25 L 75 50 L 75 37.5 L 0 37.5 Z", String(c("rightArrow")));
  check("other shapes keep pptxtojson's path", c("bentConnector3") === null && c("rect") === null);
}

/* ---------------- theme fill styles ---------------- */
{
  const style = path(parseXml(`<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill>`), "a:gradFill");
  const g = themeGradient(style, "#4F81BD", { scheme: {}, map: {} });
  check("theme gradient style takes the shape's colour for phClr", g?.value.colors[1].color === "#4F81BD" && g.value.colors[0].pos === "0%" && g.value.rot === 270, JSON.stringify(g));
  check("tinted stop is lighter", !!g && parseInt(g.value.colors[0].color.slice(1), 16) > parseInt("4F81BD", 16));
  check("solid theme style: no gradient", themeGradient(path(parseXml('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'), "a:solidFill"), "#000000", { scheme: {}, map: {} }) === undefined);
}

/* ---------------- file colours never become an external paint url ---------------- */
{
  // url(...) as SVG paint loads a paint server from any host, so opening a
  // deck would ping a server of the file author's choosing.
  const U = "url(https://x.test/p.svg#a)";
  const shape = (id: number, spPr: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${id * 1300000}" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPr}</p:spPr></p:sp>`;
  const deck = await parsePptx(
    await buildPptx([
      slideXml(
        shape(4, `<a:solidFill><a:srgbClr val="${U}"/></a:solidFill>`) +
          shape(5, `<a:pattFill prst="pct50"><a:fgClr><a:srgbClr val="${U}"/></a:fgClr><a:bgClr><a:srgbClr val="${U}"/></a:bgClr></a:pattFill>`) +
          shape(6, `<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`) +
          shape(7, `<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="${U}"/></a:solidFill></a:ln>`)
      ),
    ])
  );
  const external = (html: string) => Array.from(html.matchAll(/(?:fill|stroke|stop-color)="(url\((?!#)[^"]*)"/g), (m) => m[1]);
  const html = render(deck);
  check("file colours never become an external paint url", external(html).length === 0, JSON.stringify(external(html)));
  check("a plain hex fill still renders", /fill="#FF0000"/i.test(html) && /fill="#00FF00"/i.test(html));
  check("a pattern fill falls back to its default colours", /<pattern[^>]*><rect[^>]*fill="#FFFFFF"[^>]*><\/rect><rect[^>]*fill="#000000"/.test(html));

  // SlideView checks again where it draws, for a deck model from anywhere.
  const base = { left: 0, top: 0, width: 50, height: 50, borderWidth: 2, borderType: "solid", content: "", shapType: "rect", order: 0 };
  const slide = {
    number: 1, hidden: false, note: "", part: "ppt/slides/slide1.xml", layoutElements: [],
    fill: { type: "color", value: U },
    elements: [
      { ...base, type: "shape", id: "1", fill: { type: "color", value: U }, borderColor: U },
      { ...base, type: "shape", id: "2", fill: { type: "pattern", value: { type: "pct50", foregroundColor: U, backgroundColor: U } }, borderColor: "" },
      { ...base, type: "shape", id: "3", fill: { type: "color", value: "#0000FF" }, borderColor: "#123456" },
      {
        type: "chart", id: "4", left: 0, top: 0, width: 200, height: 100, order: 0, chartType: "barChart", barDir: "col",
        colors: [U], data: [{ key: "S", values: [{ x: "a", y: 1 }], xlabels: { 0: "a" } }],
      },
    ],
  } as unknown as Deck["slides"][number];
  const raw = renderToStaticMarkup(createElement(SlideView, { slide, deckWidth: 400, deckHeight: 300, scale: 1, themeColors: Array(6).fill(U) }));
  check("SlideView drops url() colours in a deck model", external(raw).length === 0 && !raw.includes("x.test"), JSON.stringify(external(raw)));
  check("SlideView keeps plain colours in a deck model", /fill="#0000FF"/.test(raw) && /stroke="#123456"/.test(raw) && /<rect[^>]*fill="#4472C4"/.test(raw));

  // Real chart parts through parsePptx: the colour cleaning must leave chart
  // series values alone (they live in `data` like table cells do).
  const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="508000" y="508000"/><a:ext cx="5080000" cy="3048000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const rels = `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>`;
  const pts = (vals: (string | number)[]) => `<c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
  const fill = (clr: string) => `<c:spPr><a:solidFill><a:srgbClr val="${clr}"/></a:solidFill></c:spPr>`;
  const ser = (i: number, clr: string, vals: number[]) =>
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>S${i}</c:v></c:pt></c:strCache></c:strRef></c:tx>${fill(clr)}` +
    `<c:cat><c:strRef><c:strCache>${pts(["Q1", "Q2", "Q3"])}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache>${pts(vals)}</c:numCache></c:numRef></c:val></c:ser>`;
  const xy = (i: number, ys: number[]) =>
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${fill("4472C4")}<c:xVal><c:numRef><c:numCache>${pts([1, 2, 3])}</c:numCache></c:numRef></c:xVal><c:yVal><c:numRef><c:numCache>${pts(ys)}</c:numCache></c:numRef></c:yVal></c:ser>`;
  const plot = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace ${NS}><c:chart><c:plotArea><c:layout/>${body}</c:plotArea></c:chart></c:chartSpace>`;
  const chartDeck = async (chartXml: string) => {
    const zip = await JSZip.loadAsync(await buildPptx([{ xml: slideXml(frame), rels }]));
    zip.file("ppt/charts/chart1.xml", chartXml);
    return parsePptx(await zip.generateAsync({ type: "uint8array" }));
  };
  const chartOf = (d: Deck) => d.slides[0].elements.find((e) => e.type === "chart") as unknown as { data: unknown; colors: string[] };
  const opens = async (xml: string) => chartDeck(xml).then((d) => d, (err: Error) => err);

  for (const [kind, body] of [
    ["bar", `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser(0, "4472C4", [3, 5, 4])}${ser(1, U, [2, 2, 3])}</c:barChart>`],
    ["line", `<c:lineChart><c:grouping val="standard"/>${ser(0, "4472C4", [3, 5, 4])}</c:lineChart>`],
    ["pie", `<c:pieChart>${ser(0, "4472C4", [3, 5, 4])}</c:pieChart>`],
  ] as const) {
    const d = await opens(plot(body));
    check(`a deck with a ${kind} chart opens`, !(d instanceof Error), d instanceof Error ? d.message : "");
    if (d instanceof Error) continue;
    const el = chartOf(d);
    const first = (el.data as { values: { y: number }[] }[])[0];
    check(`${kind} chart series values survive parsing`, JSON.stringify(first?.values.map((v) => v.y)) === "[3,5,4]", JSON.stringify(el.data));
    if (kind === "bar") {
      check("bar chart: url() series colour dropped, plain one kept", JSON.stringify(el.colors) === '["#4472C4",""]', JSON.stringify(el.colors));
      const html = render(d);
      check("bar chart draws its bars in the series colour", /<rect[^>]*fill="#4472C4"/.test(html) && !html.includes("x.test"));
    }
  }
  const sc = await opens(plot(`<c:scatterChart><c:scatterStyle val="lineMarker"/>${xy(0, [4, 5, 6])}${xy(1, [7, 8, 9])}</c:scatterChart>`));
  check("scatter chart numbers survive parsing unchanged", !(sc instanceof Error) && JSON.stringify(chartOf(sc).data) === "[[1,2,3],[4,5,6],[7,8,9]]", sc instanceof Error ? sc.message : JSON.stringify(chartOf(sc).data));

  // Table cells are still cleaned.
  const cell = (pr: string) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>x</a:t></a:r></a:p></a:txBody><a:tcPr>${pr}</a:tcPr></a:tc>`;
  const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table 5"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="508000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/><a:gridCol w="1270000"/></a:tblGrid>` +
    `<a:tr h="508000">${cell(`<a:lnL w="12700"><a:solidFill><a:srgbClr val="${U}"/></a:solidFill></a:lnL><a:solidFill><a:srgbClr val="${U}"/></a:solidFill>`)}${cell('<a:solidFill><a:srgbClr val="FFE080"/></a:solidFill>')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const td = await parsePptx(await buildPptx([slideXml(tbl)]));
  const tHtml = render(td);
  check("table cell url() colours never reach the page", !tHtml.includes("x.test") && /#FFE080/i.test(tHtml));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
