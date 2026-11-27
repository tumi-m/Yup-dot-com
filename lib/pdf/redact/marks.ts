/**
 * Redact PDF's marks: the areas to black out on each page, found by drawing
 * a box, by searching the text, or by a preset (emails, phone numbers, card
 * numbers…). Plain numbers and strings only, so it loads with the page and
 * Node tests run it as it is.
 *
 * Every place is in displayed points from the page's top-left corner (the
 * visible box with /Rotate applied), as pdf.js shows the page.
 *
 * pdf.js gives each run of text one box, not one per letter. Where a match
 * starts and ends inside a run comes from the font's own letter widths once
 * the page's drawing has been read (page-text.ts), and from typical widths
 * until then. Search marks are padded a little either way; the page preview
 * shows what will be painted, and the result is checked for the text
 * afterwards.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Which way a run's letters go on the page as shown. */
export type Flow = "right" | "left" | "down" | "up" | "angled";

/** A run of text on a page, as pdf.js reads it. */
export interface TextRun {
  str: string;
  rect: Rect;
  flow: Flow;
  /** The run ends a line. */
  eol: boolean;
  /** Every letter is as wide as the next. */
  mono?: boolean;
  /** Where each UTF-16 unit starts and ends along the line, from the font's own widths: x for lines across, y for lines down. */
  spans?: [number, number][];
  /** pdf.js's name for its font, its text matrix (font size included) in PDF user space, and its length along the line there. */
  font?: string;
  matrix?: number[];
  width?: number;
  /** pdf.js read it as right-to-left text, or it is in a font written top to bottom. */
  rtl?: boolean;
  vertical?: boolean;
  /** The drawn glyphs its letters lined up with: from the first to just before the second. */
  glyphs?: [number, number];
  /** The glyph each UTF-16 unit came from, -1 for a space pdf.js put in. */
  units?: number[];
}

/** Text a comment, link or form field holds, and where it sits. */
export interface NoteText {
  text: string;
  rect: Rect;
}

export interface PageText {
  runs: TextRun[];
  notes: NoteText[];
  /** Text drawn wholly outside the visible area (cropped off): no reader shows it, but it is in the file. */
  hidden?: TextRun[];
  /** The runs' letters are placed with the font's own widths. */
  exact?: boolean;
  /** The page as shown, in points: a match wholly off it is text outside the visible area too. */
  size?: { width: number; height: number };
}

export type PresetId = "email" | "phone" | "card" | "id" | "account" | "date";
export type MarkKind = "box" | "search" | PresetId;

export interface Mark {
  id: string;
  /** 0-indexed. */
  page: number;
  rects: Rect[];
  kind: MarkKind;
  /** What was found, or the words under a box (may be empty). */
  text: string;
  /** Found as a whole word: copies inside longer words aren't the same text. */
  whole: boolean;
  /** Ticked in the list: blacked out when the file is made. */
  on: boolean;
  /** Text outside the visible area: nothing to paint, but its page is rebuilt from what shows, which leaves it out. */
  hidden?: boolean;
  /** Found in a comment, link or field: the box is the whole of it, painted as it is. */
  note?: boolean;
}

export interface SearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

export const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

export function overlap(a: Rect, b: Rect): number {
  return area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
}

export const touches = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export const grow = (r: Rect, dx: number, dy = dx): Rect => ({ x0: r.x0 - dx, y0: r.y0 - dy, x1: r.x1 + dx, y1: r.y1 + dy });

export const union = (a: Rect, b: Rect): Rect => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});

const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/** `r` kept to a page of `width` × `height`. */
export function clampRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(width, Math.min(r.x0, r.x1)));
  const x1 = Math.max(0, Math.min(width, Math.max(r.x0, r.x1)));
  const y0 = Math.max(0, Math.min(height, Math.min(r.y0, r.y1)));
  const y1 = Math.max(0, Math.min(height, Math.max(r.y0, r.y1)));
  return { x0, y0, x1, y1 };
}

// --- Letter widths ------------------------------------------------------------

/** Helvetica's widths for space to tilde, in thousandths of the font size: close enough for most text fonts. */
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278,
  278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function widthOf(code: number): number {
  if (code >= 32 && code <= 126) return WIDTHS[code - 32];
  if (code >= 0xdc00 && code <= 0xdfff) return 0; // the second half of a pair
  if (code >= 0x300 && code <= 0x36f) return 0; // accents that sit on a letter
  // Chinese, Japanese and Korean letters are square.
  if ((code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60)) return 1000;
  return 556;
}

/** A box for each UTF-16 unit of `run.str`: where the font puts it, or shared out along the run in proportion to typical widths. */
export function letterBoxes(run: TextRun): Rect[] {
  const { str, rect, flow } = run;
  const n = str.length;
  if (!n) return [];
  if (flow === "angled") return Array.from({ length: n }, () => rect);
  if (run.spans?.length === n) {
    const across = flow === "right" || flow === "left";
    return run.spans.map(([a, b]) => (across ? { x0: a, y0: rect.y0, x1: b, y1: rect.y1 } : { x0: rect.x0, y0: a, x1: rect.x1, y1: b }));
  }
  const widths = Array.from(str, () => 0);
  for (let i = 0; i < n; i++) widths[i] = run.mono ? (str.charCodeAt(i) >= 0xdc00 && str.charCodeAt(i) <= 0xdfff ? 0 : 1) : widthOf(str.charCodeAt(i));
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const along = flow === "right" || flow === "left";
  const start = along ? rect.x0 : rect.y0;
  const length = along ? rect.x1 - rect.x0 : rect.y1 - rect.y0;
  const reversed = flow === "left" || flow === "up";
  const out: Rect[] = [];
  let done = 0;
  for (let i = 0; i < n; i++) {
    let a = start + (length * done) / total;
    done += widths[i];
    let b = start + (length * done) / total;
    if (reversed) [a, b] = [start + length - (b - start), start + length - (a - start)];
    out.push(along ? { x0: a, y0: rect.y0, x1: b, y1: rect.y1 } : { x0: rect.x0, y0: a, x1: rect.x1, y1: b });
  }
  return out;
}

/** The box round letters `from` to `to` (exclusive) of a run. */
export function spanBox(run: TextRun, from: number, to: number): Rect | null {
  const boxes = letterBoxes(run).slice(from, to);
  if (!boxes.length) return null;
  return boxes.reduce(union);
}

/** The words of a run, each with its box. A run that isn't straight is one piece. */
export function wordsOf(run: TextRun): { text: string; rect: Rect }[] {
  if (run.flow === "angled") return run.str.trim() ? [{ text: run.str.trim(), rect: run.rect }] : [];
  const out: { text: string; rect: Rect }[] = [];
  for (const m of run.str.matchAll(/\S+/g)) {
    const box = spanBox(run, m.index!, m.index! + m[0].length);
    if (box) out.push({ text: m[0], rect: box });
  }
  return out;
}

// --- The page as one string ---------------------------------------------------

/** A page's text in reading order, with where each letter came from (-1: a space put between runs). */
export interface PageString {
  text: string;
  /** For each UTF-16 unit of `text`: [run index, letter index], or null. */
  at: ([number, number] | null)[];
}

export function pageString(page: PageText): PageString {
  let text = "";
  const at: PageString["at"] = [];
  page.runs.forEach((run, r) => {
    if (r > 0) {
      const prev = page.runs[r - 1];
      // Runs that don't touch get a space, so words in them don't run together.
      const gap = prev.eol ? "\n" : apart(prev, run) ? " " : "";
      if (gap && !/\s$/.test(text) && !/^\s/.test(run.str)) {
        text += gap;
        at.push(null);
      }
    }
    for (let i = 0; i < run.str.length; i++) {
      text += run.str[i];
      at.push([r, i]);
    }
  });
  return { text, at };
}

/** Two runs in a row are separate words: on different lines, or with a gap between them. */
function apart(a: TextRun, b: TextRun): boolean {
  const h = Math.max(1, Math.min(a.rect.y1 - a.rect.y0, b.rect.y1 - b.rect.y0));
  if (a.flow !== "right" || b.flow !== "right") return true;
  const sameLine = Math.abs((a.rect.y0 + a.rect.y1) / 2 - (b.rect.y0 + b.rect.y1) / 2) < h * 0.5;
  return !sameLine || b.rect.x0 - a.rect.x1 > h * 0.15 || b.rect.x0 < a.rect.x0;
}

/** The boxes round `text` from `from` to `to` in a page string: one per run it touches. */
export function boxesFor(page: PageText, s: PageString, from: number, to: number): Rect[] {
  const spans = new Map<number, [number, number]>();
  for (let i = from; i < to; i++) {
    const where = s.at[i];
    if (!where || /\s/.test(s.text[i])) continue;
    const [r, k] = where;
    const span = spans.get(r);
    spans.set(r, span ? [Math.min(span[0], k), Math.max(span[1], k + 1)] : [k, k + 1]);
  }
  const out: Rect[] = [];
  for (const [r, [a, b]] of spans) {
    const run = page.runs[r];
    const box = spanBox(run, a, b);
    if (!box) continue;
    // A little round each match: the letters' real widths aren't known.
    const h = run.flow === "right" || run.flow === "left" ? box.y1 - box.y0 : box.x1 - box.x0;
    const pad = Math.max(0.75, h * 0.12);
    out.push(run.flow === "right" || run.flow === "left" ? grow(box, pad, 0.5) : grow(box, 0.5, pad));
  }
  return mergeLines(out);
}

/** Boxes on one line that touch become one. */
function mergeLines(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const same = out.findIndex((o) => {
      const h = Math.min(o.y1 - o.y0, r.y1 - r.y0);
      return Math.abs(o.y0 - r.y0) < h * 0.4 && Math.abs(o.y1 - r.y1) < h * 0.4 && r.x0 <= o.x1 + h && r.x1 >= o.x0 - h;
    });
    if (same >= 0) out[same] = union(out[same], r);
    else out.push(r);
  }
  return out;
}

// --- Finding text -------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORDY = /[\p{L}\p{N}]/u;

/** A pattern for what someone typed: spaces match any space or none, so words split oddly still match. */
export function queryPattern(query: string, opts: SearchOptions = {}): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  let body = q
    .split(/\s+/)
    .map(escape)
    .join("\\s*");
  if (opts.wholeWord) {
    if (WORDY.test(q[0])) body = `(?<![\\p{L}\\p{N}])${body}`;
    if (WORDY.test(q[q.length - 1])) body = `${body}(?![\\p{L}\\p{N}])`;
  }
  return new RegExp(body, opts.matchCase ? "gu" : "giu");
}

/** A match on a page: the text and the boxes round it (none for text outside the visible area). */
export interface Found {
  text: string;
  rects: Rect[];
  hidden?: boolean;
  note?: boolean;
}

/** Everything `pattern` matches on a page: in its text, and in its comments and fields. */
export function findOnPage(page: PageText, pattern: RegExp, valid: (match: string) => boolean = () => true, s = pageString(page)): Found[] {
  const out: Found[] = [];
  const view = page.size && { x0: 0, y0: 0, x1: page.size.width, y1: page.size.height };
  for (const m of s.text.matchAll(pattern)) {
    if (!m[0].trim() || !valid(m[0])) continue;
    const rects = boxesFor(page, s, m.index!, m.index! + m[0].length);
    const text = m[0].replace(/\s+/g, " ").trim();
    // In a line that runs off the page, past where it is cut.
    if (view && rects.length && !rects.some((r) => touches(r, view))) out.push({ text, rects: [], hidden: true });
    else if (rects.length) out.push({ text, rects });
  }
  for (const note of page.notes) {
    for (const m of note.text.matchAll(pattern)) {
      if (m[0].trim() && valid(m[0])) out.push({ text: m[0].replace(/\s+/g, " ").trim(), rects: [note.rect], note: true });
    }
  }
  if (page.hidden?.length) {
    for (const m of pageString({ runs: page.hidden, notes: [] }).text.matchAll(pattern)) {
      if (m[0].trim() && valid(m[0])) out.push({ text: m[0].replace(/\s+/g, " ").trim(), rects: [], hidden: true });
    }
  }
  return out;
}

// --- Presets ------------------------------------------------------------------

const digits = (s: string) => s.replace(/\D/g, "");

/** The Luhn check that card numbers and South African ID numbers end with. */
export function luhn(number: string): boolean {
  const d = digits(number);
  if (d.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/**
 * A South African ID number: 13 digits, a birth date first (YYMMDD), a
 * citizenship digit of 0, 1 or 2 eleventh, and a Luhn check digit last.
 */
export function saIdNumber(text: string): boolean {
  const d = digits(text);
  if (d.length !== 13) return false;
  const yy = Number(d.slice(0, 2));
  // Either century: 2000 is a leap year like 1900 isn't, so 29 February needs both tried.
  const born = realDate(1900 + yy, Number(d.slice(2, 4)), Number(d.slice(4, 6))) || realDate(2000 + yy, Number(d.slice(2, 4)), Number(d.slice(4, 6)));
  return born && "012".includes(d[10]) && luhn(d);
}

/**
 * A card number: 13 to 19 digits that pass the Luhn check and start as card
 * numbers do (2 to 6; only Visa had 13 digits, starting with 4), so most
 * other long numbers with a check digit, ID numbers among them, aren't taken.
 */
export function cardNumber(text: string): boolean {
  const d = digits(text);
  if (d.length < 13 || d.length > 19 || !luhn(d) || /^(\d)\1+$/.test(d)) return false;
  return d.length === 13 ? d[0] === "4" : "23456".includes(d[0]);
}

/** An IBAN whose check digits are right (ISO 13616: mod 97 is 1). */
export function iban(text: string): boolean {
  const s = text.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const c of moved) {
    const v = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const ch of v) rest = (rest * 10 + Number(ch)) % 97;
  }
  return rest === 1;
}

/** A phone number: 9 to 15 digits, written as phone numbers are (+27…, 0…, (011)…, or 555-123-4567). */
export function phoneNumber(text: string): boolean {
  const d = digits(text);
  if (d.length < 9 || d.length > 15) return false;
  const t = text.trim();
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(t)) return false; // a date
  return /^\+/.test(t) || /^\(/.test(t) || (/^0/.test(t) && /[\s.-]/.test(t)) || /^0\d{8,10}$/.test(t) || /^\d{3}[\s.-]\d{3}[\s.-]\d{4}$/.test(t);
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_NUMBER: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A date that could be real: day and month in range, whichever order they're in. */
export function dateText(text: string): boolean {
  const t = text.trim().toLowerCase();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return realDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return realDate(year, +m[2], +m[1]) || realDate(year, +m[1], +m[2]);
  }
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?,?\s+(\d{4})$/) ?? null;
  if (m) return realDate(+m[3], MONTH_NUMBER[m[2].slice(0, 3)] ?? 0, +m[1]);
  m = t.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) return realDate(+m[3], MONTH_NUMBER[m[1].slice(0, 3)] ?? 0, +m[2]);
  return false;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** Digits in groups split by single spaces or dashes. */
const grouped = (min: number, max: number) => `\\d(?:[ -]?\\d){${min - 1},${max - 1}}`;

export interface Preset {
  id: PresetId;
  label: string;
  /** Said in the list: "3 emails". */
  plural: string;
  pattern: RegExp;
  valid?: (match: string) => boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "email",
    label: "Emails",
    plural: "emails",
    pattern: new RegExp(`(?<![\\p{L}\\p{N}._%+-])[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}${E}`, "gu"),
  },
  {
    id: "phone",
    label: "Phone numbers",
    plural: "phone numbers",
    pattern: new RegExp(`(?<![\\p{L}\\p{N}+(])(?:\\+\\d{1,3}[ .-]?)?(?:\\(\\d{1,4}\\)[ .-]?)?\\d{2,4}(?:[ .-]?\\d{2,4}){1,4}${E}`, "gu"),
    valid: phoneNumber,
  },
  {
    id: "card",
    label: "Card numbers",
    plural: "card numbers",
    pattern: new RegExp(`${B}${grouped(13, 19)}${E}`, "gu"),
    valid: cardNumber,
  },
  {
    id: "id",
    label: "SA ID numbers",
    plural: "ID numbers",
    pattern: new RegExp(`${B}\\d{6}[ -]?\\d{4}[ -]?\\d{2}[ -]?\\d${E}`, "gu"),
    valid: saIdNumber,
  },
  {
    id: "account",
    label: "Account numbers",
    plural: "account numbers",
    // Not straight after a "+": that's a phone number's country code.
    pattern: new RegExp(`(?<![\\p{L}\\p{N}+])(?:[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?|\\d{7,17}|\\d{4}(?:[ -]\\d{4}){1,3}(?:[ -]\\d{1,4})?)${E}`, "gu"),
    // Card and ID numbers have their own presets.
    valid: (s) => (/^[A-Z]/.test(s) ? iban(s) : !dateText(s) && !cardNumber(s) && !saIdNumber(s)),
  },
  {
    id: "date",
    label: "Dates",
    plural: "dates",
    pattern: new RegExp(
      `${B}(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.](?:\\d{4}|\\d{2})|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?,?\\s+\\d{4}|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})${E}`,
      "giu"
    ),
    valid: dateText,
  },
];

export const presetById = (id: PresetId) => PRESETS.find((p) => p.id === id)!;

// --- Marks --------------------------------------------------------------------

let counter = 0;
export const markId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;

const rectKey = (r: Rect) => [r.x0, r.y0, r.x1, r.y1].map((n) => Math.round(n)).join(",");
/** Two marks over the same place on the same page are one; text outside the visible area has no place, so it is told apart by what it says. */
export const markKey = (m: Pick<Mark, "page" | "rects" | "hidden" | "text">) =>
  m.hidden ? `${m.page}:hidden:${normal(m.text)}` : `${m.page}:${m.rects.map(rectKey).join(";")}`;

/** `found` as marks, leaving out any already in `marks` or inside a mark there (a phone number already marked isn't an account number too). */
export function addFound(marks: Mark[], page: number, found: Found[], kind: MarkKind, whole: boolean): Mark[] {
  const seen = new Set(marks.map(markKey));
  const here = marks.filter((m) => m.page === page).flatMap((m) => m.rects);
  const out: Mark[] = [];
  for (const f of found) {
    const mark: Mark = { id: markId(), page, rects: f.rects, kind, text: f.text, whole, on: true };
    if (f.hidden) mark.hidden = true;
    if (f.note) mark.note = true;
    const key = markKey(mark);
    if (seen.has(key)) continue;
    if (!f.hidden && f.rects.every((r) => here.some((h) => overlap(h, r) >= area(r) * 0.8))) continue;
    seen.add(key);
    out.push(mark);
  }
  return out;
}

/** The words with their middle inside `rects`, a line at a time: what a box covers. */
export function wordsUnder(page: PageText, rects: Rect[]): string {
  const lines: string[] = [];
  for (const run of page.runs) {
    const words = wordsOf(run).filter((w) => rects.some((r) => inside(centre(w.rect), r)));
    if (words.length) lines.push(words.map((w) => w.text).join(" "));
  }
  for (const note of page.notes) if (rects.some((r) => inside(centre(note.rect), r))) lines.push(note.text.trim());
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Words that stay searchable on a rebuilt page: those well clear of every
 * box. Where a word sits in its run is an estimate, so a word next to a box
 * is left out too: the room kept grows with the run, as the estimate's error
 * can.
 */
export function wordsClear(page: PageText, rects: Rect[]): { text: string; rect: Rect }[] {
  const out: { text: string; rect: Rect }[] = [];
  for (const run of page.runs) {
    const { x0, y0, x1, y1 } = run.rect;
    const along = run.flow === "right" || run.flow === "left";
    const [length, across] = along ? [x1 - x0, y1 - y0] : [y1 - y0, x1 - x0];
    const room = Math.max(across * 0.5, length * 0.06);
    const near = (r: Rect) => (along ? grow(r, room, 0.5) : grow(r, 0.5, room));
    for (const w of wordsOf(run)) if (!rects.some((r) => touches(near(r), w.rect))) out.push(w);
  }
  return out;
}

// --- What has to be gone ------------------------------------------------------

/** Text that must not be left in the file, and how many copies may stay on each page because they weren't marked. */
export interface Needle {
  text: string;
  whole: boolean;
  /** Page index → copies the person chose to leave. */
  allowed: Record<number, number>;
}

/** How text is compared: letters as written, any run of spaces as one. */
export const normal = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** With spaces and the marks numbers are written with taken out, for text whose spaces were lost. */
export const squeezed = (s: string) => normal(s).replace(/[\s\-.()/+_,]/g, "");

/** Needles shorter than this are only checked as written: squeezed, they'd turn up in anything. */
export const SQUEEZED_MIN = 6;

/** A pattern for a needle in normalised text. */
export function needlePattern(n: Pick<Needle, "text" | "whole">): RegExp {
  return queryPattern(normal(n.text), { wholeWord: n.whole })!;
}

/** How many times the needle is in `text`. */
export function countIn(text: string, n: Pick<Needle, "text" | "whole">): number {
  return [...normal(text).matchAll(needlePattern(n))].length;
}

/** Whether the needle is in `text` once spaces and number marks are taken out of both. */
export function squeezedIn(text: string, n: Pick<Needle, "text">): boolean {
  const s = squeezed(n.text);
  return s.length >= SQUEEZED_MIN && squeezed(text).includes(s);
}

/** All the text pdf.js reads on a page, its comments, fields and text outside the visible area included, as one string to count needles in. */
export const allText = (page: PageText) =>
  [pageString(page).text, ...page.notes.map((n) => n.text), page.hidden?.length ? pageString({ runs: page.hidden, notes: [] }).text : ""].join("\n");

/** What a mark takes away, as text to look for afterwards: what was found, or the words under a box. */
export function markText(mark: Mark, page: PageText | undefined): string {
  if (mark.kind !== "box") return mark.text;
  return page ? wordsUnder(page, mark.rects) : mark.text;
}

/** A copy of marked text that no mark covers. */
export interface Copy {
  text: string;
  page: number;
  rects: Rect[];
  /** Outside the visible area of its page. */
  hidden?: boolean;
  /** In a comment, link or field. */
  note?: boolean;
}

/**
 * The text each ticked mark takes away, with every copy of it in the
 * document that no ticked mark covers. Copies are what someone marking one
 * place would want to know about: they stay unless marked too.
 */
export function planNeedles(pages: Map<number, PageText>, marks: Mark[]): { needles: Needle[]; copies: Copy[] } {
  const on = marks.filter((m) => m.on);
  const byText = new Map<string, Needle>();
  for (const m of on) {
    const text = markText(m, pages.get(m.page)).trim();
    // One letter or digit is in every page: the box takes it away where it was.
    if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
    const key = `${normal(text)}|${m.whole}`;
    if (!byText.has(key)) byText.set(key, { text, whole: m.kind === "box" || m.whole, allowed: {} });
  }
  const copies: Copy[] = [];
  const covered = (page: number, f: Found) =>
    // A page with any mark is rebuilt from what shows: nothing outside the visible area stays.
    f.hidden
      ? on.some((m) => m.page === page)
      : f.rects.every((r) => on.some((m) => m.page === page && m.rects.some((mr) => overlap(mr, r) >= area(r) * 0.5 || inside(centre(r), mr))));
  for (const needle of byText.values()) {
    const pattern = queryPattern(needle.text, { wholeWord: needle.whole })!;
    for (const [page, text] of pages) {
      const found = findOnPage(text, pattern);
      let left = 0;
      for (const f of found) {
        if (covered(page, f)) continue;
        left++;
        copies.push(f.hidden ? { text: needle.text, page, rects: [], hidden: true } : { text: needle.text, page, rects: f.rects, note: f.note });
      }
      // Counted the way the result will be: so the check after compares like with like.
      const total = countIn(allText(text), needle);
      const kept = Math.min(total, left + Math.max(0, total - found.length));
      if (kept) needle.allowed[page] = kept;
    }
  }
  return { needles: [...byText.values()], copies };
}

/** The file name for the result. */
export function redactedName(name: string): string {
  return `${name.replace(/\.pdf$/i, "") || "document"}-redacted.pdf`;
}

/** How a mark is named in the list. */
export function markLabel(mark: Mark): string {
  if (mark.kind === "box") return mark.text ? `Box: ${clip(mark.text)}` : "Box";
  return mark.hidden ? `${clip(mark.text)} (outside the visible page)` : clip(mark.text);
}

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- Boxes drawn by hand --------------------------------------------------------

/** The smallest box drawn by hand, in points. */
export const MIN_BOX = 4;

/** A new box between two points, kept to the page. */
export function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number): Rect {
  return clampRect({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, width, height);
}

/** A handle of a box: a corner, a side, or the whole box. */
export type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Exclude<Handle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** `start` after `handle` is dragged by `dx`, `dy`, kept to the page and at least MIN_BOX across. */
export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, width: number, height: number): Rect {
  if (handle === "move") {
    const w = start.x1 - start.x0;
    const h = start.y1 - start.y0;
    const x0 = Math.max(0, Math.min(width - w, start.x0 + dx));
    const y0 = Math.max(0, Math.min(height - h, start.y0 + dy));
    return { x0, y0, x1: x0 + w, y1: y0 + h };
  }
  let { x0, y0, x1, y1 } = start;
  if (handle.includes("w")) x0 = Math.max(0, Math.min(x1 - MIN_BOX, x0 + dx));
  if (handle.includes("e")) x1 = Math.min(width, Math.max(x0 + MIN_BOX, x1 + dx));
  if (handle.includes("n")) y0 = Math.max(0, Math.min(y1 - MIN_BOX, y0 + dy));
  if (handle.includes("s")) y1 = Math.min(height, Math.max(y0 + MIN_BOX, y1 + dy));
  return { x0, y0, x1, y1 };
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Arrows move the box a point (Shift: 10), Alt + arrows move its right or bottom edge. Null for other keys. */
export function nudgeRect(r: Rect, key: { key: string; shiftKey: boolean; altKey: boolean }, width: number, height: number): Rect | null {
  const dir = ARROWS[key.key];
  if (!dir) return null;
  const step = key.shiftKey ? 10 : 1;
  const [dx, dy] = [dir[0] * step, dir[1] * step];
  return key.altKey ? dragRect(r, "se", dx, dy, width, height) : dragRect(r, "move", dx, dy, width, height);
}

/** A box where people can see it: a short line's size, in the middle of the page. */
export function startRect(width: number, height: number): Rect {
  const w = Math.min(width * 0.4, 160);
  const h = Math.min(height * 0.05, 24);
  return { x0: (width - w) / 2, y0: (height - h) / 2, x1: (width + w) / 2, y1: (height + h) / 2 };
}

/** Where a box is, for people who can't see it: size and place in millimetres. */
export function describeRect(r: Rect): string {
  const mm = (pt: number) => `${Math.round((pt * 25.4) / 72)} mm`;
  return `${mm(r.x1 - r.x0)} by ${mm(r.y1 - r.y0)}, ${mm(r.x0)} from the left, ${mm(r.y0)} from the top`;
}
