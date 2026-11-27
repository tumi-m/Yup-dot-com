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
  Music,
  Video,
  Instagram,
  AudioLines,
  ListVideo,
  PenLine,
  Signature,
  Presentation,
  PencilRuler,
  GalleryHorizontalEnd,
  FileDown,
  FileSliders,
  Shrink,
  Disc3,
  LayoutGrid,
  FileMinus,
  FileOutput,
  Layers,
  Scaling,
  Crop,
  Images,
  ImageUp,
  Camera,
  Layers2,
  PenTool,
  LetterText,
  Heading,
  Wrench,
  FileDiff,
  EyeOff,
  ScanLine,
  TextCursor,
  Languages,
  FileType,
  FileSpreadsheet,
  Globe,
  Archive,
  type LucideIcon,
} from "lucide-react";
import { YOUTUBE_ENABLED, type MediaPlatform } from "./media";
import { OFFICE_ENABLED } from "./office";
import { HTML_TO_PDF_ENABLED } from "./web-pdf";
import type { PagesMode } from "./pdf/pages/plan";

export type ToolCategory =
  | "organize"
  | "optimize"
  | "convert"
  | "extract"
  | "security"
  | "edit"
  | "slides"
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
  custom?: "assistant" | "media" | "playlist" | "pptx-to-pdf" | "pptx-editor" | "slides-import" | "samples" | "pages" | "crop" | "compare" | "redact" | "scan" | "translate" | "office" | "web-to-pdf";
  /** Page grid settings: what the picked pages are for. */
  pages?: { mode: PagesMode };
  /** Google Slides import settings: which file the deck is fetched as. */
  slides?: { format: "pdf" | "pptx" };
  /** Downloader settings for Video & Audio tools. */
  media?: { platform: MediaPlatform; kind: "mp4" | "mp3"; defaultHeight?: number };
  /** Optional ribbon shown on the tool card. */
  badge?: string;
  /** Extra words the tools search matches (never shown). */
  keywords?: string;
  /** Other names people search it by ("Image to PDF"): ranked as its name is. */
  aliases?: string[];
}

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  organize: "Organize",
  optimize: "Optimize",
  convert: "Convert",
  extract: "Extract & Parse",
  security: "Security",
  slides: "Slides",
  media: "Video & Audio",
  edit: "Edit & Sign",
};

const ALL_TOOLS: ToolMeta[] = [
  {
    slug: "merge-pdf",
    name: "Merge PDF",
    title: "Merge PDF: combine PDF files online",
    description: "Combine PDFs into one.",
    icon: Combine,
    category: "organize",
    tint: "bg-violet-100 text-violet-700",
    keywords: "join combine organise",
  },
  {
    slug: "split-pdf",
    name: "Split PDF",
    title: "Split PDF: split a PDF into separate files",
    description: "Split by page ranges or into single pages.",
    icon: Scissors,
    category: "organize",
    tint: "bg-fuchsia-100 text-fuchsia-700",
    keywords: "extract separate organise",
  },
  {
    slug: "organize-pdf",
    name: "Organize PDF",
    title: "Organize PDF: reorder, rotate and delete pages",
    description: "Move, turn, add and delete pages.",
    icon: LayoutGrid,
    category: "organize",
    tint: "bg-purple-100 text-purple-700",
    custom: "pages",
    pages: { mode: "organize" },
    keywords: "organise organiser organizer rearrange reorder sort move order reverse insert blank page pages",
  },
  {
    slug: "delete-pages",
    name: "Delete Pages",
    title: "Delete pages from a PDF",
    description: "Remove the pages you don't need.",
    icon: FileMinus,
    category: "organize",
    tint: "bg-rose-100 text-rose-700",
    custom: "pages",
    pages: { mode: "delete" },
    keywords: "remove pages delete page cut organise",
  },
  {
    slug: "extract-pages",
    name: "Extract Pages",
    title: "Extract pages from a PDF into a new PDF",
    description: "Save the pages you pick as one PDF.",
    icon: FileOutput,
    category: "organize",
    tint: "bg-sky-100 text-sky-700",
    custom: "pages",
    pages: { mode: "extract" },
    keywords: "select pages pick pages save pages copy pages pull out organise",
  },
  {
    slug: "rotate-pdf",
    name: "Rotate PDF",
    title: "Rotate PDF: turn pages the right way up",
    description: "Turn pages the right way up.",
    icon: RotateCw,
    category: "organize",
    tint: "bg-indigo-100 text-indigo-700",
    keywords: "organise",
  },
  {
    slug: "resize-pdf",
    name: "Resize PDF",
    title: "Resize PDF: change page size to A4 or Letter",
    description: "Make every page one size, or put 2 or 4 on a sheet.",
    icon: Scaling,
    category: "organize",
    tint: "bg-cyan-100 text-cyan-800",
    badge: "New",
    keywords: "page size paper size change size scale fit a4 a3 a5 letter legal tabloid margins n-up 2-up 4-up pages per sheet",
  },
  {
    slug: "crop-pdf",
    name: "Crop PDF",
    title: "Crop PDF: trim margins and cut pages to size",
    description: "Keep the part of the page you choose.",
    icon: Crop,
    category: "organize",
    tint: "bg-lime-100 text-lime-800",
    badge: "New",
    custom: "crop",
    keywords: "crop cut trim margins white space edges border clip area box pages remove",
  },
  {
    slug: "compress-pdf",
    name: "Compress PDF",
    title: "Compress PDF: reduce PDF file size",
    description: "Make a PDF smaller.",
    icon: Minimize2,
    category: "optimize",
    tint: "bg-emerald-100 text-emerald-700",
    keywords: "shrink reduce size smaller organise",
  },
  {
    slug: "repair-pdf",
    name: "Repair PDF",
    title: "Repair PDF: fix a damaged or corrupt PDF",
    description: "Recover a PDF that won't open.",
    icon: Wrench,
    category: "optimize",
    tint: "bg-amber-100 text-amber-800",
    badge: "New",
    keywords: "repair fix recover restore corrupt corrupted damaged broken file won't open cannot open truncated xref error",
  },
  {
    slug: "pdf-to-jpg",
    name: "PDF to JPG",
    title: "PDF to JPG: convert PDF pages to images",
    description: "Each page as an image.",
    icon: ImageIcon,
    category: "convert",
    tint: "bg-amber-100 text-amber-700",
    keywords: "png jpeg image photo picture",
  },
  {
    slug: "jpg-to-pdf",
    name: "JPG to PDF",
    title: "JPG to PDF: convert images and photos to PDF",
    description: "Photos and pictures into one PDF.",
    icon: FileImage,
    category: "convert",
    tint: "bg-orange-100 text-orange-700",
    keywords: "png jpeg image photo picture webp gif bmp tiff avif heic svg",
    aliases: ["Image to PDF", "Picture to PDF", "Photo to PDF", "JPEG to PDF", "Images to PDF"],
  },
  {
    slug: "scan-to-pdf",
    name: "Scan to PDF",
    title: "Scan to PDF: scan documents with your phone camera",
    description: "Photograph pages with your phone and get one tidy PDF.",
    icon: ScanLine,
    category: "convert",
    tint: "bg-teal-100 text-teal-800",
    badge: "New",
    custom: "scan",
    keywords: "scanner scan document paper camera phone mobile photo receipt letter form contract notes whiteboard flatten perspective crop black white",
    aliases: ["PDF Scanner", "Document Scanner", "Camera to PDF", "Scan Document"],
  },
  {
    slug: "png-to-pdf",
    name: "PNG to PDF",
    title: "PNG to PDF: convert PNG images to a PDF",
    description: "PNG images into one PDF.",
    icon: Images,
    category: "convert",
    tint: "bg-sky-100 text-sky-800",
    keywords: "image screenshot picture transparent",
  },
  {
    slug: "webp-to-pdf",
    name: "WebP to PDF",
    title: "WebP to PDF: convert WebP images to a PDF",
    description: "WebP images into one PDF.",
    icon: ImageUp,
    category: "convert",
    tint: "bg-lime-100 text-lime-800",
    keywords: "image picture web google",
  },
  {
    slug: "heic-to-pdf",
    name: "HEIC to PDF",
    title: "HEIC to PDF: convert iPhone photos to a PDF",
    description: "iPhone photos into one PDF.",
    icon: Camera,
    category: "convert",
    tint: "bg-zinc-200 text-zinc-800",
    keywords: "heif iphone ipad apple ios photo picture",
  },
  {
    slug: "tiff-to-pdf",
    name: "TIFF to PDF",
    title: "TIFF to PDF: convert TIFF scans and faxes to a PDF",
    description: "Every page of a TIFF into one PDF.",
    icon: Layers2,
    category: "convert",
    tint: "bg-stone-200 text-stone-800",
    keywords: "tif scan scanner fax multipage image",
  },
  {
    slug: "svg-to-pdf",
    name: "SVG to PDF",
    title: "SVG to PDF: convert SVG graphics to a PDF",
    description: "SVG logos, icons and drawings into a PDF.",
    icon: PenTool,
    category: "convert",
    tint: "bg-fuchsia-100 text-fuchsia-700",
    keywords: "vector logo icon drawing graphic illustrator inkscape",
  },
  {
    slug: "txt-to-pdf",
    name: "TXT to PDF",
    title: "TXT to PDF: convert text files to PDF",
    description: "A text file as a tidy, printable PDF.",
    icon: LetterText,
    category: "convert",
    tint: "bg-slate-200 text-slate-800",
    keywords: "text plain notepad log code notes csv tsv json xml yaml",
    // CSV is named by Excel to PDF, which lays it out as a table; here it is found by its words.
    aliases: ["Text to PDF", "Log to PDF"],
  },
  {
    slug: "markdown-to-pdf",
    name: "Markdown to PDF",
    title: "Markdown to PDF: convert .md files to PDF",
    description: "Headings, lists, tables and code, laid out as a PDF.",
    icon: Heading,
    category: "convert",
    tint: "bg-indigo-100 text-indigo-700",
    keywords: "md readme notes documentation github",
    aliases: ["MD to PDF"],
  },
  {
    slug: "html-to-pdf",
    name: "HTML to PDF",
    title: "HTML to PDF: save a web page as a PDF",
    description: "Save a web page, an HTML file or pasted HTML as a PDF.",
    icon: Globe,
    category: "convert",
    tint: "bg-sky-100 text-sky-900",
    badge: "New",
    custom: "web-to-pdf",
    keywords: "html htm xhtml url link address web page webpage website site article blog receipt print save convert download offline archive",
    aliases: ["URL to PDF", "Webpage to PDF", "Web Page to PDF", "Website to PDF", "Save Web Page as PDF", "Link to PDF"],
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
    slug: "word-to-pdf",
    name: "Word to PDF",
    title: "Word to PDF: convert DOCX and DOC files to PDF",
    description: "Word documents to PDF, laid out as in Word.",
    icon: FileType,
    category: "convert",
    tint: "bg-indigo-100 text-indigo-800",
    badge: "New",
    custom: "office",
    keywords: "docx doc odt rtf microsoft office word document writer libreoffice openoffice letter cv resume report",
    aliases: ["DOCX to PDF", "DOC to PDF", "ODT to PDF", "RTF to PDF", "Document to PDF"],
  },
  {
    slug: "translate-pdf",
    name: "Translate PDF",
    title: "Translate PDF: translate a document into another language",
    description: "Translate a PDF, as a Word file and, for most languages, a PDF.",
    icon: Languages,
    category: "convert",
    tint: "bg-gradient-to-br from-sky-100 to-violet-100 text-sky-800",
    badge: "AI",
    custom: "translate",
    keywords:
      "translate translation translator translating language languages foreign english afrikaans zulu isizulu xhosa isixhosa sotho sesotho tswana setswana sepedi tsonga xitsonga swati siswati venda tshivenda ndebele isindebele french portuguese spanish german arabic chinese hindi swahili document",
    aliases: ["PDF Translator", "Document Translator", "Translate Document", "Translate a PDF"],
  },
  {
    slug: "pdf-to-pdfa",
    name: "PDF to PDF/A",
    title: "PDF to PDF/A: convert a PDF for long-term archiving",
    description: "An archival PDF/A-2b copy, checked before you download it.",
    icon: Archive,
    category: "convert",
    tint: "bg-stone-200 text-stone-800",
    badge: "New",
    keywords: "pdfa pdf/a pdf/a-2b pdf/a-3b pdf/a-1b 2b 3b archive archival archiving long-term preserve preservation iso 19005 court filing e-filing records compliance validate conform",
    aliases: ["PDF/A Converter", "Archive PDF", "PDF/A-2b", "Convert to PDF/A"],
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
    slug: "excel-to-pdf",
    name: "Excel to PDF",
    title: "Excel to PDF: convert XLSX, XLS and CSV spreadsheets to PDF",
    description: "Spreadsheets to PDF, each sheet fitted to the page.",
    icon: FileSpreadsheet,
    category: "convert",
    tint: "bg-emerald-100 text-emerald-800",
    badge: "New",
    custom: "office",
    keywords: "xlsx xls ods csv spreadsheet sheet sheets workbook microsoft office calc table libreoffice openoffice budget invoice",
    aliases: ["XLSX to PDF", "XLS to PDF", "ODS to PDF", "CSV to PDF", "Spreadsheet to PDF", "Sheet to PDF"],
  },
  {
    slug: "pdf-to-pptx",
    name: "PDF to PPTX",
    title: "PDF to PPTX: turn a PDF into PowerPoint slides",
    description: "Each page as a slide.",
    icon: FileSliders,
    category: "convert",
    tint: "bg-orange-100 text-orange-800",
  },
  {
    slug: "pptx-to-pdf",
    name: "PPTX to PDF",
    title: "PPTX to PDF: convert PowerPoint to PDF",
    description: "PowerPoint slides as a PDF.",
    icon: Presentation,
    category: "slides",
    tint: "bg-orange-100 text-orange-700",
    custom: "pptx-to-pdf",
    keywords: "ppt powerpoint",
  },
  {
    slug: "edit-pptx",
    name: "Edit PPTX",
    title: "Edit PPTX: change PowerPoint text online",
    description: "Edit slide text, then save.",
    icon: PencilRuler,
    category: "slides",
    tint: "bg-rose-100 text-rose-700",
    custom: "pptx-editor",
  },
  {
    slug: "google-slides-to-pdf",
    name: "Google Slides to PDF",
    title: "Google Slides to PDF: download a deck as PDF",
    description: "Save a shared deck as PDF.",
    icon: FileDown,
    category: "slides",
    tint: "bg-yellow-100 text-yellow-800",
    custom: "slides-import",
    slides: { format: "pdf" },
  },
  {
    slug: "google-slides-to-pptx",
    name: "Google Slides to PPTX",
    title: "Google Slides to PPTX: download as PowerPoint",
    description: "Save a shared deck as PPTX.",
    icon: GalleryHorizontalEnd,
    category: "slides",
    tint: "bg-amber-100 text-amber-800",
    custom: "slides-import",
    slides: { format: "pptx" },
  },
  {
    slug: "chat-with-pdf",
    name: "Chat with PDF",
    title: "Chat with PDF: summarise and ask questions",
    description: "Summarise a PDF and ask questions.",
    icon: MessagesSquare,
    category: "extract",
    tint: "bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700",
    badge: "AI",
    custom: "assistant",
    aliases: ["AI Assistant", "Ask PDF", "Summarise PDF", "Summarize PDF"],
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
    keywords: "encrypt lock",
  },
  {
    slug: "unlock-pdf",
    name: "Unlock PDF",
    title: "Unlock PDF: remove a PDF password",
    description: "Remove a password.",
    icon: LockOpen,
    category: "security",
    tint: "bg-yellow-100 text-yellow-800",
    keywords: "decrypt remove password",
  },
  {
    slug: "redact-pdf",
    name: "Redact PDF",
    title: "Redact PDF: black out text and remove it for good",
    description: "Remove names, numbers and areas for good.",
    icon: EyeOff,
    category: "security",
    tint: "bg-slate-200 text-slate-800",
    badge: "New",
    custom: "redact",
    keywords:
      "redact redaction black out blackout censor hide text remove personal information sensitive private confidential anonymize anonymise pii gdpr popia names emails phone card id numbers",
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
    name: "Watermark PDF",
    title: "Watermark PDF: stamp text over every page",
    description: "Stamp text across every page.",
    icon: Stamp,
    category: "edit",
    tint: "bg-purple-100 text-purple-700",
  },
  {
    slug: "flatten-pdf",
    name: "Flatten PDF",
    title: "Flatten PDF: lock form fields and comments",
    description: "Make fields and comments part of the page.",
    icon: Layers,
    category: "edit",
    tint: "bg-sky-100 text-sky-800",
    keywords: "flatten flattened form fields fillable annotations comments lock non-editable read-only print acroform",
  },
  {
    slug: "compare-pdf",
    name: "Compare PDFs",
    title: "Compare PDFs: see what changed between two versions",
    description: "See what changed between two versions.",
    icon: FileDiff,
    category: "edit",
    tint: "bg-orange-100 text-orange-800",
    badge: "New",
    custom: "compare",
    keywords: "compare comparison diff difference differences changes changed versions revision redline track changes contract side by side overlay check two files",
    aliases: ["Compare PDF", "PDF Compare", "Diff PDF", "PDF Diff"],
  },
  {
    slug: "edit-pdf",
    name: "Edit PDF",
    title: "Edit PDF: change text, add text, draw and annotate",
    description: "Change text, add text, shapes, links and form fields.",
    icon: PenLine,
    category: "edit",
    tint: "bg-teal-100 text-teal-700",
    editor: true,
  },
  {
    slug: "edit-pdf-text",
    name: "Edit PDF Text",
    title: "Edit PDF Text: change the existing text in a PDF",
    description: "Click a line and change its text, size or colour.",
    icon: TextCursor,
    category: "edit",
    tint: "bg-emerald-100 text-emerald-800",
    badge: "New",
    editor: true,
    keywords:
      "edit text change text replace text rewrite fix typo spelling correct mistake update modify existing text font size bold italic colour color delete text remove line",
    aliases: ["PDF Text Editor", "Change PDF Text", "Replace Text in PDF", "Edit Text in PDF"],
  },
  {
    slug: "sign-pdf",
    name: "Fill & Sign PDF",
    title: "Fill & Sign PDF: fill in forms and add your signature",
    description: "Fill in forms and sign.",
    icon: Signature,
    category: "edit",
    tint: "bg-cyan-100 text-cyan-700",
    editor: true,
    keywords: "esign signature",
    aliases: ["Sign PDF", "Fill PDF Form"],
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
    keywords: "shorts video downloader",
  },
  {
    slug: "youtube-1080p",
    name: "YouTube 1080p",
    title: "YouTube 1080p: Full HD MP4 downloader",
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
    title: "YouTube 720p: free HD MP4 downloader",
    description: "Save a video in HD as MP4.",
    icon: MonitorPlay,
    category: "media",
    tint: "bg-rose-100 text-rose-700",
    custom: "media",
    media: { platform: "youtube", kind: "mp4", defaultHeight: 720 },
  },
  {
    slug: "youtube-to-mp3",
    name: "YouTube to MP3",
    title: "YouTube to MP3: save the audio",
    description: "Save a video's audio as MP3.",
    icon: AudioLines,
    category: "media",
    tint: "bg-orange-100 text-orange-700",
    custom: "media",
    media: { platform: "youtube", kind: "mp3" },
    keywords: "shorts music song sound",
  },
  {
    slug: "youtube-playlist",
    name: "YouTube Playlist",
    title: "YouTube Playlist: download as MP4, MP3 or CSV",
    description: "Download a whole playlist, or export its list.",
    icon: ListVideo,
    category: "media",
    tint: "bg-violet-100 text-violet-700",
    custom: "playlist",
  },
  {
    slug: "x-to-mp4",
    name: "X (Twitter) to MP4",
    title: "X (Twitter) to MP4: X video downloader",
    description: "Save an X video as MP4.",
    icon: Film,
    category: "media",
    tint: "bg-zinc-200 text-zinc-800",
    custom: "media",
    media: { platform: "x", kind: "mp4", defaultHeight: 720 },
    keywords: "tweet gif video downloader",
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
    keywords: "tweet sound music",
  },
  {
    slug: "tiktok-to-mp4",
    name: "TikTok to MP4",
    title: "TikTok to MP4: TikTok video downloader",
    description: "Save a TikTok as MP4.",
    icon: Video,
    category: "media",
    tint: "bg-cyan-100 text-cyan-800",
    custom: "media",
    media: { platform: "tiktok", kind: "mp4", defaultHeight: 720 },
    keywords: "video downloader",
  },
  {
    slug: "tiktok-to-mp3",
    name: "TikTok to MP3",
    title: "TikTok to MP3: save the sound",
    description: "Save a TikTok's audio.",
    icon: Music,
    category: "media",
    tint: "bg-pink-100 text-pink-700",
    custom: "media",
    media: { platform: "tiktok", kind: "mp3" },
    aliases: ["TikTok audio", "TikTok sound", "TikTok music"],
  },
  {
    slug: "instagram-to-mp4",
    name: "Instagram to MP4",
    title: "Instagram to MP4: Reels and video downloader",
    description: "Save a Reel or video post as MP4.",
    icon: Instagram,
    category: "media",
    tint: "bg-gradient-to-br from-fuchsia-100 to-amber-100 text-fuchsia-700",
    custom: "media",
    media: { platform: "instagram", kind: "mp4", defaultHeight: 720 },
    keywords: "ig insta reel reels video downloader",
  },
  {
    slug: "instagram-to-mp3",
    name: "Instagram to MP3",
    title: "Instagram to MP3: save a Reel's audio",
    description: "Save a Reel's audio.",
    icon: AudioLines,
    category: "media",
    tint: "bg-amber-100 text-amber-800",
    custom: "media",
    media: { platform: "instagram", kind: "mp3" },
    keywords: "ig insta reel reels sound music",
  },
  {
    slug: "sample-finder",
    name: "Sample Finder",
    title: "Sample Finder: see what samples a song uses",
    description: "See which songs a track samples, from a link or its name.",
    icon: Disc3,
    category: "media",
    tint: "bg-violet-100 text-violet-800",
    badge: "New",
    custom: "samples",
    keywords: "sample samples sampled interpolation cover covers remix music song who sampled",
  },
  {
    slug: "compress-video",
    name: "Compress Video",
    title: "Compress Video: make MP4, MOV and WebM files smaller",
    description: "Make a video smaller, as an MP4.",
    icon: Shrink,
    category: "media",
    tint: "bg-emerald-100 text-emerald-800",
    keywords: "compressor reduce shrink size smaller mp4 mov webm",
    aliases: ["Video Compressor", "Reduce Video Size"],
  },
];

const isYoutubeTool = (t: ToolMeta) => t.media?.platform === "youtube" || t.custom === "playlist";

/**
 * The tools shown with these switches: YouTube's while it isn't paused
 * (lib/media.ts), Word and Excel to PDF once the media worker converts
 * (lib/office.ts), HTML to PDF once it renders (lib/web-pdf.ts). Hidden
 * tools have no page and aren't listed anywhere.
 */
export function shownTools(on: { youtube: boolean; office: boolean; html?: boolean }): ToolMeta[] {
  return ALL_TOOLS.filter(
    (t) => (on.youtube || !isYoutubeTool(t)) && (on.office || t.custom !== "office") && (!!on.html || t.custom !== "web-to-pdf")
  );
}

/** Every tool on the site. */
export const TOOLS: ToolMeta[] = shownTools({ youtube: YOUTUBE_ENABLED, office: OFFICE_ENABLED, html: HTML_TO_PDF_ENABLED });

export function getTool(slug: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.slug === slug);
}

/**
 * "More tools" for the pages whose category neighbours aren't the next step:
 * text and Markdown point at each other, pictures at other picture formats
 * (not PDF to JPG, the opposite way), Crop at the other page-shape tools,
 * Compare at reading and editing the text it found, the two editors at each
 * other and at Redact PDF, which removes what covering only hides,
 * Translate at the other tools that read a document's text, Word and
 * Excel to PDF at each other and the way back (and the way back at them),
 * HTML to PDF at Markdown and what's done with a saved page next, and
 * Compress and Repair at PDF/A, the archival copy.
 */
const RELATED: Record<string, string[]> = {
  "txt-to-pdf": ["markdown-to-pdf", "pdf-to-text", "pdf-to-markdown", "merge-pdf"],
  "markdown-to-pdf": ["txt-to-pdf", "html-to-pdf", "pdf-to-markdown", "pdf-to-text", "merge-pdf"],
  "jpg-to-pdf": ["png-to-pdf", "heic-to-pdf", "tiff-to-pdf", "compress-pdf"],
  "png-to-pdf": ["jpg-to-pdf", "webp-to-pdf", "svg-to-pdf", "compress-pdf"],
  "webp-to-pdf": ["jpg-to-pdf", "png-to-pdf", "svg-to-pdf", "compress-pdf"],
  "heic-to-pdf": ["jpg-to-pdf", "png-to-pdf", "webp-to-pdf", "compress-pdf"],
  "tiff-to-pdf": ["jpg-to-pdf", "ocr-pdf", "png-to-pdf", "compress-pdf"],
  "svg-to-pdf": ["png-to-pdf", "jpg-to-pdf", "webp-to-pdf", "merge-pdf"],
  "crop-pdf": ["resize-pdf", "rotate-pdf", "organize-pdf", "split-pdf"],
  "resize-pdf": ["crop-pdf", "rotate-pdf", "organize-pdf", "compress-pdf"],
  "repair-pdf": ["compress-pdf", "unlock-pdf", "ocr-pdf", "pdf-to-pdfa", "merge-pdf"],
  "compress-pdf": ["repair-pdf", "pdf-to-pdfa", "protect-pdf", "merge-pdf"],
  // Each way of a conversion offers the other first (a hidden tool is passed over).
  "pdf-to-word": ["word-to-pdf", "pdf-to-excel", "ocr-pdf", "translate-pdf", "compress-pdf"],
  "pdf-to-excel": ["excel-to-pdf", "extract-tables", "pdf-to-word", "ocr-pdf"],
  "pptx-to-pdf": ["word-to-pdf", "excel-to-pdf", "edit-pptx", "pdf-to-pptx", "compress-pdf"],
  "compare-pdf": ["pdf-to-text", "pdf-to-word", "ocr-pdf", "edit-pdf"],
  "redact-pdf": ["protect-pdf", "flatten-pdf", "compress-pdf", "ocr-pdf"],
  "scan-to-pdf": ["ocr-pdf", "jpg-to-pdf", "merge-pdf", "compress-pdf"],
  "edit-pdf-text": ["edit-pdf", "redact-pdf", "sign-pdf", "compress-pdf"],
  "edit-pdf": ["edit-pdf-text", "sign-pdf", "compress-pdf", "redact-pdf"],
  "translate-pdf": ["chat-with-pdf", "pdf-to-word", "ocr-pdf", "compress-pdf"],
  // Office files the other way, and back again.
  "word-to-pdf": ["excel-to-pdf", "pptx-to-pdf", "pdf-to-word", "merge-pdf"],
  "excel-to-pdf": ["word-to-pdf", "pptx-to-pdf", "pdf-to-excel", "merge-pdf"],
  "html-to-pdf": ["markdown-to-pdf", "merge-pdf", "compress-pdf", "edit-pdf"],
  "pdf-to-pdfa": ["compress-pdf", "repair-pdf", "ocr-pdf", "flatten-pdf"],
  // A song's samples, then its sound from the sites people find songs on.
  "sample-finder": ["youtube-to-mp3", "tiktok-to-mp3", "instagram-to-mp3", "x-to-mp3"],
};

/**
 * Four tools to offer under a tool: its own list, else (for a downloader)
 * the same site's other downloaders, then its category's first, then the
 * most used.
 */
export function relatedTools(slug: string): ToolMeta[] {
  const tool = getTool(slug);
  if (!tool) return [];
  const popular = ["merge-pdf", "compress-pdf", "pdf-to-word", "edit-pdf", "ocr-pdf", "sign-pdf"];
  const platform = tool.media?.platform;
  const picks = [
    ...(RELATED[slug] ?? []),
    // X to MP4 offers X to MP3 before the four YouTube pages that lead the category.
    ...(platform ? TOOLS.filter((t) => t.media?.platform === platform || (platform === "youtube" && t.custom === "playlist")).map((t) => t.slug) : []),
    ...TOOLS.filter((t) => t.category === tool.category).map((t) => t.slug),
    ...popular,
  ];
  return [...new Set(picks)]
    .filter((s) => s !== slug)
    .map((s) => getTool(s))
    .filter((t): t is ToolMeta => !!t)
    .slice(0, 4);
}

export const WORKBENCH_TOOLS = TOOLS.filter((t) => !t.editor);

/**
 * Tools that send something to a server: the text to the AI, a link to
 * fetch, or the file itself to convert. Every other tool runs in the
 * browser; the editor does too, but saves to the cloud library when signed in.
 */
const SENDS: ReadonlySet<ToolMeta["custom"]> = new Set(["assistant", "media", "playlist", "slides-import", "samples", "translate", "office", "web-to-pdf"]);

/** Whether a tool's files stay on the visitor's device, whoever they are. */
export function staysOnDevice(tool: ToolMeta): boolean {
  return !tool.editor && !SENDS.has(tool.custom);
}

/**
 * A tool page's search description: its card line, then what it costs and,
 * where true for everyone, that the file isn't uploaded.
 */
export function metaDescription(tool: ToolMeta): string {
  if (tool.badge === "Pro") return `${tool.description} Part of PDF Wizard Pro, nothing to install.`;
  return `${tool.description} Free online, no sign-up, ${staysOnDevice(tool) ? "and your files stay on your device" : "nothing to install"}.`;
}
