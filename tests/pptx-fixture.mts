/**
 * Builds small but valid .pptx files in memory for tests, so no binary
 * fixtures are needed. Everything a real deck inherits (master text styles,
 * layout placeholders, theme colours) is present.
 */
import JSZip from "jszip";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme ${NS} name="Test"><a:themeElements>
<a:clrScheme name="Test">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>
<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Test"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Test">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`;

const xfrm = (x: number, y: number, w: number, h: number) =>
  `<a:xfrm><a:off x="${x * 12700}" y="${y * 12700}"/><a:ext cx="${w * 12700}" cy="${h * 12700}"/></a:xfrm>`;

export const sp = (
  id: number,
  name: string,
  opts: { ph?: string; box?: [number, number, number, number]; paras?: string; txBox?: boolean; geom?: string; fill?: string }
) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${opts.txBox ? ' txBox="1"' : ""}/><p:nvPr>${opts.ph ?? ""}</p:nvPr></p:nvSpPr>
<p:spPr>${opts.box ? xfrm(...opts.box) : ""}${opts.geom ? `<a:prstGeom prst="${opts.geom}"><a:avLst/></a:prstGeom>` : ""}${opts.fill ? `<a:solidFill><a:srgbClr val="${opts.fill}"/></a:solidFill>` : ""}</p:spPr>
${opts.paras !== undefined ? `<p:txBody><a:bodyPr/><a:lstStyle/>${opts.paras}</p:txBody>` : ""}</p:sp>`;

export const para = (text: string, pPr = "", rPr = '<a:rPr lang="en-US" dirty="0"/>') =>
  `<a:p>${pPr}<a:r>${rPr}<a:t>${text}</a:t></a:r></a:p>`;

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${sp(2, "Title Placeholder 1", { ph: '<p:ph type="title"/>', box: [36, 20, 648, 90] })}
${sp(3, "Text Placeholder 2", { ph: '<p:ph type="body" idx="1"/>', box: [36, 126, 648, 356] })}
${sp(10, "Master band", { box: [0, 520, 720, 20], geom: "rect", fill: "112233" })}
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="ctr"><a:buNone/><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle>
<a:lvl1pPr marL="342900" indent="-342900" algn="l"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
<a:lvl2pPr marL="742950" indent="-285750" algn="l"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buClr><a:schemeClr val="accent2"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8211;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl2pPr>
</p:bodyStyle>
<p:otherStyle><a:lvl1pPr marL="0"><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
</p:txStyles></p:sldMaster>`;

const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="obj"><p:cSld name="Title and Content"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${sp(2, "Title 1", { ph: '<p:ph type="title"/>' })}
${sp(3, "Content Placeholder 2", { ph: '<p:ph idx="1"/>' })}
${sp(5, "Layout corner", { box: [680, 0, 40, 40], geom: "ellipse", fill: "445566" })}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

export interface FixtureSlide {
  xml: string;
  hidden?: boolean;
}

export const slideXml = (shapes: string, hidden = false) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}${hidden ? ' show="0"' : ""}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${shapes}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

/**
 * @param slides slide XML bodies, stored as slide1.xml, slide2.xml, ...
 * @param order  presentation order as 1-based part numbers (default 1..n)
 */
export async function buildPptx(
  input: (string | { xml: string; rels?: string })[],
  order?: number[]
): Promise<Uint8Array> {
  const slides = input.map((s) => (typeof s === "string" ? { xml: s, rels: "" } : { rels: "", ...s }));
  const zip = new JSZip();
  const seq = order ?? slides.map((_, i) => i + 1);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("\n")}
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${seq.map((n, i) => `<p:sldId id="${256 + i}" r:id="rIdS${n}"/>`).join("")}</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>
<p:defaultTextStyle><a:lvl1pPr marL="0"><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rIdT" Type="${REL}/theme" Target="theme/theme1.xml"/>
${slides.map((_, i) => `<Relationship Id="rIdS${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("\n")}
</Relationships>`
  );
  zip.file("ppt/theme/theme1.xml", THEME);
  zip.file("ppt/slideMasters/slideMaster1.xml", MASTER);
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`
  );
  zip.file("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
  );
  slides.forEach(({ xml, rels }, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${rels}</Relationships>`
    );
  });
  return zip.generateAsync({ type: "uint8array" });
}
