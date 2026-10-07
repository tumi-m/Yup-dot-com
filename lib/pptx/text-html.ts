import { mapFontFamily, fontStack } from "./fonts";
import { bulletChar, autoNumberLabel, numberParagraphs, type ParaInfo, type RunInfo } from "./ooxml";
import { sanitizeToFragment } from "./sanitize";

/**
 * Turns pptxtojson's text HTML into safe, faithful slide text (browser only).
 *
 * Slides are laid out in points with 1pt drawn as 1 CSS px and the whole slide
 * scaled afterwards, so every "pt" length becomes "px". On top of sanitising:
 * - bullets, numbering, indents and paragraph spacing come from the XML
 *   (see ./ooxml), replacing pptxtojson's lists;
 * - normAutofit's font scale shrinks text the way PowerPoint stored it;
 * - pptxtojson joins words with &nbsp;, which would stop lines from wrapping,
 *   so they become ordinary spaces under white-space: pre-wrap.
 */

export interface TextOptions {
  paragraphs?: ParaInfo[];
  /** normAutofit fontScale in percent (e.g. 85). */
  fontScale?: number;
  phType?: string;
  /** Theme hyperlink colour; links are underlined in it, like PowerPoint. */
  linkColor?: string;
  doc?: Document;
}

const ALIGN: Record<string, string> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" };

/** PowerPoint's single line spacing is ~1.2x the font size. */
export const LINE = 1.2;

function scaleLength(value: string, factor: number) {
  return value.replace(/(-?\d*\.?\d+)pt\b/g, (_, n: string) => `${+(Number(n) * factor).toFixed(3)}px`);
}

function pxOf(el: HTMLElement): number | null {
  const m = /(-?\d*\.?\d+)px/.exec(el.style.fontSize);
  return m ? Number(m[1]) : null;
}

export function prepareTextHtml(html: string, opts: TextOptions = {}): string {
  const doc = opts.doc ?? document;
  const scale = opts.fontScale && opts.fontScale > 0 && opts.fontScale < 100 ? opts.fontScale / 100 : 1;

  const frag = sanitizeToFragment(
    html,
    {
      mapStyleValue(prop, value) {
        if (prop === "font-family") return mapFontFamily(value);
        if (prop === "font-size") return scaleLength(value, scale);
        // pptxtojson writes spcPct as val/1000 em, i.e. 100x too large.
        if ((prop === "margin-top" || prop === "margin-bottom") && /^-?\d*\.?\d+em$/.test(value)) {
          return `${+((parseFloat(value) / 100) * LINE).toFixed(3)}em`;
        }
        return scaleLength(value, 1);
      },
    },
    doc
  );

  const root = doc.createElement("div");
  root.appendChild(frag);

  // Plain spaces so lines wrap; pre-wrap keeps runs of spaces and tabs.
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t.nodeValue?.includes(" ")) t.nodeValue = t.nodeValue.replace(/ /g, " ");
  }

  const paras = Array.from(root.querySelectorAll("p")) as HTMLElement[];
  const info = opts.paragraphs && opts.paragraphs.length === paras.length ? opts.paragraphs : null;
  const numbers = info ? numberParagraphs(info) : [];

  paras.forEach((p, i) => {
    const pi = info?.[i];
    if (pi?.runs) applyRunStyles(p, pi.runs, doc);
    const spans = Array.from(p.querySelectorAll("span")) as HTMLElement[];

    // Placeholders: pptxtojson can inherit size and colour from the wrong
    // master placeholder (and sizes subtitles from the title style), so runs
    // that don't set their own take the values resolved in ./ooxml.
    if (pi && opts.phType) {
      if (pi.noRunSize && pi.defSz) for (const s of spans) s.style.fontSize = `${+(pi.defSz * scale).toFixed(3)}px`;
      if (pi.noRunColor && pi.defColor) for (const s of spans) s.style.color = pi.defColor;
    }
    const align = pi?.algn ? ALIGN[pi.algn] : undefined;
    if (align && !p.style.textAlign.startsWith(align)) p.style.textAlign = align;

    // Superscript and subscript are drawn smaller, as in PowerPoint.
    for (const s of spans) {
      const va = s.style.verticalAlign;
      const px = pxOf(s);
      if ((va === "super" || va === "sub") && px) {
        s.style.fontSize = `${+((px * 2) / 3).toFixed(3)}px`;
        s.style.lineHeight = "0";
      }
    }
    const sizes = spans.filter((s) => !s.style.verticalAlign).map(pxOf).filter((n): n is number => n !== null);
    const size = sizes.length ? Math.max(...sizes) : 18 * scale;
    // The paragraph's own size sets the height of its line box (and empty lines).
    p.style.fontSize = `${size}px`;
    p.style.marginTop = p.style.marginTop || "0";
    p.style.marginBottom = p.style.marginBottom || "0";
    p.style.marginRight = "0";
    if (!p.style.marginLeft) p.style.marginLeft = "0";
    if (!pi) return;

    const spacing = (s: ParaInfo["spcBef"]) =>
      s?.pct !== undefined ? `${+(s.pct * LINE * size).toFixed(3)}px` : s?.pts !== undefined ? `${+(s.pts * scale).toFixed(3)}px` : "0";
    // PowerPoint ignores space before the first paragraph of a text box.
    p.style.marginTop = i === 0 ? "0" : spacing(pi.spcBef);
    p.style.marginBottom = spacing(pi.spcAft);
    if (pi.rtl) {
      // The margin and indent are on the paragraph's start side.
      p.setAttribute("dir", "rtl");
      p.style.marginLeft = "0";
      p.style.marginRight = `${pi.marL}px`;
    } else p.style.marginLeft = `${pi.marL}px`;
    p.style.textIndent = `${pi.indent}px`;

    const empty = !(p.textContent ?? "").trim();
    if (pi.bullet.type === "none" || empty) return;
    const first = spans[0];
    const b = pi.bullet;
    const label =
      b.type === "num" ? autoNumberLabel(b.scheme, numbers[i] ?? b.startAt) : bulletChar(b.char, b.font);
    const bullet = doc.createElement("span");
    bullet.setAttribute("aria-hidden", "true");
    bullet.setAttribute("data-bullet", "");
    bullet.textContent = label;
    const firstSize = (first && pxOf(first)) || size;
    const bSize = b.sizePt ? b.sizePt * scale : firstSize * (b.sizePct ?? 1);
    const symbolFont = /^(wingdings|symbol|webdings)/i.test(b.font ?? "");
    // One property at a time: values that come from the file (the bullet font
    // name) can then never spill into other declarations.
    const bs = bullet.style;
    bs.setProperty("display", "inline-block");
    bs.setProperty("text-indent", "0");
    bs.setProperty("white-space", "nowrap");
    bs.setProperty("font-size", `${+bSize.toFixed(3)}px`);
    bs.setProperty("color", b.color ?? (first?.style.color || "inherit"));
    bs.setProperty("font-family", b.font && !symbolFont ? fontStack(b.font) : first?.style.fontFamily || "inherit");
    if (b.type === "num") bs.setProperty("font-weight", first?.style.fontWeight || "inherit");
    if (pi.indent < 0) bs.setProperty("min-width", `${-pi.indent}px`);
    else bs.setProperty(pi.rtl ? "padding-left" : "padding-right", "0.4em");
    p.insertBefore(bullet, p.firstChild);
  });

  for (const a of Array.from(root.querySelectorAll("a")) as HTMLElement[]) {
    a.style.color = opts.linkColor ?? "#0563C1";
    a.style.textDecoration = "underline";
    // Slide text is a picture of the slide, never clicked through: without an
    // href the link can't take keyboard focus inside hidden thumbnails or
    // selectable (role=button) shapes.
    a.removeAttribute("href");
    a.removeAttribute("target");
    a.removeAttribute("rel");
  }

  // With paragraph info the bullets are ours: flatten pptxtojson's lists.
  if (info) {
    for (const list of Array.from(root.querySelectorAll("li, ul, ol")).reverse()) {
      list.replaceWith(...Array.from(list.childNodes));
    }
  } else {
    for (const list of Array.from(root.querySelectorAll("ul, ol")) as HTMLElement[]) {
      list.style.margin = "0";
      list.style.paddingLeft = "1.3em";
      list.style.listStyleType = list.tagName === "OL" ? "decimal" : "disc";
    }
  }
  return root.innerHTML;
}

/**
 * Applies capitals and highlight from the XML runs by character position
 * (pptxtojson merges runs and puts fields last, so its spans don't line up
 * with runs one to one). Skipped when the texts don't match.
 */
function applyRunStyles(p: HTMLElement, runs: RunInfo[], doc: Document) {
  const norm = (t: string) => t.replace(/\u00a0/g, " ");
  const want = runs.map((r) => r.text).join("");
  if (norm(p.textContent ?? "") !== norm(want)) return;
  const bounds: { end: number; run: RunInfo }[] = [];
  let at = 0;
  for (const run of runs) bounds.push({ end: (at += run.text.length), run });
  const walker = doc.createTreeWalker(p, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) nodes.push(t as Text);
  let pos = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const start = pos;
    pos += text.length;
    const parts: { text: string; run: RunInfo }[] = [];
    let k = start;
    while (k < pos) {
      const b = bounds.find((x) => x.end > k);
      if (!b) break;
      const end = Math.min(pos, b.end);
      parts.push({ text: text.slice(k - start, end - start), run: b.run });
      k = end;
    }
    if (!parts.some((x) => x.run.cap || x.run.highlight)) continue;
    const frag = doc.createDocumentFragment();
    for (const part of parts) {
      if (!part.run.cap && !part.run.highlight) {
        frag.appendChild(doc.createTextNode(part.text));
        continue;
      }
      const span = doc.createElement("span");
      if (part.run.cap === "all") span.style.textTransform = "uppercase";
      if (part.run.cap === "small") span.style.fontVariant = "small-caps";
      if (part.run.highlight) span.style.backgroundColor = part.run.highlight;
      span.textContent = part.text;
      frag.appendChild(span);
    }
    node.replaceWith(frag);
  }
}

/** Sanitised table-cell HTML (no paragraph metadata for cells). */
export function prepareCellHtml(html: string, doc?: Document): string {
  return prepareTextHtml(html, { doc });
}
