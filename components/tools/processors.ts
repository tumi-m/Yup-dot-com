import {
  mergeTool,
  splitTool,
  compressTool,
  pdfToImagesTool,
  imagesToPdfTool,
  rotateTool,
  pageNumbersTool,
  watermarkTool,
  pdfToTextTool,
  type ToolFile,
} from "@/lib/pdf/toolkit";

export type FieldType = "select" | "text" | "range" | "color";

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
  run: (files: File[], options: Record<string, string>) => Promise<ToolFile | ToolFile[]>;
}

export const PROCESSORS: Record<string, ToolProcessor> = {
  "merge-pdf": {
    accept: "application/pdf",
    multiple: true,
    minFiles: 2,
    fields: [],
    run: (files) => mergeTool(files),
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
        label: "Ranges (e.g. 1-3, 5, 8-10)",
        type: "text",
        default: "1-1",
        showIf: { key: "mode", value: "ranges" },
      },
    ],
    run: (files, o) => splitTool(files, { mode: o.mode, ranges: o.ranges }),
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
    run: (files, o) => rotateTool(files, { angle: o.angle }),
  },
  "compress-pdf": {
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
    run: (files, o) => compressTool(files, { quality: o.quality }),
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
    run: (files, o) => pdfToImagesTool(files, { format: o.format, quality: o.quality }),
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
    run: (files, o) => imagesToPdfTool(files, { pageSize: o.pageSize, margin: o.margin }),
  },
  "pdf-to-text": {
    accept: "application/pdf",
    multiple: false,
    minFiles: 1,
    fields: [],
    run: (files) => pdfToTextTool(files),
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
    run: (files, o) =>
      pageNumbersTool(files, {
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
    run: (files, o) =>
      watermarkTool(files, {
        text: o.text,
        fontSize: o.fontSize,
        color: o.color,
        opacity: o.opacity,
      }),
  },
};
