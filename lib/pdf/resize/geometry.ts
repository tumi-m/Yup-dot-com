/**
 * Where each page goes when a PDF is resized: the sheet sizes, the cells on
 * a sheet and the spot each page takes in its cell. Plain numbers in PDF
 * points (1/72 inch, origin at the bottom left) and nothing else, so the
 * tool and its preview lay pages out the same way.
 */

export type SizeName = "a4" | "a3" | "a5" | "letter" | "legal" | "tabloid" | "custom";
export type Unit = "mm" | "in" | "pt";
/** "auto" keeps each page's own orientation. */
export type Orientation = "auto" | "portrait" | "landscape";
/** Fit inside keeping proportions, fill and crop the edges, or keep the size. */
export type FitMode = "fit" | "fill" | "none";

export interface ResizeOptions {
  /** The sheet, in points, as given (either way round). */
  width: number;
  height: number;
  orientation: Orientation;
  fit: FitMode;
  /** Around the edge and between pages on a sheet, in points. */
  margin: number;
  /** Pages per sheet: 1 resizes, 2 and 4 put several pages on each sheet. */
  perSheet: 1 | 2 | 4;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MM = 72 / 25.4;

/** Paper sizes, short side first, in points. */
export const PAPER: Record<Exclude<SizeName, "custom">, { label: string; width: number; height: number }> = {
  a4: { label: "A4", width: 210 * MM, height: 297 * MM },
  a3: { label: "A3", width: 297 * MM, height: 420 * MM },
  a5: { label: "A5", width: 148 * MM, height: 210 * MM },
  letter: { label: "Letter", width: 612, height: 792 },
  legal: { label: "Legal", width: 612, height: 1008 },
  tabloid: { label: "Tabloid", width: 792, height: 1224 },
};

export const UNIT_POINTS: Record<Unit, number> = { mm: MM, in: 72, pt: 1 };

/** Readers refuse pages over 200 inches a side; under an inch there is nothing to read. */
export const MIN_SIDE = 72;
export const MAX_SIDE = 14400;

/** The margin choices, in millimetres. */
export const MARGINS_MM = [0, 5, 10, 20] as const;

function sideLimits(unit: Unit): string {
  const f = (pt: number) => {
    const v = pt / UNIT_POINTS[unit];
    return unit === "mm" ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  };
  return `${f(MIN_SIDE)} and ${f(MAX_SIDE)} ${unit}`;
}

/** A typed number: commas as decimal points too ("210,5"). */
function readNumber(text: string | undefined): number {
  const t = (text ?? "").trim().replace(",", ".");
  return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}

/**
 * The tool's form values as options. Throws a message for people when a
 * custom size can't be used.
 */
export function readOptions(o: Record<string, string | undefined>): ResizeOptions {
  const orientation: Orientation = o.orientation === "portrait" || o.orientation === "landscape" ? o.orientation : "auto";
  const fit: FitMode = o.fit === "fill" || o.fit === "none" ? o.fit : "fit";
  const perSheet = o.perSheet === "2" ? 2 : o.perSheet === "4" ? 4 : 1;
  const marginMm = Number(o.margin);
  const margin = (MARGINS_MM as readonly number[]).includes(marginMm) ? marginMm * MM : 0;
  let width: number;
  let height: number;
  if (o.size === "custom") {
    const unit: Unit = o.unit === "in" || o.unit === "pt" ? o.unit : "mm";
    width = readNumber(o.width) * UNIT_POINTS[unit];
    height = readNumber(o.height) * UNIT_POINTS[unit];
    // A hair of rounding (a typed 25.4 mm is 72.000…1 pt) must not refuse the limits.
    const ok = (v: number) => Number.isFinite(v) && v >= MIN_SIDE - 0.01 && v <= MAX_SIDE + 0.01;
    if (!ok(width) || !ok(height)) throw new Error(`Enter a width and height between ${sideLimits(unit)}.`);
    width = Math.min(MAX_SIDE, Math.max(MIN_SIDE, width));
    height = Math.min(MAX_SIDE, Math.max(MIN_SIDE, height));
  } else {
    const paper = PAPER[(o.size as keyof typeof PAPER) ?? "a4"] ?? PAPER.a4;
    width = paper.width;
    height = paper.height;
  }
  return { width, height, orientation, fit, margin, perSheet };
}

/** Columns and rows of pages on a sheet. */
export function grid(perSheet: 1 | 2 | 4, sheet: { width: number; height: number }): { cols: number; rows: number } {
  if (perSheet === 4) return { cols: 2, rows: 2 };
  if (perSheet === 2) return sheet.width >= sheet.height ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
  return { cols: 1, rows: 1 };
}

/**
 * The sheet for a page (the first of the sheet's pages) of `first` size as
 * shown. Keeping the page's own orientation puts two pages side by side on
 * a sheet turned the other way, as printed 2-up handouts are.
 */
export function sheetFor(first: { width: number; height: number }, opts: ResizeOptions): { width: number; height: number } {
  const short = Math.min(opts.width, opts.height);
  const long = Math.max(opts.width, opts.height);
  let landscape: boolean;
  if (opts.orientation === "portrait") landscape = false;
  else if (opts.orientation === "landscape") landscape = true;
  else {
    landscape = first.width > first.height;
    if (opts.perSheet === 2) landscape = !landscape;
  }
  // A square custom sheet is the same both ways.
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** The cells on a sheet, left to right and then top to bottom. */
export function cells(sheet: { width: number; height: number }, opts: ResizeOptions): Box[] {
  const { cols, rows } = grid(opts.perSheet, sheet);
  const m = opts.margin;
  const width = (sheet.width - m * 2 - m * (cols - 1)) / cols;
  const height = (sheet.height - m * 2 - m * (rows - 1)) / rows;
  // A page squeezed under half an inch is no use to anyone.
  if (width < 36 || height < 36) throw new Error("The margins leave no room for the pages. Pick a smaller margin or a bigger size.");
  const out: Box[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out.push({ x: m + col * (width + m), y: sheet.height - m - (row + 1) * height - row * m, width, height });
    }
  }
  return out;
}

/** Where a page of `page` size as shown goes in `cell`: its bottom-left corner and scale. */
export function place(page: { width: number; height: number }, cell: Box, fit: FitMode): { x: number; y: number; scale: number } {
  const w = Math.max(page.width, 1);
  const h = Math.max(page.height, 1);
  const scale = fit === "none" ? 1 : (fit === "fill" ? Math.max : Math.min)(cell.width / w, cell.height / h);
  return { x: cell.x + (cell.width - w * scale) / 2, y: cell.y + (cell.height - h * scale) / 2, scale };
}

export interface Placed {
  /** The page's index in the document. */
  page: number;
  x: number;
  y: number;
  scale: number;
  /** What shows of it: its cell. */
  clip: Box;
}

export interface Sheet {
  width: number;
  height: number;
  pages: Placed[];
}

/** Every sheet of the result for pages of these sizes, as shown (rotation applied). */
export function layout(pages: { width: number; height: number }[], opts: ResizeOptions): Sheet[] {
  const sheets: Sheet[] = [];
  for (let first = 0; first < pages.length; first += opts.perSheet) {
    const sheet = sheetFor(pages[first], opts);
    const boxes = cells(sheet, opts);
    const placed: Placed[] = [];
    for (let k = 0; k < boxes.length && first + k < pages.length; k++) {
      placed.push({ page: first + k, ...place(pages[first + k], boxes[k], opts.fit), clip: boxes[k] });
    }
    sheets.push({ ...sheet, pages: placed });
  }
  return sheets;
}

/** "210 × 297 mm", or inches for the US sizes. */
export function describeSize(width: number, height: number, unit: Unit = "mm"): string {
  const f = (pt: number) => {
    const v = pt / UNIT_POINTS[unit];
    return unit === "mm" ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
  };
  return `${f(width)} × ${f(height)} ${unit}`;
}

/** The paper a size is, either way round, if it is one. */
export function paperName(width: number, height: number): string | undefined {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  for (const paper of Object.values(PAPER)) {
    if (Math.abs(paper.width - short) < 2 && Math.abs(paper.height - long) < 2) return paper.label;
  }
  return undefined;
}
