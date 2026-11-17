/**
 * The first step of a repair, on the file's bytes alone: what is in front of
 * the PDF or after its end is cut off, and a file that was cut off part way
 * (a download that stopped) is closed after its last whole object, so a
 * parser can read everything up to there. Its index (the cross-reference
 * table) is checked too: the repaired file always gets a new one, and the
 * report says when the old one was wrong.
 *
 * Works on bytes, not strings: a 500 MB file must not become a second copy.
 */

/** What was wrong with the file's bytes, and fixed. */
export type ByteFix = "junk-before" | "junk-after" | "cut-off" | "header" | "index";

/** Not a PDF at all: no header and no PDF objects. */
export class NotAPdfError extends Error {}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/** Each byte as one character, as it is ("latin1" in TextDecoder is windows-1252, which changes 0x80–0x9f). */
export function text(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

const HEADER = latin1("%PDF-");
const EOF = latin1("%%EOF");
const ENDOBJ = latin1("endobj");
const STREAM = latin1("stream");
const STARTXREF = latin1("startxref");
const CATALOG = latin1("/Catalog");

/** First place `pattern` starts in `bytes` at or after `from`, or -1. */
export function indexOf(bytes: Uint8Array, pattern: Uint8Array, from = 0, to = bytes.length): number {
  const first = pattern[0];
  const last = Math.min(to, bytes.length) - pattern.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < pattern.length; k++) if (bytes[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

/** Last place `pattern` starts in `bytes` before `before`, or -1. */
export function lastIndexOf(bytes: Uint8Array, pattern: Uint8Array, before = bytes.length): number {
  const first = pattern[0];
  outer: for (let i = Math.min(before, bytes.length) - pattern.length; i >= 0; i--) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < pattern.length; k++) if (bytes[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

const isSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
/** A keyword stands alone: not part of a longer word such as "endstream" or "objective". */
const isRegular = (b: number | undefined) =>
  b !== undefined && !isSpace(b) && !"()<>[]{}/%".includes(String.fromCharCode(b));

/** An object header ("12 0 obj") in a short piece of text, with where it starts. */
const OBJ_HEADER = /(?:^|[^0-9])(\d{1,10})\s+(\d{1,5})\s+obj(?![A-Za-z0-9])/g;

function headersIn(chunk: string): { at: number; num: number; gen: number }[] {
  const out: { at: number; num: number; gen: number }[] = [];
  OBJ_HEADER.lastIndex = 0;
  for (let m; (m = OBJ_HEADER.exec(chunk)); ) {
    out.push({ at: m.index + m[0].indexOf(m[1]), num: Number(m[1]), gen: Number(m[2]) });
  }
  return out;
}

/** The object number of the document catalog, found by its /Type, for a trailer that names it. */
function catalogRef(bytes: Uint8Array): string | null {
  for (let at = lastIndexOf(bytes, CATALOG); at > 0; at = lastIndexOf(bytes, CATALOG, at)) {
    // "/Type /Catalog", not a name that only starts with it.
    if (isRegular(bytes[at + CATALOG.length])) continue;
    const before = text(bytes.subarray(Math.max(0, at - 4096), at));
    if (!/\/Type\s*$/.test(before)) continue;
    const found = headersIn(before).at(-1);
    if (found) return `${found.num} ${found.gen} R`;
  }
  return null;
}

const TRAILER = latin1("trailer");
const STANDARD = latin1("/Standard");

/** The object number of the file's security dictionary (/Filter /Standard with its /O and /U), if it has one. */
function securityRef(bytes: Uint8Array): string | null {
  for (let at = lastIndexOf(bytes, STANDARD); at > 0; at = lastIndexOf(bytes, STANDARD, at)) {
    const around = text(bytes.subarray(Math.max(0, at - 1024), Math.min(bytes.length, at + 1024)));
    const here = Math.min(at, 1024);
    if (!/\/Filter\s*$/.test(around.slice(0, here))) continue;
    const found = headersIn(around.slice(0, here)).at(-1);
    if (found && /\/O\s*[(<]/.test(around) && /\/U\s*[(<]/.test(around)) return `${found.num} ${found.gen} R`;
  }
  return null;
}

/** What the last trailer in the file names: its catalog, encryption, ID and info. */
function lastTrailer(bytes: Uint8Array): { Root?: string; Encrypt?: string; ID?: string; Info?: string } {
  const at = lastIndexOf(bytes, TRAILER);
  if (at < 0) return {};
  const dict = text(bytes.subarray(at, at + 4096));
  const ref = (key: string) => new RegExp(`/${key}\\s+(\\d+\\s+\\d+\\s+R)`).exec(dict)?.[1];
  const id = /\/ID\s*(\[\s*(?:<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\))\s*(?:<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\))\s*\])/.exec(dict)?.[1];
  return { Root: ref("Root"), Encrypt: ref("Encrypt"), ID: id, Info: ref("Info") };
}

/**
 * Whether the index the file ends with points where it should: `startxref`
 * at an `xref` table or an index stream, and each entry of a table at its
 * own object. Only the first few thousand entries are looked at.
 */
function indexHolds(bytes: Uint8Array): boolean {
  const at = lastIndexOf(bytes, STARTXREF);
  if (at < 0) return false;
  const m = /^startxref\s+(\d+)/.exec(text(bytes.subarray(at, at + 40)));
  const offset = m ? Number(m[1]) : NaN;
  if (!(offset > 0 && offset < bytes.length)) return false;
  const head = text(bytes.subarray(offset, offset + 64));
  if (/^\d+\s+\d+\s+obj\b/.test(head)) return true; // an index stream: pdf.js and pdf-lib read it whole
  if (!head.startsWith("xref")) return false;
  const table = text(bytes.subarray(offset, offset + 4 + 20 * 4000 + 200));
  const lines = table.split(/\r\n|\r|\n/).slice(1);
  let num = 0;
  let checked = 0;
  for (const line of lines) {
    const section = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (section) {
      num = Number(section[1]);
      continue;
    }
    const entry = /^(\d{10})\s(\d{5})\s([nf])/.exec(line);
    if (!entry) break;
    if (entry[3] === "n") {
      const pos = Number(entry[1]);
      const obj = text(bytes.subarray(pos, pos + 24));
      const found = /^(\d+)\s+\d+\s+obj\b/.exec(obj);
      if (!found || Number(found[1]) !== num) return false;
      if (++checked >= 4000) break;
    }
    num++;
  }
  return true;
}

export interface Salvaged {
  bytes: Uint8Array;
  fixes: ByteFix[];
  /** The stream that was cut part way and closed here ("12 0"), if any: what it holds is only its start. */
  closed?: string;
}

/**
 * The file from its PDF header to its end, closed properly if it was cut
 * off. Throws NotAPdfError when it holds no PDF at all.
 */
export function salvage(input: Uint8Array): Salvaged {
  if (!input.length) throw new NotAPdfError("This file is empty.");
  const fixes: ByteFix[] = [];
  let bytes = input;

  const start = indexOf(bytes, HEADER);
  if (start < 0) {
    // No header, but PDF objects: the start of the file is missing.
    const first = headersIn(text(bytes.subarray(0, 64 * 1024)))[0];
    if (!first) throw new NotAPdfError("This file isn't a PDF, so there's nothing to repair.");
    bytes = concat(latin1("%PDF-1.7\n"), bytes.subarray(first.at));
    fixes.push("header");
  } else if (start > 0) {
    bytes = bytes.subarray(start);
    fixes.push("junk-before");
  }

  const lastEndobj = lastIndexOf(bytes, ENDOBJ);
  const lastEof = lastIndexOf(bytes, EOF);
  if (lastEof > lastEndobj) {
    // The file has an end: anything after it that isn't white space is cut off.
    let end = lastEof + EOF.length;
    let k = end;
    while (k < bytes.length && isSpace(bytes[k])) k++;
    if (k < bytes.length) {
      bytes = bytes.subarray(0, end);
      fixes.push("junk-after");
    }
    if (!fixes.includes("header") && !indexHolds(bytes)) fixes.push("index");
    return { bytes, fixes };
  }

  // No end after the last whole object: the file was cut off. Keep every
  // whole object; a stream that was cut part way is closed, so the part of
  // it that arrived is still read.
  fixes.push("cut-off");
  const keep = lastEndobj < 0 ? 0 : lastEndobj + ENDOBJ.length;
  const tail = bytes.subarray(keep);
  const header = headersIn(text(tail.subarray(0, 4096)))[0];
  let partial: Uint8Array | null = null;
  let closed: string | undefined;
  if (header) {
    const streamAt = indexOf(tail, STREAM, header.at, Math.min(tail.length, header.at + 64 * 1024));
    if (streamAt >= 0 && !isRegular(tail[streamAt + STREAM.length]) && tail.length > streamAt + STREAM.length + 1) {
      partial = concat(tail.subarray(header.at), latin1("\nendstream\nendobj\n"));
      closed = `${header.num} ${header.gen}`;
    }
  }
  if (keep === 0 && !partial) throw new NotAPdfError("This file holds no PDF content to recover.");
  // The last trailer there is still says how the file is encrypted (without
  // its /Encrypt and /ID nothing decrypts) and where its catalog is.
  const kept = lastTrailer(bytes);
  const root = kept.Root ?? catalogRef(bytes.subarray(0, keep));
  // No trailer left, but a security dictionary: the file is encrypted all the same.
  kept.Encrypt ??= securityRef(bytes.subarray(0, keep)) ?? undefined;
  const entries = [root && `/Root ${root}`, kept.Encrypt && `/Encrypt ${kept.Encrypt}`, kept.ID && `/ID ${kept.ID}`, kept.Info && `/Info ${kept.Info}`];
  const trailer = latin1(`\ntrailer\n<< ${entries.filter(Boolean).join(" ")} >>\nstartxref\n0\n%%EOF\n`);
  return { bytes: concat(bytes.subarray(0, keep), ...(partial ? [latin1("\n"), partial] : []), trailer), fixes, closed };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
