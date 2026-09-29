import JSZip from "jszip";
import { parsePptx, type DeckSlide } from "./parse";

/**
 * Helpers for the slide editor (components/tools/PptxEditor.tsx).
 */

/**
 * Renders one slide of a saved package without parsing the whole deck:
 * the other slides' content-type overrides are dropped from a copy of the
 * zip, so pptxtojson (and parsePptx, which lists slides the same way) only
 * sees `part`. Unchanged zip entries are reused as-is, so this costs a
 * fraction of a full parse on long decks. Falls back to a full parse when the
 * trimmed package yields nothing.
 */
export async function parseSlidePart(bytes: Uint8Array, part: string): Promise<DeckSlide> {
  const zip = await JSZip.loadAsync(bytes);
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    const ct = await ctFile.async("string");
    const want = `/${part}`.toLowerCase();
    const trimmed = ct.replace(/<Override\b[^>]*?\/>/g, (tag) => {
      const name = /PartName="([^"]*)"/.exec(tag)?.[1] ?? "";
      const isSlide = /presentationml\.slide\+xml/.test(tag);
      return isSlide && name.toLowerCase() !== want ? "" : tag;
    });
    zip.file("[Content_Types].xml", trimmed);
    try {
      const mini = await zip.generateAsync({ type: "uint8array" });
      const deck = await parsePptx(mini);
      const hit = deck.slides.find((s) => s.part === part);
      if (hit) return hit;
    } catch {
      // Fall through to a full parse.
    }
  }
  const full = await parsePptx(bytes);
  const hit = full.slides.find((s) => s.part === part);
  if (!hit) throw new Error(`Slide ${part} not found`);
  return hit;
}

const LONG = 1024;

function collectLong(value: unknown, pool: Map<string, string>, seen = new Set<object>()) {
  if (typeof value === "string") {
    if (value.length >= LONG) pool.set(value, value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const v of Object.values(value)) collectLong(v, pool, seen);
}

function internLong(value: unknown, pool: Map<string, string>, seen = new Set<object>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const rec = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") {
      if (v.length >= LONG) {
        const same = pool.get(v);
        if (same !== undefined && same !== v) rec[k] = same;
      }
    } else internLong(v, pool, seen);
  }
}

/**
 * A re-parsed slide after a text edit, sharing what the edit can't have
 * changed with the slide it replaces: the layout/master shapes (other parts)
 * and any image data URLs that are equal. Without this every edit keeps a new
 * copy of each picture on the slide and its layout in the undo history.
 * `next` must be freshly parsed (not yet rendered): its objects are updated.
 */
export function shareUnchanged(prev: DeckSlide, next: DeckSlide): DeckSlide {
  const pool = new Map<string, string>();
  collectLong([prev.elements, prev.fill], pool);
  if (pool.size) internLong({ e: next.elements, f: next.fill }, pool);
  return { ...next, layoutElements: prev.layoutElements };
}

/** Paragraphs (a:br as "\n") as textarea text, one line per line. */
export function paragraphsToText(paragraphs: string[]): string {
  return paragraphs.join("\n");
}

/**
 * Textarea text back to paragraphs. A textarea can't tell a paragraph break
 * from a line break, so when the text still has as many lines as the
 * original, lines are regrouped into the original paragraphs (keeping their
 * line breaks); otherwise every line becomes a paragraph.
 */
export function textToParagraphs(original: string[], text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const shape = original.map((p) => p.split("\n").length);
  const total = shape.reduce((a, b) => a + b, 0);
  if (total !== lines.length || shape.every((n) => n === 1)) return lines;
  const out: string[] = [];
  let at = 0;
  for (const n of shape) {
    out.push(lines.slice(at, at + n).join("\n"));
    at += n;
  }
  return out;
}

/**
 * Undo/redo over immutable snapshots, bounded by count and by total size so
 * long sessions on big decks don't pile up memory. The oldest undo steps go
 * first.
 */
export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(
    public current: T,
    private readonly sizeOf: (s: T) => number,
    private readonly maxSteps = 40,
    private readonly maxBytes = 120 * 1024 * 1024
  ) {}

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  get steps() {
    return this.undoStack.length;
  }

  push(next: T) {
    this.undoStack.push(this.current);
    this.current = next;
    this.redoStack = [];
    this.trim();
  }

  undo(): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.current);
    this.current = next;
    return next;
  }

  private trim() {
    while (this.undoStack.length > this.maxSteps) this.undoStack.shift();
    let bytes = this.sizeOf(this.current) + this.undoStack.reduce((n, s) => n + this.sizeOf(s), 0);
    while (this.undoStack.length && bytes > this.maxBytes) bytes -= this.sizeOf(this.undoStack.shift()!);
  }
}
