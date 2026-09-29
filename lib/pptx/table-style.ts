import type { TableFlags } from "./ooxml";

/**
 * PowerPoint's built-in table styles are referenced by GUID and not stored in
 * the file, so pptxtojson leaves such tables unstyled. This covers the
 * default one (Medium Style 2, in each accent), which is what almost every
 * inserted table uses.
 */

const MEDIUM_STYLE_2: Record<string, number> = {
  "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}": -1, // dk1
  "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": 0,
  "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}": 1,
  "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}": 2,
  "{00A15C55-8517-42AA-B614-E9B94910E393}": 3,
  "{7DF18680-E054-41AD-8BC1-D1AEF772440D}": 4,
  "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}": 5,
};

export interface CellLook {
  fill?: string;
  color?: string;
  bold?: boolean;
  /** Border colour/width (pt) drawn on every side of the cell. */
  border?: { color: string; width: number };
  /** Heavier bottom border under the header row. */
  bottom?: { color: string; width: number };
}

/** Mixes a colour towards white: tint(0.2) keeps 20% of the colour. */
export function tint(hex: string, keep: number): string {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c * keep + 255 * (1 - keep)));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function builtInTableLook(
  flags: TableFlags | undefined,
  accents: string[],
  rows: number,
  cols: number
): ((row: number, col: number) => CellLook) | null {
  const which = flags?.styleId ? MEDIUM_STYLE_2[flags.styleId.toUpperCase()] : undefined;
  if (which === undefined || !flags) return null;
  const base = which < 0 ? "#000000" : accents[which] ?? "#4F81BD";
  const white = { color: "#FFFFFF", width: 1 };
  return (row, col) => {
    const header = flags.firstRow && row === 0;
    const footer = flags.lastRow && row === rows - 1 && rows > 1;
    if (header || footer) {
      return { fill: base, color: "#FFFFFF", bold: true, border: white, bottom: header ? { color: "#FFFFFF", width: 3 } : undefined };
    }
    if ((flags.firstCol && col === 0) || (flags.lastCol && col === cols - 1)) {
      return { fill: base, color: "#FFFFFF", bold: true, border: white };
    }
    const bodyRow = row - (flags.firstRow ? 1 : 0);
    const banded = (flags.bandRow && bodyRow % 2 === 0) || (flags.bandCol && !flags.bandRow && col % 2 === 0);
    return { fill: tint(base, banded ? 0.4 : 0.2), color: "#000000", border: white };
  };
}
