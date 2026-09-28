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
  FileCode2,
  Table2,
  Boxes,
  Lock,
  LockOpen,
  ScanText,
  FileText,
  Sheet,
  MessagesSquare,
  Clapperboard,
  MonitorPlay,
  Film,
  Music2,
  PenLine,
  Signature,
  type LucideIcon,
} from "lucide-react";

export type ToolCategory =
  | "organize"
  | "optimize"
  | "convert"
  | "extract"
  | "security"
  | "edit"
  | "media";

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
  /** Renders a bespoke interface instead of the generic workbench. */
  custom?: "assistant" | "media";
  /** Downloader settings for Video & Audio tools. */
  media?: { platform: "youtube" | "x"; kind: "mp4" | "mp3"; defaultHeight?: number };
  /** Optional ribbon shown on the tool card. */
  badge?: string;
}

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  organize: "Organize",
  optimize: "Optimize",
  convert: "Convert",
  extract: "Extract & Parse",
  security: "Security",
  media: "Video & Audio",
  edit: "Edit & Sign",
};

export const TOOLS: ToolMeta[] = [
  {
    slug: "merge-pdf",
    name: "Merge PDF",
    title: "Merge PDF: combine PDF files online",
    description: "Combine PDFs into one.",
    icon: Combine,
    category: "organize",
    tint: "bg-violet-100 text-violet-700",
  },
  {
    slug: "split-pdf",
    name: "Split PDF",
    title: "Split PDF: extract pages from a PDF",
    description: "Split by page ranges or into single pages.",
    icon: Scissors,
    category: "organize",
    tint: "bg-fuchsia-100 text-fuchsia-700",
  },
  {
    slug: "rotate-pdf",
    name: "Rotate PDF",
    title: "Rotate PDF: turn pages the right way up",
    description: "Turn pages the right way up.",
    icon: RotateCw,
    category: "organize",
    tint: "bg-indigo-100 text-indigo-700",
  },
  {
    slug: "compress-pdf",
    name: "Compress PDF",
    title: "Compress PDF: reduce PDF file size",
    description: "Make a PDF smaller.",
    icon: Minimize2,
    category: "optimize",
    tint: "bg-emerald-100 text-emerald-700",
  },
  {
    slug: "pdf-to-jpg",
    name: "PDF to JPG",
    title: "PDF to JPG: convert PDF pages to images",
    description: "Each page as an image.",
    icon: ImageIcon,
    category: "convert",
    tint: "bg-amber-100 text-amber-700",
  },
  {
    slug: "jpg-to-pdf",
    name: "JPG to PDF",
    title: "JPG to PDF: convert images to a PDF",
    description: "Images into one PDF.",
    icon: FileImage,
    category: "convert",
    tint: "bg-orange-100 text-orange-700",
  },
  {
    slug: "pdf-to-text",
    name: "PDF to Text",
    title: "PDF to Text: extract text in reading order",
    description: "Plain text in reading order.",
    icon: FileType2,
    category: "extract",
    tint: "bg-sky-100 text-sky-700",
  },
  {
    slug: "pdf-to-markdown",
    name: "PDF to Markdown",
    title: "PDF to Markdown: layout-aware conversion",
    description: "Clean Markdown with structure kept.",
    icon: FileCode2,
    category: "extract",
    tint: "bg-blue-100 text-blue-700",
  },
  {
    slug: "extract-tables",
    name: "Extract Tables",
    title: "Extract Tables from PDF to CSV",
    description: "Every table as CSV.",
    icon: Table2,
    category: "extract",
    tint: "bg-lime-100 text-lime-700",
  },
  {
    slug: "pdf-to-chunks",
    name: "PDF to RAG Chunks",
    title: "PDF to RAG Chunks: JSON for AI pipelines",
    description: "JSON chunks for AI pipelines.",
    icon: Boxes,
    category: "extract",
    tint: "bg-teal-100 text-teal-700",
  },
  {
    slug: "pdf-to-word",
    name: "PDF to Word",
    title: "PDF to Word: convert PDF to editable DOCX",
    description: "Editable DOCX with headings and tables.",
    icon: FileText,
    category: "convert",
    tint: "bg-blue-100 text-blue-700",
  },
  {
    slug: "pdf-to-excel",
    name: "PDF to Excel",
    title: "PDF to Excel: pull tables into XLSX",
    description: "Tables into spreadsheets.",
    icon: Sheet,
    category: "convert",
    tint: "bg-green-100 text-green-700",
  },
  {
    slug: "chat-with-pdf",
    name: "AI Assistant",
    title: "Chat with PDF: summarize and ask questions",
    description: "Summarise a PDF and ask questions.",
    icon: MessagesSquare,
    category: "extract",
    tint: "bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700",
    badge: "AI",
    custom: "assistant",
  },
  {
    slug: "ocr-pdf",
    name: "OCR PDF",
    title: "OCR PDF: make scanned PDFs searchable",
    description: "Make scans searchable.",
    icon: ScanText,
    category: "extract",
    tint: "bg-indigo-100 text-indigo-700",
  },
  {
    slug: "protect-pdf",
    name: "Protect PDF",
    title: "Protect PDF: add a password to a PDF",
    description: "Add a password.",
    icon: Lock,
    category: "security",
    tint: "bg-red-100 text-red-700",
  },
  {
    slug: "unlock-pdf",
    name: "Unlock PDF",
    title: "Unlock PDF: remove a PDF password",
    description: "Remove a password.",
    icon: LockOpen,
    category: "security",
    tint: "bg-yellow-100 text-yellow-800",
  },
  {
    slug: "page-numbers",
    name: "Page Numbers",
    title: "Add Page Numbers to a PDF",
    description: "Number every page.",
    icon: Hash,
    category: "edit",
    tint: "bg-rose-100 text-rose-700",
  },
  {
    slug: "watermark-pdf",
    name: "Watermark",
    title: "Watermark PDF: stamp text over every page",
    description: "Stamp text across every page.",
    icon: Stamp,
    category: "edit",
    tint: "bg-purple-100 text-purple-700",
  },
  {
    slug: "edit-pdf",
    name: "Edit PDF",
    title: "Edit PDF: annotate, draw, and add text",
    description: "Add text, shapes, links and form fields.",
    icon: PenLine,
    category: "edit",
    tint: "bg-teal-100 text-teal-700",
    editor: true,
  },
  {
    slug: "sign-pdf",
    name: "Fill & Sign",
    title: "Sign PDF: fill forms and add your signature",
    description: "Fill in forms and sign.",
    icon: Signature,
    category: "edit",
    tint: "bg-cyan-100 text-cyan-700",
    editor: true,
  },
  {
    slug: "youtube-to-mp4",
    name: "YouTube to MP4",
    title: "YouTube to MP4: download videos up to 1080p",
    description: "Save a video as MP4.",
    icon: Clapperboard,
    category: "media",
    tint: "bg-red-100 text-red-700",
    custom: "media",
    media: { platform: "youtube", kind: "mp4", defaultHeight: 720 },
  },
  {
    slug: "youtube-1080p",
    name: "YouTube 1080p",
    title: "YouTube 1080p Downloader: Full HD MP4",
    description: "Full HD MP4 with sound.",
    icon: MonitorPlay,
    category: "media",
    tint: "bg-gradient-to-br from-amber-100 to-fuchsia-100 text-fuchsia-700",
    badge: "Pro",
    custom: "media",
    media: { platform: "youtube", kind: "mp4", defaultHeight: 1080 },
  },
  {
    slug: "youtube-720p",
    name: "YouTube 720p",
    title: "YouTube 720p Downloader: free HD MP4",
    description: "HD MP4, free.",
    icon: MonitorPlay,
    category: "media",
    tint: "bg-rose-100 text-rose-700",
    custom: "media",
    media: { platform: "youtube", kind: "mp4", defaultHeight: 720 },
  },
  {
    slug: "x-to-mp4",
    name: "X (Twitter) to MP4",
    title: "X (Twitter) Video Downloader: save as MP4",
    description: "Save an X video as MP4.",
    icon: Film,
    category: "media",
    tint: "bg-zinc-200 text-zinc-800",
    custom: "media",
    media: { platform: "x", kind: "mp4", defaultHeight: 720 },
  },
  {
    slug: "x-to-mp3",
    name: "X (Twitter) to MP3",
    title: "X (Twitter) to MP3: extract the audio",
    description: "Save an X video's audio.",
    icon: Music2,
    category: "media",
    tint: "bg-sky-100 text-sky-800",
    custom: "media",
    media: { platform: "x", kind: "mp3" },
  },
];

export function getTool(slug: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.slug === slug);
}

export const WORKBENCH_TOOLS = TOOLS.filter((t) => !t.editor);
