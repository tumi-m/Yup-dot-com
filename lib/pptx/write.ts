import JSZip from "jszip";

/**
 * Minimal PowerPoint (.pptx) writer: one picture per slide.
 *
 * The package mirrors what PowerPoint writes for a blank deck — one master,
 * one blank layout, one theme — so PowerPoint, Keynote, Google Slides and
 * LibreOffice all open it without a repair prompt. Every part has a content
 * type and every relationship id resolves.
 */

export const EMU_PER_INCH = 914400;
export const EMU_PER_PT = 12700;
/** PowerPoint's allowed slide dimension range (ST_SlideSizeCoordinate). */
export const MIN_SLIDE_EMU = EMU_PER_INCH; // 1 in
export const MAX_SLIDE_EMU = 56 * EMU_PER_INCH; // 56 in

export type PptxImageFormat = "png" | "jpeg";

export interface PptxFrame {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export interface PptxSlide {
  image: Uint8Array;
  format: PptxImageFormat;
  /** Position and size in EMU; defaults to full-bleed. */
  frame?: PptxFrame;
  /** Alt text for the picture (descr on p:cNvPr). */
  altText?: string;
}

export interface PptxInput {
  /** Slide width in EMU. */
  width: number;
  /** Slide height in EMU. */
  height: number;
  slides: PptxSlide[];
  title?: string;
  /** Fixed timestamp for reproducible output (defaults to now). */
  date?: Date;
}

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument.presentationml";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PML_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

/** Escape text for an XML attribute or text node, dropping characters XML 1.0 forbids. */
export function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r\n?|\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

function clampEmu(v: number): number {
  return Math.round(Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, v)));
}

function rels(entries: { id: string; type: string; target: string }[]): string {
  return (
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    entries
      .map((e) => `<Relationship Id="${e.id}" Type="${e.type}" Target="${e.target}"/>`)
      .join("") +
    "</Relationships>"
  );
}

const EMPTY_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function levelStyles(sizes: number[]): string {
  return sizes
    .map(
      (sz, i) =>
        `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
        `<a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>` +
        '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>' +
        `</a:lvl${i + 1}pPr>`
    )
    .join("");
}

const DEFAULT_TEXT_STYLE =
  '<a:defPPr><a:defRPr lang="en-US"/></a:defPPr>' + levelStyles(new Array(9).fill(1800));

function theme(): string {
  const font = (latin: string) =>
    `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return (
    XML_HEAD +
    `<a:theme xmlns:a="${NS_A}" name="Office Theme"><a:themeElements>` +
    '<a:clrScheme name="Office">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    "</a:clrScheme>" +
    `<a:fontScheme name="Office"><a:majorFont>${font("Calibri Light")}</a:majorFont>` +
    `<a:minorFont>${font("Calibri")}</a:minorFont></a:fontScheme>` +
    '<a:fmtScheme name="Office">' +
    `<a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    "<a:effectStyleLst>" +
    "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3) +
    "</a:effectStyleLst>" +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst>` +
    "</a:fmtScheme></a:themeElements>" +
    "<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
  );
}

function placeholder(id: number, name: string, ph: string, off: [number, number], ext: [number, number]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/>' +
    '<a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>'
  );
}

function slideMaster(w: number, h: number): string {
  // Title and body placeholders scaled to the slide, as PowerPoint lays them out.
  const mx = Math.round(w * 0.0625);
  const title = placeholder(2, "Title Placeholder 1", '<p:ph type="title"/>',
    [mx, Math.round(h * 0.04)], [w - 2 * mx, Math.round(h * 0.167)]);
  const body = placeholder(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>',
    [mx, Math.round(h * 0.233)], [w - 2 * mx, Math.round(h * 0.66)]);
  const titleStyle =
    '<a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">' +
    '<a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>' +
    '<a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
    '<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr>';
  return (
    XML_HEAD +
    `<p:sldMaster ${PML_NS}><p:cSld>` +
    '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    `<p:spTree>${EMPTY_GROUP}${title}${body}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    `<p:txStyles><p:titleStyle>${titleStyle}</p:titleStyle>` +
    `<p:bodyStyle>${levelStyles([2800, 2400, 2000, 1800, 1800])}</p:bodyStyle>` +
    `<p:otherStyle>${DEFAULT_TEXT_STYLE}</p:otherStyle></p:txStyles>` +
    "</p:sldMaster>"
  );
}

function blankLayout(): string {
  return (
    XML_HEAD +
    `<p:sldLayout ${PML_NS} type="blank" preserve="1"><p:cSld name="Blank">` +
    `<p:spTree>${EMPTY_GROUP}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
  );
}

function pictureSlide(index: number, slide: PptxSlide, frame: PptxFrame): string {
  const descr = slide.altText ? ` descr="${xmlEscape(slide.altText)}"` : "";
  return (
    XML_HEAD +
    `<p:sld ${PML_NS}><p:cSld><p:spTree>${EMPTY_GROUP}` +
    "<p:pic><p:nvPicPr>" +
    `<p:cNvPr id="2" name="Page ${index}"${descr}/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr><a:xfrm><a:off x="${Math.round(frame.x)}" y="${Math.round(frame.y)}"/>` +
    `<a:ext cx="${Math.round(frame.cx)}" cy="${Math.round(frame.cy)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>' +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
  );
}

function presentation(w: number, h: number, slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join("");
  return (
    XML_HEAD +
    `<p:presentation ${PML_NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    (slideCount ? `<p:sldIdLst>${ids}</p:sldIdLst>` : "") +
    `<p:sldSz cx="${w}" cy="${h}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `<p:defaultTextStyle>${DEFAULT_TEXT_STYLE}</p:defaultTextStyle></p:presentation>`
  );
}

function presProps(): string {
  return XML_HEAD + `<p:presentationPr ${PML_NS}/>`;
}

function viewProps(): string {
  return (
    XML_HEAD +
    `<p:viewPr ${PML_NS} lastView="sldThumbnailView">` +
    '<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>' +
    '<p:gridSpacing cx="76200" cy="76200"/></p:viewPr>'
  );
}

function tableStyles(): string {
  return XML_HEAD + `<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;
}

function coreProps(title: string, date: Date): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEscape(title)}</dc:title><cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

function appProps(slideCount: number): string {
  return (
    XML_HEAD +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<TotalTime>0</TotalTime><Words>0</Words><Application>PDF Wizard</Application>" +
    "<PresentationFormat>Custom</PresentationFormat><Paragraphs>0</Paragraphs>" +
    `<Slides>${slideCount}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips>` +
    "<ScaleCrop>false</ScaleCrop>" +
    '<HeadingPairs><vt:vector size="4" baseType="variant">' +
    "<vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>" +
    `<vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant><vt:variant><vt:i4>${slideCount}</vt:i4></vt:variant>` +
    "</vt:vector></HeadingPairs>" +
    `<TitlesOfParts><vt:vector size="${slideCount + 1}" baseType="lpstr"><vt:lpstr>Office Theme</vt:lpstr>` +
    Array.from({ length: slideCount }, (_, i) => `<vt:lpstr>Page ${i + 1}</vt:lpstr>`).join("") +
    "</vt:vector></TitlesOfParts>" +
    "<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>" +
    "<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>"
  );
}

function contentTypes(slideCount: number): string {
  const override = (part: string, type: string) =>
    `<Override PartName="${part}" ContentType="${type}"/>`;
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    override("/ppt/presentation.xml", `${CT}.presentation.main+xml`) +
    override("/ppt/slideMasters/slideMaster1.xml", `${CT}.slideMaster+xml`) +
    override("/ppt/slideLayouts/slideLayout1.xml", `${CT}.slideLayout+xml`) +
    Array.from({ length: slideCount }, (_, i) =>
      override(`/ppt/slides/slide${i + 1}.xml`, `${CT}.slide+xml`)
    ).join("") +
    override("/ppt/presProps.xml", `${CT}.presProps+xml`) +
    override("/ppt/viewProps.xml", `${CT}.viewProps+xml`) +
    override("/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml") +
    override("/ppt/tableStyles.xml", `${CT}.tableStyles+xml`) +
    override("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml") +
    override("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml") +
    "</Types>"
  );
}

/** Build a .pptx package. Slide size is clamped to PowerPoint's 1–56 inch range. */
export async function writePptx(input: PptxInput): Promise<Uint8Array> {
  const w = clampEmu(input.width);
  const h = clampEmu(input.height);
  const n = input.slides.length;
  const zip = new JSZip();
  // Office never writes folder entries; keep the package to parts only.
  const put = (name: string, data: string | Uint8Array, opts: JSZip.JSZipFileOptions = {}) =>
    zip.file(name, data, { ...opts, createFolders: false });

  // [Content_Types].xml first, as Office writes it.
  put("[Content_Types].xml", contentTypes(n));
  put(
    "_rels/.rels",
    rels([
      { id: "rId1", type: `${REL}/officeDocument`, target: "ppt/presentation.xml" },
      { id: "rId2", type: `${NS_PKG_REL}/metadata/core-properties`, target: "docProps/core.xml" },
      { id: "rId3", type: `${REL}/extended-properties`, target: "docProps/app.xml" },
    ])
  );
  put("docProps/core.xml", coreProps(input.title ?? "", input.date ?? new Date()));
  put("docProps/app.xml", appProps(n));

  put("ppt/presentation.xml", presentation(w, h, n));
  put(
    "ppt/_rels/presentation.xml.rels",
    rels([
      { id: "rId1", type: `${REL}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
      ...input.slides.map((_, i) => ({
        id: `rId${i + 2}`,
        type: `${REL}/slide`,
        target: `slides/slide${i + 1}.xml`,
      })),
      { id: `rId${n + 2}`, type: `${REL}/presProps`, target: "presProps.xml" },
      { id: `rId${n + 3}`, type: `${REL}/viewProps`, target: "viewProps.xml" },
      { id: `rId${n + 4}`, type: `${REL}/theme`, target: "theme/theme1.xml" },
      { id: `rId${n + 5}`, type: `${REL}/tableStyles`, target: "tableStyles.xml" },
    ])
  );
  put("ppt/presProps.xml", presProps());
  put("ppt/viewProps.xml", viewProps());
  put("ppt/tableStyles.xml", tableStyles());
  put("ppt/theme/theme1.xml", theme());

  put("ppt/slideMasters/slideMaster1.xml", slideMaster(w, h));
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([
      { id: "rId1", type: `${REL}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: `${REL}/theme`, target: "../theme/theme1.xml" },
    ])
  );
  put("ppt/slideLayouts/slideLayout1.xml", blankLayout());
  put(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: `${REL}/slideMaster`, target: "../slideMasters/slideMaster1.xml" }])
  );

  input.slides.forEach((slide, i) => {
    const num = i + 1;
    const ext = slide.format === "png" ? "png" : "jpeg";
    const frame = slide.frame ?? { x: 0, y: 0, cx: w, cy: h };
    put(`ppt/slides/slide${num}.xml`, pictureSlide(num, slide, frame));
    put(
      `ppt/slides/_rels/slide${num}.xml.rels`,
      rels([
        { id: "rId1", type: `${REL}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: `${REL}/image`, target: `../media/image${num}.${ext}` },
      ])
    );
    // Images are already compressed; storing them avoids wasted CPU.
    put(`ppt/media/image${num}.${ext}`, slide.image, { compression: "STORE" });
  });

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}
