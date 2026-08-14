/**
 * Editor annotation model.
 *
 * Geometry is stored in PDF points with a **top-left origin**, so it is
 * independent of zoom and translates to pdf-lib by flipping the y-axis once at
 * bake time.
 */

export type ShapeKind = "rect" | "ellipse" | "line" | "arrow" | "whiteout";
export type MarkupKind = "highlight" | "underline" | "strikeout";
export type FieldKind = "text" | "checkbox" | "radio" | "dropdown";

export type ToolId =
  | "select"
  | "text"
  | "draw"
  | "image"
  | "signature"
  | "note"
  | "link"
  | ShapeKind
  | MarkupKind
  | `field-${FieldKind}`;

export interface BaseAnnotation {
  id: string;
  page: number; // 0-indexed
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextAnnotation extends BaseAnnotation {
  type: "text";
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
}

export interface DrawAnnotation extends BaseAnnotation {
  type: "draw";
  /** Points relative to the annotation box, in points. */
  points: { x: number; y: number }[];
  color: string;
  strokeWidth: number;
}

export interface ImageAnnotation extends BaseAnnotation {
  type: "image";
  dataUrl: string;
  /** Signatures are images too, but get their own tool and styling. */
  signature: boolean;
}

export interface NoteAnnotation extends BaseAnnotation {
  type: "note";
  text: string;
  color: string;
}

export interface ShapeAnnotation extends BaseAnnotation {
  type: "shape";
  shape: ShapeKind;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
  /** Absolute endpoints, used by line and arrow only. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export interface MarkupAnnotation extends BaseAnnotation {
  type: "markup";
  markup: MarkupKind;
  color: string;
  opacity: number;
}

export interface LinkAnnotation extends BaseAnnotation {
  type: "link";
  url: string;
  /** 0-indexed internal page target; takes precedence over url when set. */
  targetPage: number | null;
}

export interface FieldAnnotation extends BaseAnnotation {
  type: "field";
  field: FieldKind;
  name: string;
  value: string;
  /** Choices for dropdown and radio. */
  options: string[];
  fontSize: number;
}

export type Annotation =
  | TextAnnotation
  | DrawAnnotation
  | ImageAnnotation
  | NoteAnnotation
  | ShapeAnnotation
  | MarkupAnnotation
  | LinkAnnotation
  | FieldAnnotation;

/** Style state carried by the toolbar and applied to newly created items. */
export interface ToolSettings {
  color: string;
  highlightColor: string;
  fill: string | null;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  bold: boolean;
}

export const DEFAULT_SETTINGS: ToolSettings = {
  color: "#1e1b4b",
  highlightColor: "#fde047",
  fill: null,
  strokeWidth: 2,
  fontSize: 14,
  opacity: 1,
  bold: false,
};

/** Tools that are created by dragging out a region rather than a single click. */
export const DRAG_TOOLS: ToolId[] = [
  "rect",
  "ellipse",
  "line",
  "arrow",
  "whiteout",
  "highlight",
  "underline",
  "strikeout",
  "draw",
  "link",
  "field-text",
  "field-checkbox",
  "field-radio",
  "field-dropdown",
];

export function isFieldTool(tool: ToolId): tool is `field-${FieldKind}` {
  return tool.startsWith("field-");
}

/** Human label for the properties panel and toasts. */
export function annotationLabel(ann: Annotation): string {
  switch (ann.type) {
    case "text":
      return "Text";
    case "draw":
      return "Drawing";
    case "image":
      return ann.signature ? "Signature" : "Image";
    case "note":
      return "Sticky note";
    case "shape":
      return ann.shape === "whiteout"
        ? "Whiteout"
        : ann.shape.charAt(0).toUpperCase() + ann.shape.slice(1);
    case "markup":
      return ann.markup.charAt(0).toUpperCase() + ann.markup.slice(1);
    case "link":
      return "Link";
    case "field":
      return `${ann.field.charAt(0).toUpperCase() + ann.field.slice(1)} field`;
  }
}
