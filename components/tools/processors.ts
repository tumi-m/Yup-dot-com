import { OCR_LANGUAGES } from "@/lib/pdf/ocr-languages";
import type { ToolContext, ToolFile } from "@/lib/pdf/toolkit";
import { readOptions } from "@/lib/pdf/resize/geometry";
import { acceptFor, ALL_FORMATS, type ImageFormat } from "@/lib/pdf/images-to-pdf/formats";

/** pdf-lib and pdf.js load when a spell is cast, not with the page. */
const kit = () => import("@/lib/pdf/toolkit");

export type FieldType = "select" | "text" | "password" | "range" | "color" | "checkbox";

export interface ToolField {
  key: string;
  label: string;
  type: FieldType;
  /** A checkbox is "true" when ticked, "" when not. */
  default: string;
  /** `hint`: one plain sentence under the select while that option is picked. */
  options?: { value: string; label: string; hint?: string }[];
  /** One plain sentence under the field. */
  hint?: string;
  /** Takes the whole row. */
  wide?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** The phone keyboard a text field brings up. */
  inputMode?: "decimal";
  /** Only show this field when another field has a given value. */
  showIf?: { key: string; value: string };
}

export interface ToolProcessor {
  /** What the file picker offers. */
  accept: string;
  /** Also taken when dropped or picked anyway (the file picker offers `accept` only). */
  alsoAccepts?: string;
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
  /** A long job that stops on ctx.signal: offer Cancel while it runs. */
  cancellable?: boolean;
  /** A decoder the browser must have: without it the page says so before any file is picked. */
  needs?: "heic";
  /** Shows the result for the chosen options before the spell is cast. */
  preview?: "resize";
  /**
   * What is wrong with the options as they stand, if anything: shown under
   * the fields it names as they are typed, and the spell waits until it's fixed.
   */
  problem?: (options: Record<string, string>) => { fields: string[]; message: string } | null;
  run: (
    files: File[],
    options: Record<string, string>,
    ctx: ToolContext
  ) => Promise<ToolFile | ToolFile[]>;
}

/** Page size and margin, as on every images-to-PDF page. */
const IMAGE_FIELDS: ToolField[] = [
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
];

/**
 * JPG to PDF and its one-format pages (PNG, WebP, HEIC, TIFF, SVG to PDF):
 * the same tool, offering that format in the file picker. Any other picture
 * dropped on the page is taken too.
 */
function imageTool(formats: ImageFormat[]): ToolProcessor {
  return {
    cancellable: true,
    accept: acceptFor(formats),
    alsoAccepts: acceptFor(ALL_FORMATS),
    multiple: true,
    minFiles: 1,
    fields: IMAGE_FIELDS,
    run: async (files, o, ctx) => (await kit()).imagesToPdfTool(files, { pageSize: o.pageSize, margin: o.margin }, ctx),
  };
}

const TEXT_ACCEPT = "text/plain,.txt,.text,.log,.csv,.tsv,.json,.xml,.yaml,.yml,.ini,.cfg,.conf,.js,.ts,.py,.java,.c,.h,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.css";
const MARKDOWN_ACCEPT = "text/markdown,text/x-markdown,.md,.markdown,.mdown,.mkd";

/** Text to PDF and Markdown to PDF: one file, laid out on pages. */
function textTool(markdown: boolean): ToolProcessor {
  return {
    cancellable: true,
    accept: markdown ? MARKDOWN_ACCEPT : TEXT_ACCEPT,
    // Either page takes the other's files: Markdown read as text, or text as Markdown.
    alsoAccepts: markdown ? TEXT_ACCEPT : MARKDOWN_ACCEPT,
    multiple: false,
    minFiles: 1,
    note: "Writes Latin, Greek and Cyrillic letters. Chinese, Japanese, Korean, Arabic and Hebrew aren't supported yet.",
    fields: [
      {
        key: "pageSize",
        label: "Page size",
        type: "select",
        default: "a4",
        options: [
          { value: "a4", label: "A4" },
          { value: "letter", label: "Letter" },
        ],
      },
      {
        key: "margin",
        label: "Margins",
        type: "select",
        default: "normal",
        options: [
          { value: "narrow", label: "Narrow (0.5 in)" },
          { value: "normal", label: "Normal (1 in)" },
          { value: "wide", label: "Wide (1.5 in)" },
        ],
      },
      {
        key: "fontSize",
        label: "Text size",
        type: "select",
        default: "11",
        options: ["9", "10", "11", "12", "14"].map((v) => ({ value: v, label: `${v} pt` })),
      },
      {
        key: "font",
        label: "Font",
        type: "select",
        default: "sans",
        options: [
          { value: "sans", label: "Sans" },
          { value: "mono", label: "Monospace", hint: "Every letter the same width, so code and columns line up." },
        ],
      },
      { key: "pageNumbers", label: "Page numbers", type: "checkbox", default: "true" },
    ],
    run: async (files, o, ctx) => (await kit()).textToPdfTool(files, o, ctx, markdown),
  };
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
    cancellable: true,
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
    run: async (files, o, ctx) => (await kit()).splitTool(files, { mode: o.mode, ranges: o.ranges }, ctx),
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
  "resize-pdf": {
    cancellable: true,
    preview: "resize",
    problem: (o) => {
      if (o.size !== "custom") return null;
      try {
        readOptions(o);
        return null;
      } catch (err) {
        return { fields: ["width", "height"], message: (err as Error).message };
      }
    },
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "size",
        label: "Page size",
        type: "select",
        default: "a4",
        options: [
          { value: "a4", label: "A4 (210 × 297 mm)" },
          { value: "a3", label: "A3 (297 × 420 mm)" },
          { value: "a5", label: "A5 (148 × 210 mm)" },
          { value: "letter", label: "Letter (8.5 × 11 in)" },
          { value: "legal", label: "Legal (8.5 × 14 in)" },
          { value: "tabloid", label: "Tabloid (11 × 17 in)" },
          { value: "custom", label: "Custom size" },
        ],
      },
      { key: "width", label: "Width", type: "text", default: "210", inputMode: "decimal", showIf: { key: "size", value: "custom" } },
      { key: "height", label: "Height", type: "text", default: "297", inputMode: "decimal", showIf: { key: "size", value: "custom" } },
      {
        key: "unit",
        label: "Unit",
        type: "select",
        default: "mm",
        options: [
          { value: "mm", label: "Millimetres (mm)" },
          { value: "in", label: "Inches (in)" },
          { value: "pt", label: "Points (pt)" },
        ],
        showIf: { key: "size", value: "custom" },
      },
      {
        key: "orientation",
        label: "Orientation",
        type: "select",
        default: "auto",
        options: [
          {
            value: "auto",
            label: "Same as each page",
            hint: "Pages stay upright or sideways as they are, so the width and height may swap.",
          },
          { value: "portrait", label: "Portrait" },
          { value: "landscape", label: "Landscape" },
        ],
      },
      {
        key: "fit",
        label: "Fit",
        type: "select",
        default: "fit",
        options: [
          { value: "fit", label: "Fit inside", hint: "The whole page shows, as big as it fits, in proportion." },
          { value: "fill", label: "Fill and crop", hint: "The page covers the sheet; what sticks out is cut off." },
          { value: "none", label: "Don't scale", hint: "The page keeps its size, centred on the sheet." },
        ],
      },
      {
        key: "margin",
        label: "Margin",
        type: "select",
        default: "0",
        options: [
          { value: "0", label: "None" },
          { value: "5", label: "Small (5 mm)" },
          { value: "10", label: "Medium (10 mm)" },
          { value: "20", label: "Large (20 mm)" },
        ],
      },
      {
        key: "perSheet",
        label: "Pages per sheet",
        type: "select",
        default: "1",
        options: [
          { value: "1", label: "1 page" },
          { value: "2", label: "2 pages, side by side" },
          { value: "4", label: "4 pages, in a grid" },
        ],
      },
    ],
    note: "Pages stay sharp and text stays selectable. Form fields are flattened first.",
    run: async (files, o, ctx) => (await kit()).resizeTool(files, o, ctx),
  },
  "repair-pdf": {
    cancellable: true,
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [],
    note: "Works on a copy: your original stays as it is.",
    run: async (files, _o, ctx) => (await kit()).repairTool(files, ctx),
  },
  "compress-pdf": {
    cancellable: true,
    reportsSizeChange: true,
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "quality",
        label: "Quality",
        type: "select",
        default: "balanced",
        options: [
          { value: "smallest", label: "Smallest file" },
          { value: "balanced", label: "Recommended" },
          { value: "high", label: "High quality" },
        ],
      },
    ],
    run: async (files, o, ctx) => (await kit()).compressTool(files, { quality: o.quality }, ctx),
  },
  "compress-video": {
    reportsSizeChange: true,
    cancellable: true,
    accept: "video/mp4,video/quicktime,video/webm,video/x-m4v",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "quality",
        label: "Quality",
        type: "select",
        default: "recommended",
        options: [
          { value: "small", label: "Smallest file" },
          { value: "recommended", label: "Recommended" },
          { value: "high", label: "High quality" },
        ],
      },
    ],
    note: "Up to 4K. Long videos take a few minutes.",
    run: async (files, o, ctx) => {
      const { compressVideoTool } = await import("@/lib/video-compress");
      return compressVideoTool(files, { quality: o.quality }, ctx);
    },
  },
  "pdf-to-jpg": {
    cancellable: true,
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
  "jpg-to-pdf": imageTool(ALL_FORMATS),
  "png-to-pdf": imageTool(["png"]),
  "webp-to-pdf": imageTool(["webp"]),
  // Only Safari opens HEIC: the page checks when it opens and says so before a file is picked.
  "heic-to-pdf": { ...imageTool(["heic"]), needs: "heic" },
  "tiff-to-pdf": imageTool(["tiff"]),
  "svg-to-pdf": { ...imageTool(["svg"]), note: "Each SVG becomes a picture sharp enough to print." },
  "txt-to-pdf": textTool(false),
  "markdown-to-pdf": textTool(true),
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
    cancellable: true,
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
  "flatten-pdf": {
    cancellable: true,
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [
      {
        key: "mode",
        label: "What to flatten",
        type: "select",
        default: "annotations",
        wide: true,
        options: [
          {
            value: "forms",
            label: "Form fields only",
            hint: "Filled-in fields become part of the page; comments stay editable.",
          },
          {
            value: "annotations",
            label: "Fields and comments",
            hint: "Fields, comments and stamps become part of the page; text stays selectable and links still work.",
          },
          {
            value: "images",
            label: "Pages as images",
            hint: "Most secure: each page becomes a picture, so nothing on it can be edited, but the file is bigger and text can't be selected.",
          },
        ],
      },
      {
        key: "dpi",
        label: "Resolution",
        type: "select",
        default: "150",
        showIf: { key: "mode", value: "images" },
        options: [
          { value: "100", label: "100 DPI (smaller file)" },
          { value: "150", label: "150 DPI" },
          { value: "200", label: "200 DPI" },
          { value: "300", label: "300 DPI (for print)" },
        ],
      },
      {
        key: "text",
        label: "Keep the text searchable",
        type: "checkbox",
        default: "",
        showIf: { key: "mode", value: "images" },
        hint: "Adds the page's text invisibly, so search and copy still work.",
      },
    ],
    note: "Keep your original: flattened fields can't be edited again.",
    run: async (files, o, ctx) => (await kit()).flattenTool(files, { mode: o.mode, dpi: o.dpi, text: o.text }, ctx),
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
