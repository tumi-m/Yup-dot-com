/**
 * Looks for redacted text in a PDF's own objects, as someone digging in the
 * file would: every string (hex strings and text in UTF-16 too), every
 * stream that can be decoded (content, forms, appearances, metadata,
 * scripts, attachments), objects packed in object streams, and objects
 * nothing uses. Pictures and font programs are left out: their bytes aren't
 * text. Only pdf-lib, so it runs in the worker that wrote the file.
 *
 * Each object is put with the pages that use it, or with the document
 * (bookmarks, form, details), or with nothing. Text found on a page is only
 * allowed where the person chose to leave copies on that page.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import { decodeFully } from "../compress/streams";
import { countIn, normal, squeezedIn, type Needle } from "./marks";

export interface Leak {
  /** The redacted text found. */
  text: string;
  /** Where, for people: "on page 3", "in the bookmarks"… */
  where: string;
}

const N = {
  Type: PDFName.of("Type"),
  Subtype: PDFName.of("Subtype"),
  Page: PDFName.of("Page"),
  Pages: PDFName.of("Pages"),
  Parent: PDFName.of("Parent"),
  P: PDFName.of("P"),
  Image: PDFName.of("Image"),
  Metadata: PDFName.of("Metadata"),
  XML: PDFName.of("XML"),
  EmbeddedFile: PDFName.of("EmbeddedFile"),
  Dests: PDFName.of("Dests"),
  ICCBased: PDFName.of("ICCBased"),
};
const FONT_FILES = ["FontFile", "FontFile2", "FontFile3"].map((k) => PDFName.of(k));
/** Keys whose strings are dates a reader stamps on a note, not text in the document. */
const DATES = new Set(["M", "CreationDate", "ModDate"]);

/** Where the document itself keeps things, by the catalog key they hang from. */
const DOCUMENT_PLACES: Record<string, string> = {
  Outlines: "in the bookmarks",
  AcroForm: "in the form fields",
  Names: "in the document's names or attachments",
  Metadata: "in the document's details",
  Info: "in the document's details",
};

const isPageNode = (o: PDFObject | undefined) => o instanceof PDFDict && (o.get(N.Type) === N.Page || o.get(N.Type) === N.Pages);

const latin1 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};

function decodeBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return String.fromCharCode(...bytes);
}

/**
 * The strings in PDF syntax (a content stream, an object stream), decoded:
 * strings in one TJ array are joined as they are shown, others are spaced.
 */
export function stringsIn(data: Uint8Array): string {
  let out = "";
  let i = 0;
  let joined = false;
  const n = data.length;
  while (i < n) {
    const c = data[i];
    if (c === 0x28) {
      // A literal string, with its escapes.
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = data[i];
        if (ch === 0x5c) {
          const e = data[i + 1];
          i += 2;
          if (e === 0x6e) bytes.push(10);
          else if (e === 0x72) bytes.push(13);
          else if (e === 0x74) bytes.push(9);
          else if (e === 0x62) bytes.push(8);
          else if (e === 0x66) bytes.push(12);
          else if (e === 0x0d || e === 0x0a) {
            if (e === 0x0d && data[i] === 0x0a) i++;
          } else if (e >= 0x30 && e <= 0x37) {
            let v = e - 0x30;
            for (let k = 0; k < 2 && data[i] >= 0x30 && data[i] <= 0x37; k++) v = v * 8 + data[i++] - 0x30;
            bytes.push(v & 0xff);
          } else if (e !== undefined) bytes.push(e);
          continue;
        }
        if (ch === 0x28) depth++;
        else if (ch === 0x29 && --depth === 0) {
          i++;
          break;
        }
        bytes.push(ch);
        i++;
      }
      out += (joined ? "" : " ") + decodeBytes(bytes);
      joined = true;
      continue;
    }
    if (c === 0x3c && data[i + 1] !== 0x3c) {
      const end = data.indexOf(0x3e, i + 1);
      const stop = end < 0 ? n : end;
      let hex = "";
      for (let k = i + 1; k < stop; k++) if (/[0-9a-f]/i.test(String.fromCharCode(data[k]))) hex += String.fromCharCode(data[k]);
      if (hex.length % 2) hex += "0";
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      out += (joined ? "" : " ") + decodeBytes(bytes);
      joined = true;
      i = stop + 1;
      continue;
    }
    if (c === 0x3c) {
      i += 2;
      joined = false;
      continue;
    }
    // Inside a TJ array only numbers come between strings; anything else spaces them.
    if (!(c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39) || c === 0x5b)) joined = false;
    if (c === 0x5d) joined = false;
    i++;
  }
  return out;
}

/** Whether `text` holds the needle where no copy may stay. */
function holds(text: string, needle: Needle): boolean {
  return countIn(text, needle) > 0 || squeezedIn(text, needle);
}

/** Everything a direct object says, without following references (those are objects of their own). */
function textOf(obj: PDFObject, out: string[], key?: string) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    if (key && DATES.has(key)) return;
    try {
      out.push(obj.decodeText());
    } catch {
      out.push(obj.asString());
    }
  } else if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) textOf(v, out, k.decodeText());
  } else if (obj instanceof PDFArray) {
    for (const v of obj.asArray()) textOf(v, out, key);
  }
}

/**
 * The redacted text still in `bytes`, if any. `needles` say how many
 * copies of each may stay on which pages (copies the person left unmarked).
 */
export async function findLeaks(bytes: Uint8Array, needles: Needle[], signal?: AbortSignal): Promise<Leak[]> {
  if (!needles.length) return [];
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const { context } = doc;
  const pages = doc.getPages();

  // Which pages, or which part of the document, each object belongs to.
  const places = new Map<PDFRef, Set<number | string>>();
  const pageOf = new Map<PDFDict, number>();
  pages.forEach((p, i) => pageOf.set(p.node, i));
  const walk = (start: PDFObject, place: number | string, skipRef: (ref: PDFRef) => boolean) => {
    const pending: PDFObject[] = [start];
    const seen = new Set<PDFObject>();
    while (pending.length) {
      const o = pending.pop()!;
      if (seen.has(o)) continue;
      seen.add(o);
      if (o instanceof PDFRef) {
        if (skipRef(o)) continue;
        const target = context.lookup(o);
        if (!target) continue;
        // Another page is that page's own: a link to it doesn't bring its content here.
        if (target instanceof PDFDict && isPageNode(target) && pageOf.get(target) !== place) continue;
        let set = places.get(o);
        if (!set) places.set(o, (set = new Set()));
        set.add(place);
        pending.push(target);
        continue;
      }
      const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
      if (dict) {
        if (isPageNode(dict) && pageOf.get(dict) !== place) continue;
        for (const [k, v] of dict.entries()) if (k !== N.Parent && k !== N.P) pending.push(v);
      } else if (o instanceof PDFArray) pending.push(...o.asArray());
    }
  };
  pages.forEach((p, i) => walk(p.ref, i, () => false));
  // The document's own parts, apart from what pages already hold.
  const onPage = (ref: PDFRef) => [...(places.get(ref) ?? [])].some((p) => typeof p === "number");
  for (const [key, value] of doc.catalog.entries()) {
    if (key === N.Pages) continue;
    walk(value, DOCUMENT_PLACES[key.decodeText()] ?? "in the document's settings", onPage);
  }
  const info = context.trailerInfo.Info;
  if (info) walk(info, DOCUMENT_PLACES.Info, onPage);
  // The catalog's own direct values.
  const root = context.trailerInfo.Root;
  if (root instanceof PDFRef && !places.has(root)) places.set(root, new Set(["in the document's settings"]));

  // Pictures, font programs and colour profiles aren't text.
  const notText = new Set<PDFRef>();
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : null;
    if (dict) for (const k of FONT_FILES) if (dict.get(k) instanceof PDFRef) notText.add(dict.get(k) as PDFRef);
    if (obj instanceof PDFArray && obj.get(0) === N.ICCBased && obj.get(1) instanceof PDFRef) notText.add(obj.get(1) as PDFRef);
  }

  const leaks: Leak[] = [];
  const reported = new Set<string>();
  let count = 0;
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (signal?.aborted) break;
    if (++count % 200 === 0) await new Promise((r) => setTimeout(r, 0));
    const parts: string[] = [];
    if (obj instanceof PDFStream) {
      textOf(obj.dict, parts);
      const isImage = obj.dict.get(N.Subtype) === N.Image;
      if (!isImage && !notText.has(ref) && obj instanceof PDFRawStream) {
        const data = decodeFully(context, obj);
        if (data) {
          const type = obj.dict.get(N.Type);
          const sub = obj.dict.get(N.Subtype);
          const text = type === N.Metadata || sub === N.XML || type === N.EmbeddedFile ? new TextDecoder().decode(data) : latin1(data);
          parts.push(text, stringsIn(data));
        }
      }
    } else {
      textOf(obj, parts);
      // The old /Dests dictionary names its destinations by its keys.
      if (obj instanceof PDFDict && doc.catalog.lookup(N.Dests) === obj) for (const [k] of obj.entries()) parts.push(k.decodeText());
    }
    if (!parts.length) continue;
    const text = parts.join("\n");
    if (!normal(text)) continue;
    const where = [...(places.get(ref) ?? [])];
    for (const needle of needles) {
      if (!holds(text, needle)) continue;
      // Copies the person left are allowed on their page.
      if (where.some((p) => typeof p === "number" && (needle.allowed[p] ?? 0) > 0)) continue;
      const pageHere = where.find((p): p is number => typeof p === "number");
      const label = pageHere !== undefined ? `on page ${pageHere + 1}` : ((where.find((p) => typeof p === "string") as string | undefined) ?? "in a part of the file no page uses");
      const key = `${needle.text}|${label}`;
      if (reported.has(key)) continue;
      reported.add(key);
      leaks.push({ text: needle.text, where: label });
    }
  }
  return leaks;
}
