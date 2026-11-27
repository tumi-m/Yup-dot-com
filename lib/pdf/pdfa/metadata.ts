/**
 * PDF/A's document metadata: an XMP packet that says which part and level
 * the file meets (pdfaid), with the title, author, subject, keywords, tools
 * and dates the document information dictionary holds, written the same in
 * both (PDF/A-1 checks they match; it is good practice in 2 and 3 too), and
 * a file identifier in the trailer.
 *
 * The packet is written afresh: an old one may use properties PDF/A only
 * accepts with schema descriptions it doesn't carry.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFStream, PDFString, type PDFDocument } from "pdf-lib";
import { streamBytes } from "./content";

const N = PDFName.of;

export type Part = 2 | 3;

/** What the file's own XMP says it is ("PDF/A-1b"), if anything. */
export function claimedPdfa(doc: PDFDocument): string | null {
  const xmp = catalogXmp(doc);
  if (!xmp) return null;
  const part = /pdfaid:part(?:>|\s*=\s*["'])\s*(\d)/.exec(xmp)?.[1];
  const level = /pdfaid:conformance(?:>|\s*=\s*["'])\s*([ABUabu])/.exec(xmp)?.[1];
  return part ? `PDF/A-${part}${level ? level.toLowerCase() : ""}` : null;
}

function catalogXmp(doc: PDFDocument): string | null {
  const meta = doc.catalog.lookup(N("Metadata"));
  if (!(meta instanceof PDFStream)) return null;
  const bytes = streamBytes(meta);
  return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
}

/** XML 1.0 allows no control characters but tab and the line breaks. */
export function cleanText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff || (c >= 0xd800 && c <= 0xdfff)) continue;
    out += ch;
  }
  return out.trim();
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An XMP date: ISO 8601 in UTC. */
const xmpDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A title in an old XMP packet, for a file whose Info has none. */
function xmpTitle(xmp: string | null): string | undefined {
  const m = xmp && /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
  if (!m) return undefined;
  const text = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return cleanText(text) || undefined;
}

const PRODUCER = "PDF Wizard";

export interface Details {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer: string;
  created: Date;
  modified: Date;
}

/** The XMP packet for these details. */
export function xmpPacket(part: Part, d: Details, ids: { document: string; instance: string }, identify = true): Uint8Array {
  const alt = (tag: string, v?: string) => (v ? `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xml(v)}</rdf:li></rdf:Alt></${tag}>\n` : "");
  const simple = (tag: string, v?: string) => (v ? `   <${tag}>${xml(v)}</${tag}>\n` : "");
  const desc = (ns: string, body: string) => `  <rdf:Description rdf:about="" ${ns}>\n${body}  </rdf:Description>\n`;
  const text =
    `<?xpacket begin="${String.fromCharCode(0xfeff)}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    (identify ? desc('xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"', simple("pdfaid:part", String(part)) + simple("pdfaid:conformance", "B")) : "") +
    desc(
      'xmlns:dc="http://purl.org/dc/elements/1.1/"',
      simple("dc:format", "application/pdf") +
        alt("dc:title", d.title) +
        (d.author ? `   <dc:creator><rdf:Seq><rdf:li>${xml(d.author)}</rdf:li></rdf:Seq></dc:creator>\n` : "") +
        alt("dc:description", d.subject)
    ) +
    desc('xmlns:pdf="http://ns.adobe.com/pdf/1.3/"', simple("pdf:Producer", d.producer) + simple("pdf:Keywords", d.keywords)) +
    desc(
      'xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
      simple("xmp:CreateDate", xmpDate(d.created)) +
        simple("xmp:ModifyDate", xmpDate(d.modified)) +
        simple("xmp:MetadataDate", xmpDate(d.modified)) +
        simple("xmp:CreatorTool", d.creator)
    ) +
    desc('xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"', simple("xmpMM:DocumentID", `uuid:${ids.document}`) + simple("xmpMM:InstanceID", `uuid:${ids.instance}`)) +
    ` </rdf:RDF>\n</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`;
  return new TextEncoder().encode(text);
}

/**
 * Writes the document's details into Info and a new XMP packet, both the
 * same, and gives the trailer a file identifier (keeping the first half of
 * an old one, which names the document across versions). `identify` false
 * leaves out the PDF/A identification, for a file that doesn't meet it.
 */
export function writeMetadata(doc: PDFDocument, part: Part, now = new Date(), identify = true): Details {
  const old = catalogXmp(doc);
  const read = (get: () => string | undefined) => {
    try {
      const v = get();
      return v ? cleanText(v) || undefined : undefined;
    } catch {
      return undefined;
    }
  };
  let created: Date | undefined;
  try {
    created = doc.getCreationDate();
  } catch {
    created = undefined;
  }
  const details: Details = {
    title: read(() => doc.getTitle()) ?? xmpTitle(old),
    author: read(() => doc.getAuthor()),
    subject: read(() => doc.getSubject()),
    keywords: read(() => doc.getKeywords()),
    creator: read(() => doc.getCreator()),
    producer: PRODUCER,
    created: created && !isNaN(created.getTime()) ? new Date(Math.floor(created.getTime() / 1000) * 1000) : new Date(Math.floor(now.getTime() / 1000) * 1000),
    modified: new Date(Math.floor(now.getTime() / 1000) * 1000),
  };

  // Info, rewritten so its strings and dates read exactly as the packet's.
  const info = infoDict(doc);
  for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"]) info.delete(N(key));
  const text = (key: string, v?: string) => v && info.set(N(key), PDFHexString.fromText(v));
  text("Title", details.title);
  text("Author", details.author);
  text("Subject", details.subject);
  text("Keywords", details.keywords);
  text("Creator", details.creator);
  text("Producer", details.producer);
  info.set(N("CreationDate"), PDFString.fromDate(details.created));
  info.set(N("ModDate"), PDFString.fromDate(details.modified));

  const ctx = doc.context;
  const ids = { document: uuid(), instance: uuid() };
  // Uncompressed: PDF/A-1 asks for that, and anyone can read it.
  doc.catalog.set(N("Metadata"), ctx.register(ctx.stream(xmpPacket(part, details, ids, identify), { Type: "Metadata", Subtype: "XML" })));

  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const oldId = ctx.lookup(ctx.trailerInfo.ID);
  const first = oldId instanceof PDFArray ? oldId.lookup(0) : undefined;
  const keep = first instanceof PDFHexString || first instanceof PDFString ? first : PDFHexString.of(random);
  ctx.trailerInfo.ID = ctx.obj([keep, PDFHexString.of(random)]);
  return details;
}

/** The document information dictionary, made when there is none. */
function infoDict(doc: PDFDocument): PDFDict {
  const ctx = doc.context;
  const existing = ctx.lookup(ctx.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const dict = ctx.obj({});
  ctx.trailerInfo.Info = ctx.register(dict);
  return dict;
}
