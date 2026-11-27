/**
 * Colour for PDF/A: an output intent with an ICC profile, so device colours
 * (DeviceRGB, DeviceGray, DeviceCMYK) have a defined meaning, and checks on
 * the colour profiles and JPEG 2000 pictures a file already has.
 *
 * The output intent is sRGB, unless the file already carries a sound RGB or
 * CMYK one (a print file's PDF/X profile), which is kept so its colours stay
 * as they were. Colours the output intent doesn't cover are given a default
 * colour space where they are drawn (PDF/A 6.2.4.3): DeviceCMYK under sRGB
 * becomes the usual CMYK to RGB formula (C, M, Y and K inks over white), and
 * DeviceRGB under a CMYK profile becomes sRGB.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFDocument, type PDFObject } from "pdf-lib";
import { SRGB_NAME, srgbProfile } from "./srgb";
import { streamBytes } from "./content";

const N = PDFName.of;

export interface Profile {
  /** Device class: "mntr", "prtr", "scnr", "spac"… */
  kind: string;
  /** Colour space: "RGB ", "CMYK", "GRAY", "Lab "… */
  space: string;
  /** Major version. */
  version: number;
}

/** An ICC profile's header, or null when it isn't one. */
export function readProfile(bytes: Uint8Array | null): Profile | null {
  if (!bytes || bytes.length < 128) return null;
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(36) !== "acsp") return null;
  return { kind: tag(12), space: tag(16), version: bytes[8] };
}

const COMPONENTS: Record<string, number> = { "RGB ": 3, CMYK: 4, GRAY: 1, "Lab ": 3 };

/** Whether a profile may be an ICCBased colour space in PDF/A (6.2.4.2). */
export function goodInputProfile(p: Profile | null, n: number | undefined): boolean {
  return !!p && ["prtr", "mntr", "scnr", "spac"].includes(p.kind) && p.space in COMPONENTS && p.version < 5 && (n === undefined || COMPONENTS[p.space] === n);
}

/** Whether a profile may be the output intent's (6.2.3). */
export function goodOutputProfile(p: Profile | null): boolean {
  return !!p && (p.kind === "prtr" || p.kind === "mntr") && ["RGB ", "CMYK", "GRAY"].includes(p.space) && p.version < 5;
}

export interface Intent {
  /** The output intent's profile stream. */
  ref: PDFRef;
  space: "RGB " | "CMYK";
  /** It is our sRGB profile rather than one the file had. */
  ours: boolean;
}

/** An sRGB profile stream, added once per document. */
const srgbRefs = new WeakMap<PDFDocument, PDFRef>();
export function srgbRef(doc: PDFDocument): PDFRef {
  let ref = srgbRefs.get(doc);
  if (!ref) {
    const bytes = srgbProfile();
    ref = doc.context.register(doc.context.flateStream(bytes, { N: 3 }));
    srgbRefs.set(doc, ref);
  }
  return ref;
}

/**
 * Sets the document's PDF/A output intent: a sound RGB or CMYK one the file
 * already has, or sRGB. Other output intents are kept only when they share
 * its profile, as PDF/A asks (6.2.3).
 */
export function setOutputIntent(doc: PDFDocument): Intent {
  const ctx = doc.context;
  const list = doc.catalog.lookup(N("OutputIntents"));
  const old: PDFDict[] = [];
  if (list instanceof PDFArray) for (let i = 0; i < list.size(); i++) {
    const oi = list.lookup(i);
    if (oi instanceof PDFDict) old.push(oi);
  }
  let chosen: Intent | null = null;
  for (const oi of old) {
    const raw = oi.get(N("DestOutputProfile"));
    if (!(raw instanceof PDFRef)) continue;
    const stream = ctx.lookup(raw);
    if (!(stream instanceof PDFStream)) continue;
    const p = readProfile(streamBytes(stream));
    if (goodOutputProfile(p) && (p!.space === "RGB " || p!.space === "CMYK")) {
      chosen = { ref: raw, space: p!.space as Intent["space"], ours: false };
      break;
    }
  }
  chosen ??= { ref: srgbRef(doc), space: "RGB ", ours: true };
  const intent = ctx.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of(chosen.ours ? SRGB_NAME : "Custom"),
    Info: PDFString.of(chosen.ours ? SRGB_NAME : "Output profile of the original file"),
    RegistryName: PDFString.of("http://www.color.org"),
    DestOutputProfile: chosen.ref,
  });
  const kept = old.filter((oi) => oi.lookup(N("S")) !== N("GTS_PDFA1") && oi.get(N("DestOutputProfile")) === chosen!.ref);
  doc.catalog.set(N("OutputIntents"), ctx.obj([intent, ...kept]));
  return chosen;
}

/**
 * DeviceCMYK read through the CMYK to RGB formula: a DeviceN space of the
 * four inks over sRGB, with a sampled function at the 16 corners
 * (multilinear between them, which is the formula exactly).
 */
function cmykDefault(doc: PDFDocument): PDFArray {
  const samples = new Uint8Array(48);
  for (let i = 0; i < 16; i++) {
    const [c, m, y, k] = [i & 1, (i >> 1) & 1, (i >> 2) & 1, (i >> 3) & 1];
    samples[i * 3] = 255 * (1 - c) * (1 - k);
    samples[i * 3 + 1] = 255 * (1 - m) * (1 - k);
    samples[i * 3 + 2] = 255 * (1 - y) * (1 - k);
  }
  const ctx = doc.context;
  const fn = ctx.register(
    ctx.stream(samples, { FunctionType: 0, Domain: [0, 1, 0, 1, 0, 1, 0, 1], Range: [0, 1, 0, 1, 0, 1], Size: [2, 2, 2, 2], BitsPerSample: 8 })
  );
  return ctx.obj([N("DeviceN"), ctx.obj([N("Cyan"), N("Magenta"), N("Yellow"), N("Black")]), ctx.obj([N("ICCBased"), srgbRef(doc)]), fn]);
}

/**
 * Gives every resource dictionary content draws with the default colour
 * space PDF/A needs for device colours the output intent doesn't cover.
 * Returns which were added.
 */
export function addDefaults(doc: PDFDocument, intent: Intent, resources: Iterable<PDFDict>, uses: { cmyk: boolean; rgb: boolean }) {
  const ctx = doc.context;
  const cmyk = intent.space !== "CMYK" && uses.cmyk ? ctx.register(cmykDefault(doc)) : null;
  const rgb = intent.space !== "RGB " && uses.rgb ? ctx.register(ctx.obj([N("ICCBased"), srgbRef(doc)])) : null;
  if (!cmyk && !rgb) return { cmyk: false, rgb: false };
  for (const res of resources) {
    let spaces = res.lookup(N("ColorSpace"));
    if (!(spaces instanceof PDFDict)) {
      spaces = ctx.obj({});
      res.set(N("ColorSpace"), spaces);
    }
    const d = spaces as PDFDict;
    if (cmyk && !d.has(N("DefaultCMYK"))) d.set(N("DefaultCMYK"), cmyk);
    if (rgb && !d.has(N("DefaultRGB"))) d.set(N("DefaultRGB"), rgb);
  }
  return { cmyk: !!cmyk, rgb: !!rgb };
}

/** True when the file names a device colour space anywhere outside content (images, shadings, colour spaces). */
export function namesDevice(doc: PDFDocument): { cmyk: boolean; rgb: boolean } {
  const out = { cmyk: false, rgb: false };
  const cmyk = N("DeviceCMYK");
  const rgb = N("DeviceRGB");
  const visit = (o: PDFObject | undefined, depth: number) => {
    if (depth > 8 || (out.cmyk && out.rgb)) return;
    if (o === cmyk) out.cmyk = true;
    else if (o === rgb) out.rgb = true;
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v, depth + 1);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj instanceof PDFStream ? obj.dict : obj, 0);
  return out;
}

/**
 * ICC profiles of ICCBased colour spaces PDF/A won't accept (a newer
 * version, or a component count that doesn't match): an RGB one becomes
 * sRGB. Returns how many could not be put right.
 */
export function fixInputProfiles(doc: PDFDocument): number {
  let unfixed = 0;
  const done = new Set<PDFRef>();
  const ctx = doc.context;
  const check = (arr: PDFArray) => {
    if (arr.size() < 2 || arr.lookup(0) !== N("ICCBased")) return;
    const ref = arr.get(1);
    if (!(ref instanceof PDFRef) || done.has(ref)) return;
    done.add(ref);
    const stream = ctx.lookup(ref);
    if (!(stream instanceof PDFStream)) return;
    const n = stream.dict.lookup(N("N"));
    const count = n instanceof PDFNumber ? n.asNumber() : undefined;
    const p = readProfile(streamBytes(stream));
    if (goodInputProfile(p, count)) return;
    if (count === 3) ctx.assign(ref, ctx.flateStream(srgbProfile(), { N: 3 }));
    else unfixed++;
  };
  const visit = (o: PDFObject | undefined, depth: number) => {
    if (depth > 8) return;
    if (o instanceof PDFArray) {
      check(o);
      for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1);
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v, depth + 1);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj instanceof PDFStream ? obj.dict : obj, 0);
  return unfixed;
}

/** A group's blending colour space the output intent covers (pages and forms with transparency). */
export function fixGroupSpace(group: PDFDict, doc: PDFDocument, intent: Intent) {
  const cs = group.lookup(N("CS"));
  if ((cs === N("DeviceCMYK") && intent.space !== "CMYK") || (cs === N("DeviceRGB") && intent.space !== "RGB ")) {
    group.set(N("CS"), doc.context.obj([N("ICCBased"), srgbRef(doc)]));
  }
}

/**
 * Whether a JPEG 2000 picture is one PDF/A-2 accepts (6.2.8.3): 1, 3 or 4
 * colour channels, one bit depth for all of them, and, when the image has no
 * ColorSpace of its own, a colour specification readers can use.
 */
export function jpxOk(data: Uint8Array, hasColorSpace: boolean): boolean {
  const u32 = (o: number) => ((data[o] << 24) >>> 0) + ((data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]);
  const tag = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  // A bare codestream: the SIZ marker gives the components and their depths.
  if (data[0] === 0xff && data[1] === 0x4f) {
    if (data[2] !== 0xff || data[3] !== 0x51) return false;
    const count = (data[40] << 8) | data[41];
    const depths = new Set<number>();
    for (let i = 0; i < count; i++) depths.add((data[42 + i * 3] & 0x7f) + 1);
    return [1, 3, 4].includes(count) && depths.size === 1 && hasColorSpace;
  }
  let channels = 0;
  let depth = 0;
  let bpcc = false;
  const colr: { meth: number; approx: number; enumCs: number | null }[] = [];
  const walk = (from: number, to: number, level: number) => {
    let at = from;
    while (at + 8 <= to && level < 4) {
      let length = u32(at);
      const type = tag(at + 4);
      let head = 8;
      if (length === 1) {
        length = u32(at + 12);
        head = 16;
      } else if (length === 0) length = to - at;
      if (length < head || at + length > to) return;
      const body = at + head;
      if (type === "jp2h") walk(body, at + length, level + 1);
      else if (type === "ihdr") {
        channels = (data[body + 8] << 8) | data[body + 9];
        depth = data[body + 10] === 0xff ? -1 : (data[body + 10] & 0x7f) + 1;
      } else if (type === "bpcc") bpcc = true;
      else if (type === "colr") colr.push({ meth: data[body], approx: data[body + 2], enumCs: data[body] === 1 ? u32(body + 3) : null });
      else if (type === "jp2c") return;
      at += length;
    }
  };
  walk(0, data.length, 0);
  if (![1, 3, 4].includes(channels) || bpcc || depth < 1 || depth > 38) return false;
  if (hasColorSpace) return true;
  if (colr.length > 1 && colr.filter((c) => c.approx === 1).length !== 1) return false;
  const used = colr.length > 1 ? colr.find((c) => c.approx === 1)! : colr[0];
  return !!used && [1, 2, 3].includes(used.meth) && used.enumCs !== 19;
}

/** The raw bytes of a JPX image (its data is never filtered twice in practice). */
export function jpxBytes(stream: PDFStream): Uint8Array | null {
  if (!(stream instanceof PDFRawStream)) return null;
  const filter = stream.dict.lookup(N("Filter"));
  const only = filter instanceof PDFName ? filter : filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0) : null;
  return only === N("JPXDecode") ? stream.contents : null;
}
