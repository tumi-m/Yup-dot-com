/**
 * Namespace-aware, editable XML tree used to change PPTX parts losslessly.
 * (lib/pptx/xml.ts is the lighter read-only parser used for rendering.)
 *
 * Minimal, lossless XML tree for OOXML parts.
 *
 * Browsers have DOMParser/XMLSerializer but Node does not, and no XML DOM
 * library is a direct dependency, so this module provides a small tokenizer
 * + tree that works in both. Design goals:
 *
 *  - Round-trip exactness: an unmodified tree serializes to the exact input
 *    string (start tags, end tags, text, comments, PIs and CDATA keep their
 *    raw source). Only nodes that were changed are re-emitted.
 *  - Namespace awareness: every element knows its namespace URI (resolved
 *    from in-scope xmlns declarations), so lookups never depend on the
 *    conventional "p:"/"a:" prefixes.
 *  - No DTD support: a DOCTYPE is rejected (OOXML forbids it; this also rules
 *    out entity-expansion attacks).
 */

export type XmlNode = XmlElement | XmlText | XmlRaw;

export interface XmlText {
  type: "text";
  /** Escaped source text (entities left as written). */
  raw: string;
}

export interface XmlRaw {
  /** Comment, processing instruction or CDATA section, kept verbatim. */
  type: "raw";
  raw: string;
}

export interface XmlAttr {
  name: string;
  /** Escaped attribute value as written in source (without quotes). */
  raw: string;
  quote: '"' | "'";
}

export interface XmlElement {
  type: "element";
  /** Qualified name as written, e.g. "p:sldId". */
  name: string;
  attrs: XmlAttr[];
  children: XmlNode[];
  parent: XmlElement | null;
  /** Namespace URI of the element ("" when unqualified and no default ns). */
  ns: string;
  /** Original start tag, reused while the attributes are unchanged. */
  rawOpen: string | null;
  /** Original end tag ("" when the element was self-closing in source). */
  rawClose: string | null;
}

export interface XmlDocument {
  /** Everything before the root element (XML declaration, comments, whitespace). */
  prolog: string;
  root: XmlElement;
  /** Everything after the root element. */
  epilog: string;
}

const XMLNS = "http://www.w3.org/2000/xmlns/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i < 0 ? qname : qname.slice(i + 1);
}

export function prefixOf(qname: string): string {
  const i = qname.indexOf(":");
  return i < 0 ? "" : qname.slice(0, i);
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
  if (raw.indexOf("&") < 0) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? m;
  });
}

/** Removes characters that are not allowed in XML 1.0 documents (incl. lone surrogates). */
export function stripInvalidXmlChars(s: string): string {
  let out = "";
  let clean = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let ok: boolean;
    let width = 1;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      ok = d >= 0xdc00 && d <= 0xdfff;
      if (ok) width = 2;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      ok = false;
    } else {
      ok = c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xfffd);
    }
    if (ok) {
      if (!clean) out += s.slice(i, i + width);
    } else if (clean) {
      clean = false;
      out = s.slice(0, i);
    }
    i += width - 1;
  }
  return clean ? s : out;
}

export function escapeText(s: string): string {
  return stripInvalidXmlChars(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return stripInvalidXmlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export class XmlParseError extends Error {}

function isNameChar(c: number): boolean {
  // Loose: anything that is not whitespace, '/', '>', '=', quotes or '<'.
  return !(c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2f || c === 0x3e || c === 0x3d || c === 0x22 || c === 0x27 || c === 0x3c);
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

export function parseXml(src: string): XmlDocument {
  const n = src.length;
  let i = 0;
  let root: XmlElement | null = null;
  let prolog = "";
  let rootEnd = -1;
  const stack: XmlElement[] = [];
  // Namespace scopes parallel to `stack`: prefix -> uri.
  const scopes: Map<string, string>[] = [new Map([["xml", XML_NS], ["xmlns", XMLNS]])];

  const lookup = (prefix: string): string | undefined => {
    for (let k = scopes.length - 1; k >= 0; k--) {
      const v = scopes[k].get(prefix);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const append = (node: XmlNode) => {
    const top = stack[stack.length - 1];
    if (top) {
      top.children.push(node);
      return true;
    }
    return false;
  };

  const outsideRoot = (start: number, end: number, markup = false) => {
    const chunk = src.slice(start, end);
    if (!markup && /\S/.test(chunk.replace(/^\uFEFF/, ""))) throw new XmlParseError("Text outside the root element");
    // Epilog is taken verbatim from the source once the root closes.
    if (root === null) prolog += chunk;
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (stack.length) throw new XmlParseError("Unexpected end of document");
      outsideRoot(i, n);
      i = n;
      break;
    }
    if (lt > i) {
      if (stack.length) append({ type: "text", raw: src.slice(i, lt) });
      else outsideRoot(i, lt);
    }
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) throw new XmlParseError("Unterminated comment");
      const raw = src.slice(i, end + 3);
      if (!append({ type: "raw", raw })) outsideRoot(i, end + 3, true);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) throw new XmlParseError("Unterminated CDATA");
      if (!stack.length) throw new XmlParseError("CDATA outside the root element");
      append({ type: "raw", raw: src.slice(i, end + 3) });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", i)) throw new XmlParseError("DOCTYPE / declarations are not supported");
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) throw new XmlParseError("Unterminated processing instruction");
      const raw = src.slice(i, end + 2);
      if (!append({ type: "raw", raw })) outsideRoot(i, end + 2, true);
      i = end + 2;
      continue;
    }
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i + 2);
      if (end < 0) throw new XmlParseError("Unterminated end tag");
      const name = src.slice(i + 2, end).trim();
      const top = stack.pop();
      scopes.pop();
      if (!top || top.name !== name) throw new XmlParseError(`Mismatched end tag </${name}>`);
      top.rawClose = src.slice(i, end + 1);
      i = end + 1;
      if (!stack.length) rootEnd = i;
      continue;
    }
    // Start tag.
    const start = i;
    i++;
    let j = i;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const name = src.slice(i, j);
    if (!name) throw new XmlParseError("Empty element name");
    i = j;
    const attrs: XmlAttr[] = [];
    let selfClosing = false;
    for (;;) {
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      if (i >= n) throw new XmlParseError("Unterminated start tag");
      const c = src.charCodeAt(i);
      if (c === 0x3e) {
        i++;
        break;
      }
      if (c === 0x2f) {
        if (src.charCodeAt(i + 1) !== 0x3e) throw new XmlParseError("Malformed start tag");
        selfClosing = true;
        i += 2;
        break;
      }
      let k = i;
      while (k < n && isNameChar(src.charCodeAt(k))) k++;
      const an = src.slice(i, k);
      if (!an) throw new XmlParseError("Malformed attribute");
      i = k;
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      if (src[i] !== "=") throw new XmlParseError(`Attribute ${an} without value`);
      i++;
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") throw new XmlParseError(`Unquoted attribute ${an}`);
      const vEnd = src.indexOf(q, i + 1);
      if (vEnd < 0) throw new XmlParseError("Unterminated attribute value");
      attrs.push({ name: an, raw: src.slice(i + 1, vEnd), quote: q });
      i = vEnd + 1;
    }
    const scope = new Map<string, string>();
    for (const a of attrs) {
      if (a.name === "xmlns") scope.set("", decodeEntities(a.raw));
      else if (a.name.startsWith("xmlns:")) scope.set(a.name.slice(6), decodeEntities(a.raw));
    }
    scopes.push(scope);
    const pfx = prefixOf(name);
    const ns = lookup(pfx) ?? "";
    if (pfx && ns === "") throw new XmlParseError(`Unbound namespace prefix "${pfx}"`);
    const parent = stack[stack.length - 1] ?? null;
    const el: XmlElement = {
      type: "element",
      name,
      attrs,
      children: [],
      parent,
      ns,
      rawOpen: src.slice(start, i),
      rawClose: selfClosing ? "" : null,
    };
    if (parent) parent.children.push(el);
    else {
      if (root) throw new XmlParseError("Multiple root elements");
      root = el;
    }
    if (selfClosing) {
      scopes.pop();
      if (!parent) rootEnd = i;
    } else {
      stack.push(el);
    }
  }
  if (stack.length) throw new XmlParseError("Unclosed elements");
  if (!root) throw new XmlParseError("No root element");
  return { prolog, root, epilog: rootEnd >= 0 ? src.slice(rootEnd) : "" };
}

/* ------------------------------------------------------------------ */
/* Serializer                                                          */
/* ------------------------------------------------------------------ */

function openTag(el: XmlElement, selfClose: boolean): string {
  let s = "<" + el.name;
  for (const a of el.attrs) {
    const v = a.quote === "'" ? a.raw : a.raw.replace(/"/g, "&quot;");
    s += " " + a.name + "=" + (a.quote === "'" ? "'" + v + "'" : '"' + v + '"');
  }
  return s + (selfClose ? "/>" : ">");
}

function writeEl(el: XmlElement, out: string[]): void {
  const empty = el.children.length === 0;
  if (el.rawOpen !== null) {
    const wasSelfClosing = el.rawClose === "";
    if (empty && wasSelfClosing) {
      out.push(el.rawOpen);
      return;
    }
    if (!wasSelfClosing) out.push(el.rawOpen);
    else out.push(el.rawOpen.replace(/\s*\/>$/, ">"));
  } else {
    if (empty) {
      out.push(openTag(el, true));
      return;
    }
    out.push(openTag(el, false));
  }
  for (const c of el.children) {
    if (c.type === "element") writeEl(c, out);
    else out.push(c.raw);
  }
  out.push(el.rawClose ? el.rawClose : "</" + el.name + ">");
}

export function serializeXml(doc: XmlDocument): string {
  const out: string[] = [doc.prolog];
  writeEl(doc.root, out);
  out.push(doc.epilog);
  return out.join("");
}

export function serializeElement(el: XmlElement): string {
  const out: string[] = [];
  writeEl(el, out);
  return out.join("");
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

export function elementChildren(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.type === "element");
}

export function isEl(node: XmlNode | null | undefined, ns: string, local: string): node is XmlElement {
  return !!node && node.type === "element" && node.ns === ns && localName(node.name) === local;
}

export function child(el: XmlElement, ns: string, local: string): XmlElement | null {
  for (const c of el.children) if (isEl(c, ns, local)) return c;
  return null;
}

export function children(el: XmlElement, ns: string, local: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => isEl(c, ns, local));
}

/** Depth-first search for descendants (not including `el`). */
export function descendants(el: XmlElement, ns: string, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.type !== "element") continue;
      if (c.ns === ns && localName(c.name) === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** Resolves a namespace prefix in scope at `el`. */
export function lookupNamespace(el: XmlElement, prefix: string): string | null {
  if (prefix === "xml") return XML_NS;
  for (let e: XmlElement | null = el; e; e = e.parent) {
    const want = prefix ? "xmlns:" + prefix : "xmlns";
    for (const a of e.attrs) if (a.name === want) return decodeEntities(a.raw);
  }
  return null;
}

/** Finds a prefix bound to `ns` in scope at `el` ("" for a default namespace). */
export function lookupPrefix(el: XmlElement, ns: string): string | null {
  for (let e: XmlElement | null = el; e; e = e.parent) {
    for (const a of e.attrs) {
      if (decodeEntities(a.raw) !== ns) continue;
      let p: string | null = null;
      if (a.name === "xmlns") p = "";
      else if (a.name.startsWith("xmlns:")) p = a.name.slice(6);
      // Make sure the binding is not shadowed closer to `el`.
      if (p !== null && lookupNamespace(el, p) === ns) return p;
    }
  }
  return null;
}

/**
 * Gets an attribute value (decoded). `ns` null matches an unprefixed
 * attribute; otherwise the attribute's prefix must resolve to `ns`.
 */
export function getAttr(el: XmlElement, local: string, ns: string | null = null): string | null {
  const a = findAttr(el, local, ns);
  return a ? decodeEntities(a.raw) : null;
}

function findAttr(el: XmlElement, local: string, ns: string | null): XmlAttr | null {
  for (const a of el.attrs) {
    if (localName(a.name) !== local) continue;
    const p = prefixOf(a.name);
    if (ns === null) {
      if (!p) return a;
    } else if (p && p !== "xmlns" && lookupNamespace(el, p) === ns) {
      return a;
    }
  }
  return null;
}

/** Sets an unprefixed attribute (or a prefixed one when `qname` contains ':'). */
export function setAttr(el: XmlElement, qname: string, value: string): void {
  const raw = escapeAttr(value);
  const existing = el.attrs.find((a) => a.name === qname);
  if (existing) {
    if (existing.raw === raw) return;
    existing.raw = raw;
    existing.quote = '"';
  } else {
    el.attrs.push({ name: qname, raw, quote: '"' });
  }
  el.rawOpen = null;
}

/** Sets a namespaced attribute, reusing an existing one if present. */
export function setAttrNS(el: XmlElement, ns: string, local: string, value: string, fallbackPrefix: string): void {
  const a = findAttr(el, local, ns);
  if (a) {
    setAttr(el, a.name, value);
    return;
  }
  let p = lookupPrefix(el, ns);
  if (p === null || p === "") {
    p = fallbackPrefix;
    setAttr(el, "xmlns:" + p, ns);
  }
  setAttr(el, p + ":" + local, value);
}

export function removeAttr(el: XmlElement, qname: string): void {
  const idx = el.attrs.findIndex((a) => a.name === qname);
  if (idx >= 0) {
    el.attrs.splice(idx, 1);
    el.rawOpen = null;
  }
}

export function removeNode(node: XmlElement): void {
  const p = node.parent;
  if (!p) return;
  const idx = p.children.indexOf(node);
  if (idx >= 0) p.children.splice(idx, 1);
  node.parent = null;
}

/**
 * Removes an element together with the whitespace-only text node that
 * precedes it (keeps pretty-printed files tidy).
 */
export function removeNodeTidy(node: XmlElement): void {
  const p = node.parent;
  if (!p) return;
  const idx = p.children.indexOf(node);
  if (idx < 0) return;
  const prev = p.children[idx - 1];
  if (prev && prev.type === "text" && !/\S/.test(prev.raw)) p.children.splice(idx - 1, 2);
  else p.children.splice(idx, 1);
  node.parent = null;
}

export function insertAfter(ref: XmlElement, node: XmlElement): void {
  const p = ref.parent;
  if (!p) throw new Error("Reference node has no parent");
  const idx = p.children.indexOf(ref);
  node.parent = p;
  p.children.splice(idx + 1, 0, node);
}

export function appendChild(parent: XmlElement, node: XmlNode): void {
  if (node.type === "element") node.parent = parent;
  parent.children.push(node);
}

/** Deep clone. The clone keeps raw source for untouched nodes. */
export function cloneElement(el: XmlElement, parent: XmlElement | null = null): XmlElement {
  const copy: XmlElement = {
    type: "element",
    name: el.name,
    attrs: el.attrs.map((a) => ({ ...a })),
    children: [],
    parent,
    ns: el.ns,
    rawOpen: el.rawOpen,
    rawClose: el.rawClose,
  };
  for (const c of el.children) {
    copy.children.push(c.type === "element" ? cloneElement(c, copy) : { ...c });
  }
  return copy;
}

/**
 * Creates a new element in namespace `ns`, using the prefix that is bound to
 * `ns` in scope at `context` (or `fallbackPrefix` if it isn't bound — the
 * caller is then responsible for the xmlns declaration).
 */
export function createElement(context: XmlElement, ns: string, local: string, fallbackPrefix?: string): XmlElement {
  let p = lookupPrefix(context, ns);
  if (p === null) {
    if (fallbackPrefix === undefined) throw new Error(`Namespace ${ns} not in scope`);
    p = fallbackPrefix;
  }
  return {
    type: "element",
    name: p ? p + ":" + local : local,
    attrs: [],
    children: [],
    parent: null,
    ns,
    rawOpen: null,
    rawClose: null,
  };
}

/** Decoded text content of an element (text nodes and CDATA). */
export function textContent(el: XmlElement): string {
  let s = "";
  for (const c of el.children) {
    if (c.type === "text") s += decodeEntities(c.raw);
    else if (c.type === "raw" && c.raw.startsWith("<![CDATA[")) s += c.raw.slice(9, -3);
    else if (c.type === "element") s += textContent(c);
  }
  return s;
}

export function setTextContent(el: XmlElement, text: string): void {
  for (const c of el.children) if (c.type === "element") c.parent = null;
  el.children = text ? [{ type: "text", raw: escapeText(text) }] : [];
}
