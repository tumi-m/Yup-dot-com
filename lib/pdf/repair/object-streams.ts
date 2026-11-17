/**
 * Object streams hold many small objects (the catalog, the page list, page
 * dictionaries, fonts) packed and compressed together, so one damaged
 * stream loses all of them: pdf-lib and pdf.js both give up on it. Here each
 * object stream that won't read as it is gets read forgivingly (a wrong
 * count, a wrong start, a wrong length, data damaged or cut part way) and
 * every object that comes out whole is written back as a plain object, in
 * the same place in the file, so a later update still wins over it.
 *
 * Streams that read as they are stay as they are: a healthy file is not
 * rewritten.
 */
import { Inflate, Unzlib, inflateSync, unzlibSync } from "fflate";
import { indexOf, text } from "./salvage";

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const OBJSTM = latin1("/ObjStm");
const STREAM = latin1("stream");
const ENDSTREAM = latin1("endstream");
const ENDOBJ = latin1("endobj");

const isSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
/** Where an object can start: a dictionary, array, string, name, number or keyword. */
const STARTS = /^(<<|<|\[|\(|\/|[-+.\d]|true|false|null)/;

/**
 * All of `data` that inflates, whole or up to where it is damaged: `whole`
 * when nothing was lost, `asItIs` when it needed no help.
 */
function inflate(data: Uint8Array): { out: Uint8Array; whole: boolean; asItIs?: boolean } | null {
  // A damaged two-byte header is stepped over; data that is damaged further
  // on can still inflate "raw" into nonsense, so raw is tried only then.
  const header = data.length > 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
  const whole = header ? [() => unzlibSync(data)] : [() => inflateSync(data.subarray(2)), () => inflateSync(data)];
  for (const decode of whole) {
    try {
      return { out: decode(), whole: true, asItIs: header };
    } catch {
      // Damaged: below.
    }
  }
  let best: Uint8Array | null = null;
  const partial = header ? ([[Unzlib, 0]] as const) : ([[Inflate, 2], [Inflate, 0]] as const);
  for (const [Make, from] of partial) {
    const chunks: Uint8Array[] = [];
    try {
      new Make((chunk: Uint8Array) => chunks.push(chunk)).push(data.subarray(from), false);
    } catch {
      // What came before the damage is kept.
    }
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (size > (best?.length ?? 0)) {
      best = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        best.set(c, at);
        at += c.length;
      }
    }
  }
  return best ? { out: best, whole: false } : null;
}

interface Entry {
  num: number;
  offset: number;
}

/** The pairs of numbers the stream starts with, up to `max` of them, and where they end. */
function readHeader(data: string, max: number): { entries: Entry[]; end: number } {
  const entries: Entry[] = [];
  const pair = /\s*(\d{1,10})\s+(\d{1,10})(?=\s)/y;
  let at = 0;
  while (entries.length < max) {
    pair.lastIndex = at;
    const m = pair.exec(data);
    if (!m) break;
    const offset = Number(m[2]);
    // Offsets only go up: a pair that goes back is the first object, not the header.
    if (entries.length && offset < entries[entries.length - 1].offset) break;
    entries.push({ num: Number(m[1]), offset });
    at = pair.lastIndex;
  }
  while (at < data.length && isSpace(data.charCodeAt(at))) at++;
  return { entries, end: at };
}

/** How many of the objects start where they should when the first one is at `first`. */
function fits(data: string, entries: Entry[], first: number): number {
  let ok = 0;
  for (const e of entries) {
    const at = first + e.offset;
    if (at >= data.length) break;
    // An object starts after white space or at a delimiter, never inside a word.
    const before = at > 0 ? data.charCodeAt(at - 1) : 0x20;
    if (!isSpace(before) && !"<>[]()/".includes(data[at])) continue;
    if (STARTS.test(data.slice(at, at + 6).trimStart())) ok++;
  }
  return ok;
}

/**
 * True when `body` is one PDF value (or a reference, "12 0 R"): data damaged
 * part way inflates into nonsense before it fails, and nonsense is rarely that.
 */
export function oneValue(body: string): boolean {
  let values = 0;
  let depth = 0;
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if (isSpace(body.charCodeAt(i))) {
      i++;
      continue;
    }
    if (c === "%") {
      while (i < body.length && body[i] !== "\n" && body[i] !== "\r") i++;
      continue;
    }
    if (depth === 0) values++;
    if (c === "(") {
      // A string, with escapes and nested brackets.
      let nest = 0;
      for (; i < body.length; i++) {
        if (body[i] === "\\") i++;
        else if (body[i] === "(") nest++;
        else if (body[i] === ")" && --nest === 0) break;
      }
      if (nest !== 0) return false;
      i++;
    } else if (c === "<" && body[i + 1] === "<") {
      depth++;
      i += 2;
    } else if (c === ">" && body[i + 1] === ">") {
      if (--depth < 0) return false;
      i += 2;
    } else if (c === "[") {
      depth++;
      i++;
    } else if (c === "]") {
      if (--depth < 0) return false;
      i++;
    } else if (c === "<") {
      const end = body.indexOf(">", i);
      if (end < 0 || !/^[0-9A-Fa-f\s]*$/.test(body.slice(i + 1, end))) return false;
      i = end + 1;
    } else if (c === ">" || c === ")" || c === "{" || c === "}") {
      return false;
    } else {
      // A name, number or keyword runs to the next white space or delimiter.
      i++;
      while (i < body.length && !isSpace(body.charCodeAt(i)) && !"()<>[]{}/%".includes(body[i])) i++;
    }
  }
  return depth === 0 && (values === 1 || /^\d+\s+\d+\s+R$/.test(body));
}

/** The objects of a decoded stream that are there whole, as "12 0 obj … endobj". */
function objectsOf(decoded: Uint8Array, whole: boolean, count: number, first: number): string {
  const data = text(decoded);
  const { entries, end } = readHeader(data, count > 0 && count < 1e6 ? count : 1e6);
  if (!entries.length) return "";
  // The start the stream names, or else the one right after its numbers.
  const firstAt = [first, end].filter((f) => f >= 0 && f <= data.length).sort((a, b) => fits(data, entries, b) - fits(data, entries, a))[0] ?? end;
  let out = "";
  entries.forEach((e, i) => {
    const start = firstAt + e.offset;
    const last = i === entries.length - 1;
    // The last object of a stream cut part way may be cut too.
    if (last && !whole) return;
    const stop = last ? data.length : firstAt + entries[i + 1].offset;
    if (start >= stop || stop > data.length) return;
    const body = data.slice(start, stop).trim();
    if (!body || !STARTS.test(body) || !oneValue(body)) return;
    out += `${e.num} 0 obj\n${body}\nendobj\n`;
  });
  return out;
}

/** True when pdf-lib reads the stream as it is: whole data, the count and start it names. */
function readsAsItIs(decoded: Uint8Array, count: number, first: number): boolean {
  const data = text(decoded.subarray(0, Math.min(decoded.length, first + 64 * 1024)));
  const { entries } = readHeader(data, count);
  return entries.length === count && first > 0 && fits(text(decoded), entries, first) === count;
}

const num = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)(?![\\d.]|\\s+\\d+\\s+R)`).exec(dict);
  return m ? Number(m[1]) : -1;
};

/**
 * `bytes` with every object stream that won't read as it is unpacked into
 * plain objects; `repaired` says whether any was.
 */
export function unpackObjectStreams(bytes: Uint8Array): { bytes: Uint8Array; repaired: boolean } {
  const pieces: Uint8Array[] = [];
  let copied = 0;
  for (let at = indexOf(bytes, OBJSTM); at >= 0; at = indexOf(bytes, OBJSTM, at + OBJSTM.length)) {
    // "/ObjStm" as a name of its own, after /Type, in a stream's dictionary.
    if (!isSpace(bytes[at + OBJSTM.length]) && !"/>".includes(String.fromCharCode(bytes[at + OBJSTM.length]))) continue;
    const back = text(bytes.subarray(Math.max(copied, at - 2048), at));
    const header = /(\d+)\s+(\d+)\s+obj\b(?![\s\S]*\bobj\b)/.exec(back);
    if (!header || !/\/Type\s*$/.test(back)) continue;
    const streamAt = indexOf(bytes, STREAM, at, at + 4096);
    if (streamAt < 0) continue;
    const dict = text(bytes.subarray(at - back.length + header.index, streamAt));
    // Only plain or Flate data, with no predictor (writers don't use one here).
    const filter = /\/Filter\s*\[?\s*\/(\w+)\s*\]?/.exec(dict)?.[1];
    if ((filter && filter !== "FlateDecode" && filter !== "Fl") || /\/Predictor\s+(\d+)/.test(dict) && num(dict, "Predictor") > 1) continue;

    let dataAt = streamAt + STREAM.length;
    if (bytes[dataAt] === 0x0d) dataAt++;
    if (bytes[dataAt] === 0x0a) dataAt++;
    // The length it names when "endstream" is there, or else wherever "endstream" is.
    const length = num(dict, "Length");
    const named = length >= 0 ? dataAt + length : -1;
    let dataEnd = named >= 0 && named <= bytes.length && /^\s*endstream/.test(text(bytes.subarray(named, named + 12))) ? named : indexOf(bytes, ENDSTREAM, dataAt);
    if (dataEnd < 0) dataEnd = bytes.length;
    const raw = bytes.subarray(dataAt, dataEnd);
    const count = num(dict, "N");
    const first = num(dict, "First");

    const decoded = filter ? inflate(raw) : { out: raw, whole: true, asItIs: true };
    if (!decoded) continue;
    if (decoded.asItIs && readsAsItIs(decoded.out, count, first)) continue;

    const objects = objectsOf(decoded.out, decoded.whole, count, first);
    const end = indexOf(bytes, ENDOBJ, dataEnd);
    if (!objects || end < 0) continue;
    const after = end + ENDOBJ.length;
    // The stream itself is renamed, so no reader tries it again; its objects follow it.
    pieces.push(bytes.subarray(copied, at), latin1("/ObjStx"), bytes.subarray(at + OBJSTM.length, after), latin1(`\n${objects}`));
    copied = after;
    at = after - OBJSTM.length;
  }
  if (!pieces.length) return { bytes, repaired: false };
  pieces.push(bytes.subarray(copied));
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of pieces) {
    out.set(p, k);
    k += p.length;
  }
  return { bytes: out, repaired: true };
}
