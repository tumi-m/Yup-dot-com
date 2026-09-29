import { child, children, parseXml, path, type XmlNode } from "./xml";

/**
 * What pptxtojson gets wrong or leaves out, read straight from the XML:
 *
 * - Bullets and indents inherited from the layout/master/text styles.
 *   pptxtojson only emits a list when the paragraph itself has <a:buChar>, so
 *   every ordinary content placeholder renders without bullets.
 * - Paragraph spacing given as a percentage (spcPct) comes out 100x too big.
 * - Subtitles take their size from the title style instead of the body style.
 * - Slide order: pptxtojson sorts slide parts by file name; the real order is
 *   <p:sldIdLst> in presentation.xml, and hidden slides are flagged there.
 * - Z-order: pptxtojson groups shapes by tag, so we also record the document
 *   order of every shape id.
 *
 * Kept free of browser APIs so it can be unit-tested in Node.
 */

export type BulletInfo =
  | { type: "none" }
  | { type: "char"; char: string; font?: string; color?: string; sizePct?: number; sizePt?: number }
  | { type: "num"; scheme: string; startAt: number; font?: string; color?: string; sizePct?: number; sizePt?: number };

export interface Spacing {
  /** Fraction of a line (spcPct) or absolute points (spcPts). */
  pct?: number;
  pts?: number;
}

export interface ParaInfo {
  level: number;
  /** Left margin and first-line indent, in points. */
  marL: number;
  indent: number;
  bullet: BulletInfo;
  spcBef?: Spacing;
  spcAft?: Spacing;
  /** Inherited default font size (pt) for runs without an explicit size. */
  defSz?: number;
  /** True when no run (nor the end-of-paragraph mark) sets its own size. */
  noRunSize: boolean;
  /** Inherited default text colour, and whether any run sets its own. */
  defColor?: string;
  noRunColor: boolean;
  /** Inherited horizontal alignment (l, ctr, r, just, dist). */
  algn?: string;
}

export interface ShapeText {
  phType?: string;
  /**
   * Vertical anchor (t, ctr, b) resolved through the layout and the master
   * placeholder of the same type. pptxtojson matches master placeholders by
   * idx, which can pick e.g. the date placeholder for a second content box.
   */
  anchor?: string;
  paragraphs: ParaInfo[];
}

export interface TableFlags {
  styleId?: string;
  firstRow: boolean;
  lastRow: boolean;
  firstCol: boolean;
  lastCol: boolean;
  bandRow: boolean;
  bandCol: boolean;
}

export interface SlideAnalysis {
  path: string;
  hidden: boolean;
  /** Paragraph info per shape id (cNvPr id), including shapes inside groups. */
  shapes: Record<string, ShapeText>;
  /**
   * Outline colours that come from the shape style (<p:style><a:lnRef>).
   * pptxtojson resolves the theme's placeholder colour (phClr) to black.
   */
  lineColors: Record<string, string>;
  /** Table style id and the "header row", "banded rows" ... switches. */
  tables: Record<string, TableFlags>;
  /** Theme hyperlink colour. */
  linkColor?: string;
  /** Document order (z-order) of each shape id on the slide. */
  zOrder: Record<string, number>;
  /** Ids of the non-placeholder shapes drawn from the layout, then the master. */
  layoutIds: string[];
  masterIds: string[];
}

export type ReadPart = (path: string) => Promise<string | null>;

const EMU_PER_PT = 12700;

/* ---------------------------------------------------------------- paths */

export function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const seg of target.replace(/\\/g, "/").split("/")) {
    if (seg === "..") base.pop();
    else if (seg && seg !== ".") base.push(seg);
  }
  return base.join("/");
}

function relsPath(part: string) {
  const parts = part.split("/");
  const file = parts.pop()!;
  return [...parts, "_rels", `${file}.rels`].join("/");
}

async function readRels(read: ReadPart, part: string) {
  const xml = await read(relsPath(part));
  const out: { id: string; type: string; target: string; external: boolean }[] = [];
  if (!xml) return out;
  for (const r of children(child(parseXml(xml), "Relationships"), "Relationship")) {
    const external = r.attrs.TargetMode === "External";
    out.push({
      id: r.attrs.Id,
      type: (r.attrs.Type ?? "").split("/").pop() ?? "",
      target: external ? r.attrs.Target : resolveTarget(part, r.attrs.Target ?? ""),
      external,
    });
  }
  return out;
}

/** Slide parts in presentation order, with the hidden flag. */
export async function slideOrder(read: ReadPart): Promise<string[]> {
  const pres = await read("ppt/presentation.xml");
  if (!pres) return [];
  const rels = await readRels(read, "ppt/presentation.xml");
  const byId = new Map(rels.map((r) => [r.id, r.target]));
  const lst = path(parseXml(pres), "p:presentation", "p:sldIdLst");
  return children(lst, "p:sldId")
    .map((s) => byId.get(s.attrs["r:id"]))
    .filter((p): p is string => !!p);
}

/* ---------------------------------------------------------------- colours */

interface ColorCtx {
  scheme: Record<string, string>;
  map: Record<string, string>;
  /** Theme fonts, for "+mj-lt" / "+mn-lt" references. */
  fonts?: { major?: string; minor?: string };
}

function themeFont(typeface: string | undefined, ctx: ColorCtx) {
  if (!typeface) return undefined;
  if (typeface.startsWith("+mj")) return ctx.fonts?.major;
  if (typeface.startsWith("+mn")) return ctx.fonts?.minor;
  return typeface;
}

const PRESET: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF",
  yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500", purple: "800080",
};

function hexToRgb(hex: string) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: number[]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex([h, s, l]: number[]) {
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r = l, g = l, b = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

function applyMods(hex: string, node: XmlNode): string {
  let hsl = rgbToHsl(hexToRgb(hex));
  let rgb = hexToRgb(hex);
  let touched = false;
  for (const m of node.children) {
    const v = Number(m.attrs.val) / 100000;
    if (!Number.isFinite(v)) continue;
    if (m.name === "a:lumMod") { hsl = rgbToHsl(rgb); hsl[2] *= v; rgb = hexToRgb(hslToHex(hsl)); touched = true; }
    else if (m.name === "a:lumOff") { hsl = rgbToHsl(rgb); hsl[2] += v; rgb = hexToRgb(hslToHex(hsl)); touched = true; }
    else if (m.name === "a:tint") { rgb = rgb.map((c) => c + (255 - c) * (1 - v)); touched = true; }
    else if (m.name === "a:shade") { rgb = rgb.map((c) => c * v); touched = true; }
  }
  if (!touched) return hex;
  return rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
}

/** Resolves an element holding one colour child (a:srgbClr, a:schemeClr, ...). */
export function resolveColor(holder: XmlNode | undefined, ctx: ColorCtx): string | undefined {
  if (!holder) return undefined;
  for (const c of holder.children) {
    let hex: string | undefined;
    if (c.name === "a:srgbClr") hex = c.attrs.val;
    else if (c.name === "a:sysClr") hex = c.attrs.lastClr ?? (c.attrs.val === "window" ? "FFFFFF" : "000000");
    else if (c.name === "a:prstClr") hex = PRESET[c.attrs.val];
    else if (c.name === "a:schemeClr") {
      const key = ctx.map[c.attrs.val] ?? c.attrs.val;
      hex = ctx.scheme[key];
    }
    if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) return `#${applyMods(hex, c).toUpperCase()}`;
  }
  return undefined;
}

function readTheme(themeXml: string | null): Pick<ColorCtx, "scheme" | "fonts"> {
  if (!themeXml) return { scheme: {} };
  const doc = parseXml(themeXml);
  const fonts = path(doc, "a:theme", "a:themeElements", "a:fontScheme");
  return {
    scheme: readScheme(doc),
    fonts: {
      major: path(fonts, "a:majorFont", "a:latin")?.attrs.typeface || undefined,
      minor: path(fonts, "a:minorFont", "a:latin")?.attrs.typeface || undefined,
    },
  };
}

function readScheme(doc: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  const scheme = path(doc, "a:theme", "a:themeElements", "a:clrScheme");
  for (const c of scheme?.children ?? []) {
    const key = c.name.replace(/^a:/, "");
    const hex = resolveColor(c, { scheme: {}, map: {} });
    if (hex) out[key] = hex.slice(1);
  }
  return out;
}

/* ---------------------------------------------------------------- paragraphs */

/** A chain of paragraph-property sources, most specific first. */
type Chain = (XmlNode | undefined)[];

function lvlNode(listStyle: XmlNode | undefined, level: number) {
  return child(listStyle, `a:lvl${level + 1}pPr`);
}

function firstAttr(chain: Chain, name: string): string | undefined {
  for (const n of chain) {
    const v = n?.attrs[name];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function firstChild(chain: Chain, names: string[]): XmlNode | undefined {
  for (const n of chain) {
    if (!n) continue;
    const hit = n.children.find((c) => names.includes(c.name));
    if (hit) return hit;
  }
  return undefined;
}

function spacing(node: XmlNode | undefined): Spacing | undefined {
  if (!node) return undefined;
  const pct = child(node, "a:spcPct")?.attrs.val;
  const pts = child(node, "a:spcPts")?.attrs.val;
  if (pct !== undefined) {
    const v = pct.endsWith("%") ? parseFloat(pct) / 100 : parseInt(pct, 10) / 100000;
    return Number.isFinite(v) ? { pct: v } : undefined;
  }
  if (pts !== undefined) {
    const v = parseInt(pts, 10) / 100;
    return Number.isFinite(v) ? { pts: v } : undefined;
  }
  return undefined;
}

function bulletFrom(chain: Chain, ctx: ColorCtx): BulletInfo {
  const kind = firstChild(chain, ["a:buNone", "a:buChar", "a:buAutoNum", "a:buBlip"]);
  if (!kind || kind.name === "a:buNone") return { type: "none" };
  const clr = firstChild(chain, ["a:buClr", "a:buClrTx"]);
  const color = clr?.name === "a:buClr" ? resolveColor(clr, ctx) : undefined;
  const sz = firstChild(chain, ["a:buSzPct", "a:buSzPts", "a:buSzTx"]);
  const sizePct = sz?.name === "a:buSzPct" ? parseSizePct(sz.attrs.val) : undefined;
  const sizePt = sz?.name === "a:buSzPts" ? Number(sz.attrs.val) / 100 : undefined;
  const fontNode = firstChild(chain, ["a:buFont", "a:buFontTx"]);
  const font = fontNode?.name === "a:buFont" ? themeFont(fontNode.attrs.typeface, ctx) : undefined;
  if (kind.name === "a:buAutoNum") {
    return {
      type: "num",
      scheme: kind.attrs.type ?? "arabicPeriod",
      startAt: Math.max(1, parseInt(kind.attrs.startAt ?? "1", 10) || 1),
      font, color, sizePct, sizePt,
    };
  }
  if (kind.name === "a:buBlip") return { type: "char", char: "\u2022", color, sizePct, sizePt };
  return { type: "char", char: kind.attrs.char ?? "\u2022", font, color, sizePct, sizePt };
}

function parseSizePct(val: string | undefined) {
  if (!val) return undefined;
  const v = val.endsWith("%") ? parseFloat(val) / 100 : parseInt(val, 10) / 100000;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

interface Inherit {
  /** Placeholder list styles from the layout and master (lstStyle nodes). */
  layoutLst?: XmlNode;
  masterLst?: XmlNode;
  /** The master text style that applies: titleStyle, bodyStyle or otherStyle. */
  masterStyle?: XmlNode;
  defaultStyle?: XmlNode;
}

export function paragraphsOf(txBody: XmlNode | undefined, inh: Inherit, ctx: ColorCtx): ParaInfo[] {
  if (!txBody) return [];
  const ownLst = child(txBody, "a:lstStyle");
  return children(txBody, "a:p").map((p) => {
    const pPr = child(p, "a:pPr");
    const level = Math.min(8, Math.max(0, parseInt(pPr?.attrs.lvl ?? "0", 10) || 0));
    const chain: Chain = [
      pPr,
      lvlNode(ownLst, level),
      lvlNode(inh.layoutLst, level),
      lvlNode(inh.masterLst, level),
      lvlNode(inh.masterStyle, level),
      lvlNode(inh.defaultStyle, level),
    ];
    const emu = (name: string) => {
      const v = firstAttr(chain, name);
      const n = v === undefined ? 0 : parseInt(v, 10);
      return Number.isFinite(n) ? n / EMU_PER_PT : 0;
    };
    const defRPrChain = chain.map((n) => child(n, "a:defRPr"));
    const defSzRaw = firstAttr(defRPrChain, "sz");
    const runs = [...children(p, "a:r"), ...children(p, "a:fld")];
    const endSz = child(p, "a:endParaRPr")?.attrs.sz;
    const noRunSize = runs.every((r) => !child(r, "a:rPr")?.attrs.sz) && (runs.length > 0 || !endSz);
    const colorKinds = ["a:solidFill", "a:gradFill", "a:noFill", "a:pattFill"];
    const noRunColor = runs.every((r) => !child(r, "a:rPr")?.children.some((c) => colorKinds.includes(c.name)));
    const defFill = firstChild(defRPrChain, ["a:solidFill"]);
    return {
      level,
      marL: emu("marL"),
      indent: emu("indent"),
      bullet: bulletFrom(chain, ctx),
      spcBef: spacing(firstChild(chain, ["a:spcBef"])),
      spcAft: spacing(firstChild(chain, ["a:spcAft"])),
      defSz: defSzRaw ? parseInt(defSzRaw, 10) / 100 : undefined,
      noRunSize,
      defColor: resolveColor(defFill, ctx),
      noRunColor,
      algn: firstAttr(chain, "algn"),
    };
  });
}

/* ---------------------------------------------------------------- slides */

const SHAPE_TAGS = new Set(["p:sp", "p:cxnSp", "p:pic", "p:graphicFrame", "p:grpSp", "mc:AlternateContent"]);

function nvPr(node: XmlNode): XmlNode | undefined {
  for (const k of ["p:nvSpPr", "p:nvPicPr", "p:nvCxnSpPr", "p:nvGrpSpPr", "p:nvGraphicFramePr"]) {
    const n = child(node, k);
    if (n) return n;
  }
  if (node.name === "mc:AlternateContent") {
    const alt = child(node, "mc:Choice") ?? child(node, "mc:Fallback");
    const inner = alt?.children.find((c) => SHAPE_TAGS.has(c.name));
    return inner ? nvPr(inner) : undefined;
  }
  return undefined;
}

export function shapeId(node: XmlNode): string | undefined {
  return child(nvPr(node), "p:cNvPr")?.attrs.id;
}

function placeholder(node: XmlNode) {
  const ph = path(nvPr(node), "p:nvPr", "p:ph");
  if (!ph) return undefined;
  return { type: ph.attrs.type ?? "obj", idx: ph.attrs.idx };
}

function spTree(doc: XmlNode, root: string) {
  return path(doc, root, "p:cSld", "p:spTree");
}

function topShapes(tree: XmlNode | undefined) {
  return (tree?.children ?? []).filter((c) => SHAPE_TAGS.has(c.name));
}

function findPlaceholder(tree: XmlNode | undefined, type: string, idx: string | undefined) {
  const phs = topShapes(tree).map((n) => ({ n, ph: placeholder(n) })).filter((x) => x.ph);
  if (idx !== undefined) {
    const byIdx = phs.find((x) => x.ph!.idx === idx);
    if (byIdx) return byIdx.n;
  }
  const want = type === "ctrTitle" ? ["ctrTitle", "title"] : type === "subTitle" ? ["subTitle", "body"] : [type];
  for (const t of want) {
    const hit = phs.find((x) => x.ph!.type === t);
    if (hit) return hit.n;
  }
  if (type === "obj") return phs.find((x) => x.ph!.type === "body")?.n;
  return undefined;
}

function masterPlaceholder(tree: XmlNode | undefined, type: string) {
  const t = type === "ctrTitle" ? "title" : type === "subTitle" || type === "obj" ? "body" : type;
  return topShapes(tree).find((n) => placeholder(n)?.type === t);
}

function styleFor(phType: string | undefined, txStyles: XmlNode | undefined) {
  if (!phType) return child(txStyles, "p:otherStyle");
  if (phType === "title" || phType === "ctrTitle") return child(txStyles, "p:titleStyle");
  if (["body", "subTitle", "obj"].includes(phType)) return child(txStyles, "p:bodyStyle");
  return child(txStyles, "p:otherStyle");
}

function nonPlaceholderIds(tree: XmlNode | undefined) {
  return topShapes(tree)
    .filter((n) => !placeholder(n))
    .map(shapeId)
    .filter((id): id is string => !!id);
}

const partCache = new WeakMap<ReadPart, Map<string, Promise<XmlNode | null>>>();

function readParsed(read: ReadPart, part: string) {
  let cache = partCache.get(read);
  if (!cache) partCache.set(read, (cache = new Map()));
  let hit = cache.get(part);
  if (!hit) {
    hit = read(part).then((x) => (x ? parseXml(x) : null));
    cache.set(part, hit);
  }
  return hit;
}

export async function analyzeSlide(read: ReadPart, slidePath: string): Promise<SlideAnalysis> {
  const doc = await readParsed(read, slidePath);
  const empty: SlideAnalysis = {
    path: slidePath, hidden: false, shapes: {}, lineColors: {}, tables: {}, zOrder: {}, layoutIds: [], masterIds: [],
  };
  if (!doc) return empty;

  const rels = await readRels(read, slidePath);
  const layoutPath = rels.find((r) => r.type === "slideLayout")?.target;
  const layoutDoc = layoutPath ? await readParsed(read, layoutPath) : null;
  const masterPath = layoutPath
    ? (await readRels(read, layoutPath)).find((r) => r.type === "slideMaster")?.target
    : undefined;
  const masterDoc = masterPath ? await readParsed(read, masterPath) : null;
  const themePath = masterPath
    ? (await readRels(read, masterPath)).find((r) => r.type === "theme")?.target
    : undefined;
  const presDoc = await readParsed(read, "ppt/presentation.xml");

  const master = child(masterDoc, "p:sldMaster");
  const clrMap = child(master, "p:clrMap")?.attrs ?? {};
  const layoutOverride = path(layoutDoc, "p:sldLayout", "p:clrMapOvr", "a:overrideClrMapping")?.attrs;
  const ctx: ColorCtx = {
    ...readTheme(themePath ? await read(themePath) : null),
    map: { ...clrMap, ...(layoutOverride ?? {}) },
  };

  const layoutTree = spTree(layoutDoc!, "p:sldLayout");
  const masterTree = spTree(masterDoc!, "p:sldMaster");
  const txStyles = child(master, "p:txStyles");
  const defaultStyle = path(presDoc, "p:presentation", "p:defaultTextStyle");

  const sld = child(doc, "p:sld");
  const hlink = ctx.scheme[ctx.map.hlink ?? "hlink"];
  const out: SlideAnalysis = {
    ...empty,
    hidden: sld?.attrs.show === "0",
    linkColor: hlink ? `#${hlink}` : undefined,
    layoutIds: layoutDoc ? nonPlaceholderIds(layoutTree) : [],
    masterIds:
      masterDoc && path(layoutDoc, "p:sldLayout")?.attrs.showMasterSp !== "0" ? nonPlaceholderIds(masterTree) : [],
  };

  let z = 0;
  const visit = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      const id = shapeId(node);
      if (id && out.zOrder[id] === undefined) out.zOrder[id] = z++;
      if (node.name === "p:grpSp") {
        visit(node.children.filter((c) => SHAPE_TAGS.has(c.name)));
        continue;
      }
      if (node.name === "mc:AlternateContent") {
        const fb = child(node, "mc:Fallback") ?? child(node, "mc:Choice");
        const grp = child(fb, "p:grpSp");
        if (grp) visit(grp.children.filter((c) => SHAPE_TAGS.has(c.name)));
        continue;
      }
      if (!id) continue;
      if (node.name === "p:graphicFrame") {
        const tblPr = path(node, "a:graphic", "a:graphicData", "a:tbl", "a:tblPr");
        if (tblPr) {
          const on = (k: string) => tblPr.attrs[k] === "1" || tblPr.attrs[k] === "true";
          out.tables[id] = {
            styleId: child(tblPr, "a:tableStyleId")?.text.trim() || undefined,
            firstRow: on("firstRow"), lastRow: on("lastRow"), firstCol: on("firstCol"),
            lastCol: on("lastCol"), bandRow: on("bandRow"), bandCol: on("bandCol"),
          };
        }
        continue;
      }
      if (node.name === "p:sp" || node.name === "p:cxnSp") {
        const ln = path(node, "p:spPr", "a:ln");
        const explicit = ln?.children.some((c) => ["a:noFill", "a:solidFill", "a:gradFill", "a:pattFill"].includes(c.name));
        const lnRef = path(node, "p:style", "a:lnRef");
        if (!explicit && lnRef && lnRef.attrs.idx !== "0") {
          const color = resolveColor(lnRef, ctx);
          if (color) out.lineColors[id] = color;
        }
      }
      if (node.name !== "p:sp") continue;
      const ph = placeholder(node);
      const layoutPh = ph ? findPlaceholder(layoutTree, ph.type, ph.idx) : undefined;
      const layoutPhInfo = layoutPh ? placeholder(layoutPh) : undefined;
      const masterPh = ph ? masterPlaceholder(masterTree, layoutPhInfo?.type ?? ph.type) : undefined;
      const phType = ph ? (ph.type === "obj" && layoutPhInfo ? layoutPhInfo.type : ph.type) : undefined;
      const anchor = ph
        ? [node, layoutPh, masterPh].map((n) => path(n, "p:txBody", "a:bodyPr")?.attrs.anchor).find(Boolean) ?? "t"
        : undefined;
      out.shapes[id] = {
        phType,
        anchor,
        paragraphs: paragraphsOf(
          child(node, "p:txBody"),
          {
            layoutLst: path(layoutPh, "p:txBody", "a:lstStyle"),
            masterLst: path(masterPh, "p:txBody", "a:lstStyle"),
            masterStyle: styleFor(phType, txStyles),
            defaultStyle,
          },
          ctx
        ),
      };
    }
  };
  visit(topShapes(spTree(doc, "p:sld")));
  return out;
}

/* ---------------------------------------------------------------- numbering */

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function roman(n: number) {
  let s = "";
  for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
  return s;
}

function alpha(n: number) {
  let s = "";
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/** Formats an auto-number label, e.g. ("alphaLcParenR", 3) -> "c)". */
export function autoNumberLabel(scheme: string, n: number): string {
  const m = /^(arabic|romanUc|romanLc|alphaUc|alphaLc)(.*)$/.exec(scheme);
  const base = m?.[1] ?? "arabic";
  const suffix = m?.[2] ?? "Period";
  let v = String(n);
  if (base === "romanUc") v = roman(n).toUpperCase();
  else if (base === "romanLc") v = roman(n);
  else if (base === "alphaUc") v = alpha(n).toUpperCase();
  else if (base === "alphaLc") v = alpha(n);
  if (suffix.startsWith("ParenBoth")) return `(${v})`;
  if (suffix.startsWith("ParenR")) return `${v})`;
  if (suffix.startsWith("Plain")) return v;
  if (suffix.startsWith("Minus")) return `- ${v}`;
  return `${v}.`;
}

/** Numbers for each paragraph (undefined when it is not auto-numbered). */
export function numberParagraphs(paras: ParaInfo[]): (number | undefined)[] {
  const counters: (number | undefined)[] = [];
  const schemes: (string | undefined)[] = [];
  return paras.map((p) => {
    counters.length = Math.min(counters.length, p.level + 1);
    schemes.length = Math.min(schemes.length, p.level + 1);
    if (p.bullet.type !== "num") {
      counters[p.level] = undefined;
      schemes[p.level] = undefined;
      return undefined;
    }
    const cur = counters[p.level];
    const next = cur !== undefined && schemes[p.level] === p.bullet.scheme ? cur + 1 : p.bullet.startAt;
    counters[p.level] = next;
    schemes[p.level] = p.bullet.scheme;
    return next;
  });
}

/* ---------------------------------------------------------------- symbol fonts */

/** Common Wingdings/Symbol bullet code points and their Unicode look-alikes. */
const SYMBOL_BULLETS: Record<string, Record<string, string>> = {
  wingdings: {
    "§": "\u25AA", l: "\u25CF", n: "\u25A0", q: "\u274F", u: "\u25C6", v: "\u2756",
    "Ø": "\u27A2", "ü": "\u2714", "Ü": "\u2714", "à": "\u2192", "è": "\u2794", "o": "\u25A1", "¨": "\u25FB",
    "\uF0A7": "\u25AA", "\uF06C": "\u25CF", "\uF06E": "\u25A0", "\uF0D8": "\u27A2", "\uF0FC": "\u2714",
  },
  symbol: { "·": "\u2022", "\uF0B7": "\u2022", "Þ": "\u21D2", "®": "\u2192" },
};

export function bulletChar(char: string, font?: string): string {
  const f = font?.toLowerCase() ?? "";
  const table = f.startsWith("wingdings") ? SYMBOL_BULLETS.wingdings : f === "symbol" ? SYMBOL_BULLETS.symbol : null;
  if (table && table[char]) return table[char];
  // Private-use code points only render with the symbol font; fall back to a dot.
  if (/[\uE000-\uF8FF]/.test(char)) return "\u2022";
  return char;
}
