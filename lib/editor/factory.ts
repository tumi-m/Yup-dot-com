import { uuid } from "@/lib/utils";
import type {
  Annotation,
  MarkupKind,
  ShapeKind,
  ToolSettings,
  ToolId,
  FieldKind,
} from "./types";

const SHAPES: ShapeKind[] = ["rect", "ellipse", "line", "arrow", "whiteout"];
const MARKUPS: MarkupKind[] = ["highlight", "underline", "strikeout"];

/**
 * Builds a new annotation for a tool at a point. Drag tools start with zero
 * size and are grown by `resizeDraft` as the pointer moves.
 */
export function createAnnotation(
  tool: ToolId,
  settings: ToolSettings,
  x: number,
  y: number,
  extras: { dataUrl?: string; fieldIndex?: number } = {}
): Annotation | null {
  const id = uuid();
  const page = 0; // caller overwrites with the active page

  if (SHAPES.includes(tool as ShapeKind)) {
    const shape = tool as ShapeKind;
    return {
      id,
      page,
      type: "shape",
      shape,
      x,
      y,
      width: 0,
      height: 0,
      x1: x,
      y1: y,
      x2: x,
      y2: y,
      stroke: shape === "whiteout" ? "#ffffff" : settings.color,
      fill: shape === "whiteout" ? "#ffffff" : settings.fill,
      strokeWidth: settings.strokeWidth,
      opacity: settings.opacity,
    };
  }

  if (MARKUPS.includes(tool as MarkupKind)) {
    return {
      id,
      page,
      type: "markup",
      markup: tool as MarkupKind,
      x,
      y,
      width: 0,
      height: 0,
      color: tool === "highlight" ? settings.highlightColor : settings.color,
      opacity: tool === "highlight" ? 0.4 : 1,
    };
  }

  if (tool.startsWith("field-")) {
    const field = tool.slice("field-".length) as FieldKind;
    const n = extras.fieldIndex ?? 1;
    return {
      id,
      page,
      type: "field",
      field,
      name: `${field}_${n}`,
      value: "",
      options: field === "dropdown" ? ["Option 1", "Option 2"] : [],
      fontSize: settings.fontSize,
      x,
      y,
      width: 0,
      height: 0,
    };
  }

  switch (tool) {
    case "text":
      return {
        id,
        page,
        type: "text",
        x,
        y,
        width: 180,
        height: settings.fontSize * 1.6,
        text: "Type here",
        fontSize: settings.fontSize,
        color: settings.color,
        bold: settings.bold,
      };

    case "note":
      return {
        id,
        page,
        type: "note",
        x,
        y,
        width: 150,
        height: 90,
        text: "",
        color: "#fde047",
      };

    case "draw":
      return {
        id,
        page,
        type: "draw",
        x,
        y,
        width: 1,
        height: 1,
        points: [{ x: 0, y: 0 }],
        color: settings.color,
        strokeWidth: settings.strokeWidth,
      };

    case "image":
    case "signature": {
      if (!extras.dataUrl) return null;
      const isSignature = tool === "signature";
      return {
        id,
        page,
        type: "image",
        x,
        y,
        width: isSignature ? 160 : 200,
        height: isSignature ? 70 : 150,
        dataUrl: extras.dataUrl,
        signature: isSignature,
      };
    }

    case "link":
      return {
        id,
        page,
        type: "link",
        x,
        y,
        width: 0,
        height: 0,
        url: "",
        targetPage: null,
      };

    default:
      return null;
  }
}

/** Grow a draft annotation as the creation drag moves. */
export function resizeDraft(
  draft: Annotation,
  originX: number,
  originY: number,
  x: number,
  y: number
): Annotation {
  if (draft.type === "draw") {
    const points = [...draft.points, { x: x - draft.x, y: y - draft.y }];
    return {
      ...draft,
      points,
      width: Math.max(1, ...points.map((p) => p.x)),
      height: Math.max(1, ...points.map((p) => p.y)),
    };
  }

  if (
    draft.type === "shape" &&
    (draft.shape === "line" || draft.shape === "arrow")
  ) {
    return {
      ...draft,
      x: Math.min(originX, x),
      y: Math.min(originY, y),
      width: Math.abs(x - originX),
      height: Math.abs(y - originY),
      x1: originX,
      y1: originY,
      x2: x,
      y2: y,
    };
  }

  return {
    ...draft,
    x: Math.min(originX, x),
    y: Math.min(originY, y),
    width: Math.abs(x - originX),
    height: Math.abs(y - originY),
  };
}

/** Discards accidental zero-size shapes produced by a stray click. */
export function isDraftUsable(draft: Annotation): boolean {
  if (draft.type === "draw") return draft.points.length > 2;
  return draft.width >= 4 && draft.height >= 4;
}
