/**
 * A tiny, dependency-free XML reader for the parts of a .pptx we inspect
 * ourselves (paragraph properties, placeholder inheritance, hidden slides).
 * OOXML parts are machine-written and well-formed, so this supports only
 * elements, attributes, text, CDATA, comments and processing instructions.
 * Pure and isomorphic, so it runs in the browser and under Node tests.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content (entities decoded). */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

  while (i < n) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt === -1) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top.text += src.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
    } else if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      const end = src.indexOf(">", lt + 1);
      i = end === -1 ? n : end + 1;
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt + 2);
      if (stack.length > 1) stack.pop();
      i = end === -1 ? n : end + 1;
    } else {
      // Find the end of the tag, skipping ">" inside quoted attribute values.
      let j = lt + 1;
      let quote = "";
      while (j < n) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        j++;
      }
      const raw = src.slice(lt + 1, j);
      const selfClosing = raw.endsWith("/");
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const nameEnd = body.search(/[\s/]|$/);
      const node: XmlNode = { name: body.slice(0, nameEnd), attrs: {}, children: [], text: "" };
      attrRe.lastIndex = 0;
      const rest = body.slice(nameEnd);
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rest))) node.attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
      top.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

/** First direct child with the given name. */
export function child(node: XmlNode | undefined | null, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined | null, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Follows a path of direct children, e.g. path(sp, "p:nvSpPr", "p:cNvPr"). */
export function path(node: XmlNode | undefined | null, ...names: string[]): XmlNode | undefined {
  let cur: XmlNode | undefined = node ?? undefined;
  for (const name of names) {
    cur = child(cur, name);
    if (!cur) return undefined;
  }
  return cur;
}
