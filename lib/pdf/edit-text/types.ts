/**
 * The text runs Edit text works with. Plain data with no imports, so a run
 * can be kept inside an edit, in the undo history and in the page's code.
 */

export type Point = [number, number];

/** The marked-content tag round the boxes Edit text draws over old words, so the next read knows they hide what is under them. */
export const COVER_TAG = "PDFWizardCover";
/** a b c d e f, as PDF and canvas write them: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

export type Family = "serif" | "sans" | "mono";

/** What the run's font is, as far as choosing a font for new words goes. */
export interface RunFont {
  /** Its name in the file (BaseFont), with a subset's prefix. */
  name: string;
  family: Family;
  bold: boolean;
  italic: boolean;
  /** Only the letters the file used are in it (a name like ABCDEF+Calibri). */
  subset: boolean;
  /** Its letters are little drawings (Type 3). */
  type3: boolean;
  /** It is embedded as a TrueType or OpenType program, which new letters could be drawn with. */
  program: boolean;
}

/**
 * The text-showing operations a run's words are drawn by, to take out of
 * the page's content. Each is named by its place among the page's own ones
 * and carries the codes it draws, so the save can check it is the same one.
 */
export interface RemovePlan {
  /** How many text-showing operations the page's own content has (forms' not counted). */
  total: number;
  ops: {
    index: number;
    codes: number[];
    /** How far it moved the text along the line, in text space units before horizontal scaling. */
    advance: number;
    /** The font size it was drawn at. */
    size: number;
  }[];
}

/**
 * Why a run's old words can only be covered, not taken out: the operations
 * also draw text outside it, it is in a form XObject, its font is Type 3,
 * it is invisible (a scan's searchable layer, or fully transparent), it is
 * clipped, its letters couldn't be lined up with the operations that drew
 * them, or other text, a picture or a filled shape is drawn in the same place.
 */
export type CoverReason = "shared" | "form" | "type3" | "hidden" | "clip" | "unmatched" | "overlap";

/** Why a run can't be changed here: right-to-left or top-to-bottom text. */
export type LockReason = "rtl" | "vertical";

/** A line of text, or the part of one in one font, size and colour. */
export interface EditableRun {
  /** The same for the same run each time the page is read. */
  key: string;
  text: string;
  /**
   * Run space to the page as shown (points from the top left) and to PDF
   * user space. Run space starts on the baseline where the first letter
   * starts, x along the line and y up, in points at the run's size.
   */
  display: Matrix;
  user: Matrix;
  /** Its font size as it shows, in points. */
  size: number;
  /** Where its letters start and end along the line, in run space. */
  x0: number;
  x1: number;
  /** The font's ascent and descent, in ems (descent is below 0). */
  ascent: number;
  descent: number;
  /** Its corners on the page as shown: along the bottom, then back along the top. */
  quad: [Point, Point, Point, Point];
  /** The upright box round it on the page as shown. */
  box: { x: number; y: number; width: number; height: number };
  font: RunFont;
  /** #rrggbb; black when the page fills it with a pattern. */
  color: string;
  locked: LockReason | null;
  /** How to take its words out, or null when they can only be covered (`cover` says why). */
  remove: RemovePlan | null;
  cover: CoverReason | null;
}
