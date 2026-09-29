/**
 * Allowlist sanitizer for the text HTML pptxtojson builds from a .pptx.
 *
 * That HTML comes from an untrusted file and is assembled by string
 * concatenation: run text is not escaped when it arrives as CDATA, and
 * attribute values such as font names and link targets are pasted straight
 * into style="..." and href="...", so a crafted file can inject elements and
 * event handlers. Everything is parsed into an inert <template> (no scripts
 * run, no images load), rebuilt from an allowlist of formatting elements and
 * safe inline style properties, and serialised again.
 *
 * `sanitizeStyle` and `safeHref` are pure and unit-tested under Node; the DOM
 * part is tested in the browser.
 */

/** Elements kept (attributes are still filtered). */
const ALLOWED_TAGS = new Set([
  "p", "span", "br", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "a",
  "ul", "ol", "li", "div",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col",
]);

/** Elements removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript",
  "template", "svg", "math", "link", "meta", "base", "title", "head", "form", "input",
  "button", "textarea", "select", "option", "img", "picture", "video", "audio", "source",
  "track", "canvas", "portal", "noembed", "noframes", "xmp", "plaintext", "dialog",
]);

const ALLOWED_PROPS = new Set([
  "color", "background-color", "font-size", "font-family", "font-weight", "font-style",
  "font-variant", "text-decoration", "text-decoration-line", "text-decoration-color",
  "text-decoration-style", "text-align", "line-height", "letter-spacing", "word-spacing",
  "vertical-align", "text-indent", "text-transform", "text-shadow", "white-space",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "list-style", "list-style-type", "list-style-position",
  // Gradient-filled text: a gradient background clipped to the glyphs.
  "background", "background-image", "background-clip", "-webkit-background-clip",
]);

/** Anything that can fetch, execute, or escape the declaration. */
const UNSAFE_VALUE =
  /url\s*\(|image\s*\(|image-set\s*\(|cross-fade\s*\(|element\s*\(|expression\s*\(|attr\s*\(|var\s*\(|env\s*\(|javascript:|vbscript:|data:|@import|behavior|binding|[\\<>{}]|\/\*/i;

const MAX_STYLE = 4000;

/** Splits "a: b; c: d" into declarations, ignoring ";" inside quotes or parens. */
function declarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Keeps only allowlisted properties with harmless values.
 * `mapValue` can rewrite a kept value (e.g. font-family -> a fallback stack).
 */
export function sanitizeStyle(
  style: string | null | undefined,
  mapValue?: (prop: string, value: string) => string | null
): string {
  if (!style) return "";
  // Control characters are never needed; removing them re-joins split keywords
  // ("java\u0000script:") so the checks below see them.
  const src = style.slice(0, MAX_STYLE).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[\t\n\r]/g, " ");
  const kept: string[] = [];
  for (const decl of declarations(src)) {
    const colon = decl.indexOf(":");
    if (colon < 1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    let value = decl.slice(colon + 1).trim().replace(/\s*!important$/i, "");
    if (!ALLOWED_PROPS.has(prop) || !value || UNSAFE_VALUE.test(value)) continue;
    // Unbalanced quotes or parentheses mean someone is trying to break out.
    if ((value.match(/"/g)?.length ?? 0) % 2 || (value.match(/'/g)?.length ?? 0) % 2) continue;
    if ((value.match(/\(/g)?.length ?? 0) !== (value.match(/\)/g)?.length ?? 0)) continue;
    if (prop.startsWith("background") && prop !== "background-color" && !/^(text|(linear|radial|conic)-gradient\()/i.test(value)) continue;
    if (prop.endsWith("background-clip") && value.toLowerCase() !== "text") continue;
    if (mapValue) {
      const mapped = mapValue(prop, value);
      if (mapped === null) continue;
      value = mapped;
    }
    kept.push(`${prop}: ${value}`);
  }
  return kept.join("; ");
}

/** http(s), mailto and in-document links only. Returns null for anything else. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.replace(/[\u0000- \u007F-\u009F]/g, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return href.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return href.trim();
  return null;
}

/**
 * pptxtojson copies colour values from the file verbatim ("#" + srgbClr val).
 * They end up in multi-value CSS (gradients, drop-shadow), where a
 * crafted value could close the function and add url(...) layers, so only
 * plain colour syntax gets through.
 */
export function safeCssColor(c: unknown, fallback = "transparent"): string {
  if (typeof c !== "string") return fallback;
  const v = c.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^[a-z]{3,20}$/i.test(v) || /^(rgb|hsl)a?\([\d\s.,%/+-]*\)$/i.test(v)) return v;
  return fallback;
}

export interface SanitizeOptions {
  mapStyleValue?: (prop: string, value: string) => string | null;
}

function cleanChildren(src: Node, dest: Node, doc: Document, opts: SanitizeOptions) {
  for (const node of Array.from(src.childNodes)) {
    if (node.nodeType === 3) {
      dest.appendChild(doc.createTextNode(node.nodeValue ?? ""));
      continue;
    }
    if (node.nodeType !== 1) continue; // comments, processing instructions, CDATA
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    // Anything namespaced or foreign is dropped outright.
    if (el.namespaceURI && el.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrappers are unwrapped: their text is kept, the element is not.
      cleanChildren(el, dest, doc, opts);
      continue;
    }
    const out = doc.createElement(tag);
    const style = sanitizeStyle(el.getAttribute("style"), opts.mapStyleValue);
    if (style) out.setAttribute("style", style);
    if (tag === "a") {
      const href = safeHref(el.getAttribute("href"));
      if (href) {
        out.setAttribute("href", href);
        out.setAttribute("target", "_blank");
        out.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
    if (tag === "td" || tag === "th" || tag === "col" || tag === "colgroup") {
      for (const attr of ["colspan", "rowspan", "span"]) {
        const v = el.getAttribute(attr);
        if (v && /^\d{1,3}$/.test(v)) out.setAttribute(attr, String(Math.min(Number(v), 1000)));
      }
    }
    cleanChildren(el, out, doc, opts);
    dest.appendChild(out);
  }
}

/** Returns a sanitized fragment built in `doc` (default: the current document). */
export function sanitizeToFragment(html: string, opts: SanitizeOptions = {}, doc: Document = document): DocumentFragment {
  // <template> content lives in an inert document: nothing executes or loads.
  const template = doc.createElement("template");
  template.innerHTML = html;
  const out = doc.createDocumentFragment();
  cleanChildren(template.content, out, doc, opts);
  return out;
}

/** Sanitized HTML string, safe for dangerouslySetInnerHTML. */
export function sanitizeHtml(html: string, opts: SanitizeOptions = {}, doc: Document = document): string {
  const holder = doc.createElement("div");
  holder.appendChild(sanitizeToFragment(html, opts, doc));
  return holder.innerHTML;
}
