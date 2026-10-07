import { OCR_LANGUAGES } from "@/lib/pdf/ocr-languages";
import type { ToolContext, ToolFile } from "@/lib/pdf/toolkit";

/** pdf-lib and pdf.js load when a spell is cast, not with the page. */
const kit = () => import("@/lib/pdf/toolkit");

export type FieldType = "select" | "text" | "password" | "range" | "color";

export interface ToolField {
  key: string;
  label: string;
  type: FieldType;
  default: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** Only show this field when another field has a given value. */
  showIf?: { key: string; value: string };
}

export interface ToolProcessor {
  accept: string;
  multiple: boolean;
  minFiles: number;
  /** Bundle multiple outputs into a single zip download. */
  zipName?: string;
  fields: ToolField[];
  /** Shown under the action button, e.g. privacy or accuracy notes. */
  note?: string;
  /**
   * Show a "% smaller" stat on success. Only meaningful when the tool's
   * purpose is size — comparing a PDF to, say, a .txt would be misleading.
   */
  reportsSizeChange?: boolean;
  run: (
    files: File[],
    options: Record<string, string>,
    ctx: ToolContext
  ) => Promise<ToolFile | ToolFile[]>;
}

export const PROCESSORS: Record<string, ToolProcessor> = {
  "merge-pdf": {
    accept: "application/pdf",
    multiple: true,
    minFiles: 2,
    fields: [],
    run: async (files) => (await kit()).mergeTool(files),
  },
  "split-pdf": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    zipName: "split-pages.zip",
    fields: [
      {
        key: "mode",
        label: "Split mode",
        type: "select",
        default: "ranges",
        options: [
          { value: "ranges", label: "By page ranges" },
          { value: "every", label: "Every page separately" },
        ],
      },
      {
        key: "ranges",
        label: "Pages (e.g. 1-3, 5)",
        type: "text",
        default: "1-1",
        showIf: { key: "mode", value: "ranges" },
      },
    ],
    run: async (files, o) => (await kit()).splitTool(files, { mode: o.mode, ranges: o.ranges }),
  },
  "rotate-pdf": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "angle",
        label: "Rotation",
        type: "select",
        default: "90",
        options: [
          { value: "90", label: "90° clockwise" },
          { value: "180", label: "180°" },
          { value: "270", label: "90° counter-clockwise" },
        ],
      },
    ],
    run: async (files, o) => (await kit()).rotateTool(files, { angle: o.angle }),
  },
  "compress-pdf": {
    reportsSizeChange: true,
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "quality",
        label: "Quality",
        type: "select",
        default: "0.6",
        options: [
          { value: "0.4", label: "Smallest file" },
          { value: "0.6", label: "Recommended" },
          { value: "0.8", label: "High quality" },
        ],
      },
    ],
    run: async (files, o, ctx) => (await kit()).compressTool(files, { quality: o.quality }, ctx),
  },
  "pdf-to-jpg": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    zipName: "images.zip",
    fields: [
      {
        key: "format",
        label: "Image format",
        type: "select",
        default: "jpeg",
        options: [
          { value: "jpeg", label: "JPG" },
          { value: "png", label: "PNG" },
        ],
      },
      {
        key: "quality",
        label: "Quality",
        type: "range",
        default: "0.92",
        min: 0.5,
        max: 1,
        step: 0.02,
        showIf: { key: "format", value: "jpeg" },
      },
    ],
    run: async (files, o, ctx) => (await kit()).pdfToImagesTool(files, { format: o.format, quality: o.quality }, ctx),
  },
  "jpg-to-pdf": {
    accept: "image/jpeg,image/png",
    multiple: true,
    minFiles: 1,
    fields: [
      {
        key: "pageSize",
        label: "Page size",
        type: "select",
        default: "fit",
        options: [
          { value: "fit", label: "Fit to image" },
          { value: "a4", label: "A4" },
        ],
      },
      {
        key: "margin",
        label: "Margin (pt)",
        type: "select",
        default: "0",
        options: [
          { value: "0", label: "None" },
          { value: "24", label: "Small" },
          { value: "48", label: "Large" },
        ],
      },
    ],
    run: async (files, o) => (await kit()).imagesToPdfTool(files, { pageSize: o.pageSize, margin: o.margin }),
  },
  "pdf-to-text": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [],
    run: async (files, _o, ctx) => (await kit()).pdfToTextTool(files, ctx),
  },
  "pdf-to-markdown": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [],
    run: async (files, _o, ctx) => (await kit()).pdfToMarkdownTool(files, ctx),
  },
  "extract-tables": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    zipName: "tables.zip",
    fields: [],
    run: async (files, _o, ctx) => (await kit()).extractTablesTool(files, ctx),
  },
  "pdf-to-chunks": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "maxChars",
        label: "Chunk size (characters)",
        type: "select",
        default: "1200",
        options: [
          { value: "600", label: "Small (600)" },
          { value: "1200", label: "Medium (1200)" },
          { value: "2000", label: "Large (2000)" },
        ],
      },
    ],
    run: async (files, o, ctx) => (await kit()).pdfToChunksTool(files, { maxChars: o.maxChars }, ctx),
  },
  "pdf-to-word": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [],
    run: async (files, _o, ctx) => (await kit()).pdfToWordTool(files, ctx),
  },
  "pdf-to-pptx": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "quality",
        label: "Quality",
        type: "select",
        default: "standard",
        options: [
          { value: "standard", label: "Standard" },
          { value: "high", label: "High" },
        ],
      },
    ],
    run: async (files, o, ctx) => {
      const { pdfToPptxTool } = await import("@/lib/pptx/from-pdf");
      return pdfToPptxTool(files, { quality: o.quality }, ctx);
    },
  },
  "pdf-to-excel": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [],
    run: async (files, _o, ctx) => (await kit()).pdfToExcelTool(files, ctx),
  },
  "ocr-pdf": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "lang",
        label: "Document language",
        type: "select",
        default: "eng",
        options: OCR_LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
      },
      {
        key: "output",
        label: "Output",
        type: "select",
        default: "pdf",
        options: [
          { value: "pdf", label: "Searchable PDF" },
          { value: "text", label: "Plain text (.txt)" },
        ],
      },
    ],
    note: "Runs on your device.",
    run: async (files, o, ctx) => (await kit()).ocrTool(files, { lang: o.lang, output: o.output }, ctx),
  },
  "protect-pdf": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      { key: "password", label: "Password", type: "password", default: "" },
      { key: "confirm", label: "Confirm password", type: "password", default: "" },
      {
        key: "printing",
        label: "Allow printing",
        type: "select",
        default: "yes",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
      {
        key: "copying",
        label: "Allow copying text",
        type: "select",
        default: "no",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
    note: "Lost passwords can't be recovered.",
    run: async (files, o) =>
      (await kit()).protectTool(files, {
        password: o.password,
        confirm: o.confirm,
        printing: o.printing,
        copying: o.copying,
      }),
  },
  "unlock-pdf": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [{ key: "password", label: "Current password", type: "password", default: "" }],
    run: async (files, o) => (await kit()).unlockTool(files, { password: o.password }),
  },
  "page-numbers": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "position",
        label: "Position",
        type: "select",
        default: "bottom-center",
        options: [
          { value: "bottom-center", label: "Bottom center" },
          { value: "bottom-right", label: "Bottom right" },
          { value: "bottom-left", label: "Bottom left" },
        ],
      },
      {
        key: "format",
        label: "Format",
        type: "select",
        default: "n",
        options: [
          { value: "n", label: "1, 2, 3" },
          { value: "n_of_N", label: "1 of N" },
        ],
      },
      {
        key: "fontSize",
        label: "Font size",
        type: "select",
        default: "12",
        options: [
          { value: "10", label: "Small" },
          { value: "12", label: "Medium" },
          { value: "16", label: "Large" },
        ],
      },
    ],
    run: async (files, o) =>
      (await kit()).pageNumbersTool(files, {
        position: o.position,
        format: o.format,
        fontSize: o.fontSize,
      }),
  },
  "watermark-pdf": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      { key: "text", label: "Watermark text", type: "text", default: "CONFIDENTIAL" },
      {
        key: "fontSize",
        label: "Size",
        type: "select",
        default: "60",
        options: [
          { value: "40", label: "Small" },
          { value: "60", label: "Medium" },
          { value: "90", label: "Large" },
        ],
      },
      { key: "color", label: "Colour", type: "color", default: "#6d28d9" },
      {
        key: "opacity",
        label: "Opacity",
        type: "range",
        default: "0.25",
        min: 0.05,
        max: 0.8,
        step: 0.05,
      },
    ],
    run: async (files, o) =>
      (await kit()).watermarkTool(files, {
        text: o.text,
        fontSize: o.fontSize,
        color: o.color,
        opacity: o.opacity,
      }),
  },
};
