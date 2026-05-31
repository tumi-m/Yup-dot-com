import {
  Combine,
  Scissors,
  Minimize2,
  Image as ImageIcon,
  FileImage,
  RotateCw,
  Hash,
  Stamp,
  FileType2,
  PenLine,
  Signature,
  type LucideIcon,
} from "lucide-react";

export type ToolCategory = "organize" | "optimize" | "convert" | "edit";

export interface ToolMeta {
  slug: string;
  /** Short label for cards/nav. */
  name: string;
  /** SEO <title> / page heading. */
  title: string;
  description: string;
  icon: LucideIcon;
  category: ToolCategory;
  /** Tailwind classes for the icon tile. */
  tint: string;
  /** If set, this tool opens the full editor instead of the workbench. */
  editor?: boolean;
}

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  organize: "Organize",
  optimize: "Optimize",
  convert: "Convert",
  edit: "Edit & Sign",
};

export const TOOLS: ToolMeta[] = [
  {
    slug: "merge-pdf",
    name: "Merge PDF",
    title: "Merge PDF — combine PDF files online",
    description:
      "Combine multiple PDFs into one document in the order you choose. Fast, free, and private — files never leave your browser.",
    icon: Combine,
    category: "organize",
    tint: "bg-violet-100 text-violet-700",
  },
  {
    slug: "split-pdf",
    name: "Split PDF",
    title: "Split PDF — extract pages from a PDF",
    description:
      "Split a PDF into separate files by page ranges, or extract every page into its own document.",
    icon: Scissors,
    category: "organize",
    tint: "bg-fuchsia-100 text-fuchsia-700",
  },
  {
    slug: "rotate-pdf",
    name: "Rotate PDF",
    title: "Rotate PDF — turn pages the right way up",
    description:
      "Rotate all pages of a PDF by 90, 180, or 270 degrees and save the result instantly.",
    icon: RotateCw,
    category: "organize",
    tint: "bg-indigo-100 text-indigo-700",
  },
  {
    slug: "compress-pdf",
    name: "Compress PDF",
    title: "Compress PDF — reduce PDF file size",
    description:
      "Shrink large PDFs by recompressing pages. Great for email attachments and uploads.",
    icon: Minimize2,
    category: "optimize",
    tint: "bg-emerald-100 text-emerald-700",
  },
  {
    slug: "pdf-to-jpg",
    name: "PDF to JPG",
    title: "PDF to JPG — convert PDF pages to images",
    description:
      "Turn every page of a PDF into a high-quality JPG or PNG image, downloaded as a zip.",
    icon: ImageIcon,
    category: "convert",
    tint: "bg-amber-100 text-amber-700",
  },
  {
    slug: "jpg-to-pdf",
    name: "JPG to PDF",
    title: "JPG to PDF — convert images to a PDF",
    description:
      "Combine JPG and PNG images into a single PDF. Choose page size and margins.",
    icon: FileImage,
    category: "convert",
    tint: "bg-orange-100 text-orange-700",
  },
  {
    slug: "pdf-to-text",
    name: "PDF to Text",
    title: "PDF to Text — extract text from a PDF",
    description:
      "Pull all selectable text out of a PDF into a clean .txt file in seconds.",
    icon: FileType2,
    category: "convert",
    tint: "bg-sky-100 text-sky-700",
  },
  {
    slug: "page-numbers",
    name: "Page Numbers",
    title: "Add Page Numbers to a PDF",
    description:
      "Insert page numbers into your PDF with your choice of position and format.",
    icon: Hash,
    category: "edit",
    tint: "bg-rose-100 text-rose-700",
  },
  {
    slug: "watermark-pdf",
    name: "Watermark",
    title: "Watermark PDF — stamp text over every page",
    description:
      "Add a diagonal text watermark across every page with custom colour and opacity.",
    icon: Stamp,
    category: "edit",
    tint: "bg-purple-100 text-purple-700",
  },
  {
    slug: "edit-pdf",
    name: "Edit PDF",
    title: "Edit PDF — annotate, draw, and add text",
    description:
      "Open the full editor to add text, highlights, drawings, and rearrange pages.",
    icon: PenLine,
    category: "edit",
    tint: "bg-teal-100 text-teal-700",
    editor: true,
  },
  {
    slug: "sign-pdf",
    name: "Fill & Sign",
    title: "Sign PDF — fill forms and add your signature",
    description:
      "Open the editor to fill out forms and drop your signature anywhere on the page.",
    icon: Signature,
    category: "edit",
    tint: "bg-cyan-100 text-cyan-700",
    editor: true,
  },
];

export function getTool(slug: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.slug === slug);
}

export const WORKBENCH_TOOLS = TOOLS.filter((t) => !t.editor);
