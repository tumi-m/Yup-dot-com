/**
 * Works out how large each image is drawn. Page content, Form XObjects (with
 * their /Matrix and /Resources), tiling patterns, soft masks and annotation
 * appearances are followed while tracking q/Q/cm, so an image's resolution can
 * be judged by the size it is actually shown at.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { scanContent } from "./lexer";
import { decodeFully } from "./streams";

export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m then n: points go through m first. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const N = {
  BBox: PDFName.of("BBox"),
  Contents: PDFName.of("Contents"),
  CropBox: PDFName.of("CropBox"),
  ExtGState: PDFName.of("ExtGState"),
  Form: PDFName.of("Form"),
  G: PDFName.of("G"),
  Image: PDFName.of("Image"),
  Kids: PDFName.of("Kids"),
  Matrix: PDFName.of("Matrix"),
  MediaBox: PDFName.of("MediaBox"),
  Pages: PDFName.of("Pages"),
  Pattern: PDFName.of("Pattern"),
  PatternType: PDFName.of("PatternType"),
  Resources: PDFName.of("Resources"),
  SMask: PDFName.of("SMask"),
  Subtype: PDFName.of("Subtype"),
  UserUnit: PDFName.of("UserUnit"),
  XObject: PDFName.of("XObject"),
  Annots: PDFName.of("Annots"),
  AP: PDFName.of("AP"),
  Rect: PDFName.of("Rect"),
};

export const asDict = (o: PDFObject | undefined) => (o instanceof PDFDict ? o : undefined);

function numbers(o: PDFObject | undefined, context: PDFContext, count: number): number[] | null {
  if (!(o instanceof PDFArray) || o.size() < count) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = context.lookup(o.get(i));
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out.every(Number.isFinite) ? out : null;
}

function matrixOf(dict: PDFDict): Matrix {
  return (numbers(dict.lookup(N.Matrix), dict.context, 6) as Matrix | null) ?? IDENTITY;
}

export interface PageInfo {
  dict: PDFDict;
  resources?: PDFDict;
  /** Visible size in points (user units × /UserUnit). */
  width: number;
  height: number;
  userUnit: number;
}

/** Every page in order, with inherited resources and boxes resolved. */
export function listPages(context: PDFContext): PageInfo[] {
  const catalog = asDict(context.lookup(context.trailerInfo.Root));
  const pages: PageInfo[] = [];
  const seen = new Set<PDFDict>();
  type Inherited = { resources?: PDFDict; media?: number[] | null; crop?: number[] | null };
  const visit = (node: PDFObject | undefined, inherited: Inherited) => {
    if (!(node instanceof PDFDict) || seen.has(node)) return;
    seen.add(node);
    const here: Inherited = {
      resources: asDict(node.lookup(N.Resources)) ?? inherited.resources,
      media: numbers(node.lookup(N.MediaBox), context, 4) ?? inherited.media,
      crop: numbers(node.lookup(N.CropBox), context, 4) ?? inherited.crop,
    };
    const kids = node.lookup(N.Kids);
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i), here);
      return;
    }
    const box = here.media ?? [0, 0, 612, 792];
    const size = (b: number[]) => [Math.abs(b[2] - b[0]), Math.abs(b[3] - b[1])];
    let [w, h] = size(box);
    if (here.crop) {
      const [cw, ch] = size(here.crop);
      w = Math.min(w, cw);
      h = Math.min(h, ch);
    }
    const unit = node.lookup(N.UserUnit);
    const userUnit = unit instanceof PDFNumber && unit.asNumber() > 0 ? unit.asNumber() : 1;
    pages.push({ dict: node, resources: here.resources, width: w * userUnit, height: h * userUnit, userUnit });
  };
  visit(catalog?.lookup(N.Pages), {});
  return pages;
}

/** Largest size an image is shown at, in points, along its own x and y axes. */
export interface Shown {
  w: number;
  h: number;
}

export interface Placements {
  shown: Map<PDFRef, Shown>;
  /** XObject dictionaries of every resource set that was followed. */
  walked: Set<PDFDict>;
  /** False when some content couldn't be read; then sizes are incomplete. */
  complete: boolean;
}

// Program steps: only what matters for placement is kept.
type Step =
  | { k: "q" }
  | { k: "Q" }
  | { k: "cm"; m: Matrix }
  | { k: "Do"; name: string }
  | { k: "gs"; name: string }
  | { k: "pattern"; name: string };

const STEP_BUDGET = 4_000_000;
const MAX_DEPTH = 24;

export function findPlacements(context: PDFContext, pages: PageInfo[]): Placements {
  const shown = new Map<PDFRef, Shown>();
  const walked = new Set<PDFDict>();
  const programs = new Map<PDFRawStream, Step[]>();
  const active = new Set<PDFRef>();
  let budget = STEP_BUDGET;

  const compile = (bytes: Uint8Array): Step[] => {
    const steps: Step[] = [];
    const whole = scanContent(bytes, (op, args) => {
      switch (op) {
        case "q":
          steps.push({ k: "q" });
          break;
        case "Q":
          steps.push({ k: "Q" });
          break;
        case "cm": {
          const m = args.slice(-6);
          if (m.length === 6 && m.every((v) => typeof v === "number")) steps.push({ k: "cm", m: m as Matrix });
          break;
        }
        case "Do":
        case "gs": {
          const name = args[args.length - 1];
          if (typeof name === "string") steps.push({ k: op, name });
          break;
        }
        case "scn":
        case "SCN": {
          const name = args[args.length - 1];
          if (typeof name === "string") steps.push({ k: "pattern", name });
          break;
        }
      }
    });
    // Sizes read past an inline image of uncertain length could be wrong.
    if (!whole) throw new Error("unclear inline image");
    return steps;
  };

  const programOf = (stream: PDFRawStream): Step[] => {
    let steps = programs.get(stream);
    if (!steps) {
      const bytes = decodeFully(context, stream);
      if (!bytes) throw new Error("unreadable content");
      steps = compile(bytes);
      programs.set(stream, steps);
    }
    return steps;
  };

  const record = (ref: PDFRef, m: Matrix, userUnit: number) => {
    const w = Math.hypot(m[0], m[1]) * userUnit;
    const h = Math.hypot(m[2], m[3]) * userUnit;
    const prev = shown.get(ref);
    shown.set(ref, prev ? { w: Math.max(prev.w, w), h: Math.max(prev.h, h) } : { w, h });
  };

  /** Runs a form, pattern or appearance stream drawn with `outer` as the CTM. */
  const runStream = (ref: PDFObject | undefined, outer: Matrix, inherited: PDFDict | undefined, userUnit: number) => {
    if (!(ref instanceof PDFRef) || active.has(ref) || active.size > MAX_DEPTH) return;
    const stream = context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return;
    const resources = asDict(stream.dict.lookup(N.Resources)) ?? inherited;
    active.add(ref);
    run(programOf(stream), resources, multiply(matrixOf(stream.dict), outer), userUnit);
    active.delete(ref);
  };

  const run = (steps: Step[], resources: PDFDict | undefined, base: Matrix, userUnit: number) => {
    const xobjects = asDict(resources?.lookup(N.XObject));
    if (xobjects) walked.add(xobjects);
    const saved: Matrix[] = [];
    let m = base;
    for (const step of steps) {
      if (--budget < 0) throw new Error("too much content");
      switch (step.k) {
        case "q":
          saved.push(m);
          break;
        case "Q":
          if (saved.length) m = saved.pop()!;
          break;
        case "cm":
          m = multiply(step.m, m);
          break;
        case "Do": {
          const ref = xobjects?.get(PDFName.of(step.name));
          const target = ref instanceof PDFRef ? context.lookup(ref) : undefined;
          if (!(target instanceof PDFStream)) break;
          const subtype = target.dict.lookup(N.Subtype);
          if (subtype === N.Image) record(ref as PDFRef, m, userUnit);
          else if (subtype === N.Form) runStream(ref, m, resources, userUnit);
          break;
        }
        case "gs": {
          // A soft mask's group is drawn with the CTM in effect when it is set.
          const states = asDict(resources?.lookup(N.ExtGState));
          const mask = asDict(states?.lookup(PDFName.of(step.name)))?.lookup(N.SMask);
          if (mask instanceof PDFDict) runStream(mask.get(N.G), m, resources, userUnit);
          break;
        }
        case "pattern": {
          // Tiling pattern cells sit in the default space of this stream.
          const patterns = asDict(resources?.lookup(N.Pattern));
          const ref = patterns?.get(PDFName.of(step.name));
          const pattern = ref instanceof PDFRef ? context.lookup(ref) : undefined;
          if (pattern instanceof PDFStream && pattern.dict.lookup(N.PatternType) instanceof PDFNumber) {
            runStream(ref, base, resources, userUnit);
          }
          break;
        }
      }
    }
  };

  const concatContents = (contents: PDFObject | undefined): Uint8Array => {
    const parts: Uint8Array[] = [];
    const add = (o: PDFObject | undefined) => {
      const s = o instanceof PDFRef ? context.lookup(o) : o;
      if (s instanceof PDFRawStream) {
        const bytes = decodeFully(context, s);
        if (!bytes) throw new Error("unreadable content");
        parts.push(bytes, new Uint8Array([10]));
      }
    };
    const c = contents instanceof PDFRef ? context.lookup(contents) : contents;
    if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) add(c.get(i));
    else add(contents);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  try {
    for (const page of pages) {
      run(compile(concatContents(page.dict.get(N.Contents))), page.resources, IDENTITY, page.userUnit);
      const annots = page.dict.lookup(N.Annots);
      if (!(annots instanceof PDFArray)) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annot = asDict(annots.lookup(i));
        const rect = annot && numbers(annot.lookup(N.Rect), context, 4);
        const ap = asDict(annot?.lookup(N.AP));
        if (!rect || !ap) continue;
        for (const [, entry] of ap.entries()) {
          // An appearance is a stream, or a dictionary of streams by state.
          const value = entry instanceof PDFRef ? context.lookup(entry) : entry;
          const refs = value instanceof PDFDict && !(value instanceof PDFStream) ? value.values() : [entry];
          for (const ref of refs) {
            const form = ref instanceof PDFRef ? context.lookup(ref) : undefined;
            const toRect = form instanceof PDFStream ? appearanceMatrix(form.dict, rect) : null;
            if (toRect) runStream(ref, toRect, undefined, page.userUnit);
          }
        }
      }
    }
  } catch {
    return { shown, walked, complete: false };
  }
  return { shown, walked, complete: true };
}

/**
 * The matrix that fits an appearance stream's box into its annotation's
 * rectangle, before the stream's own /Matrix (PDF 32000 §12.5.5).
 */
function appearanceMatrix(form: PDFDict, rect: number[]): Matrix | null {
  const box = numbers(form.lookup(N.BBox), form.context, 4);
  if (!box) return null;
  const m = matrixOf(form);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const bw = Math.max(...xs) - minX;
  const bh = Math.max(...ys) - minY;
  if (!(bw > 0 && bh > 0)) return null;
  const rx = Math.min(rect[0], rect[2]);
  const ry = Math.min(rect[1], rect[3]);
  const sx = Math.abs(rect[2] - rect[0]) / bw;
  const sy = Math.abs(rect[3] - rect[1]) / bh;
  return [sx, 0, 0, sy, rx - minX * sx, ry - minY * sy];
}
