import type { ToolMeta } from "@/lib/tools";
import type { OfficeTool } from "@/lib/office";

/** Which panel a tool page shows; plain data, so a server page can pass it to ToolPanel. */
export type PanelSpec =
  | { kind: "editor"; mode?: "sign" | "text" }
  | { kind: "assistant" }
  | { kind: "media"; media: NonNullable<ToolMeta["media"]> }
  | { kind: "playlist" }
  | { kind: "pptx-to-pdf" }
  | { kind: "pptx-editor" }
  | { kind: "slides-import"; format: "pdf" | "pptx" }
  | { kind: "samples" }
  | { kind: "pages"; mode: NonNullable<ToolMeta["pages"]>["mode"]; slug: string }
  | { kind: "crop"; slug: string }
  | { kind: "compare"; slug: string }
  | { kind: "redact"; slug: string }
  | { kind: "scan"; slug: string }
  | { kind: "translate"; slug: string }
  | { kind: "office"; tool: OfficeTool }
  | { kind: "web-to-pdf"; slug: string }
  | { kind: "workbench"; slug: string };

export function panelSpec(tool: ToolMeta): PanelSpec {
  if (tool.editor) return tool.slug === "sign-pdf" ? { kind: "editor", mode: "sign" } : tool.slug === "edit-pdf-text" ? { kind: "editor", mode: "text" } : { kind: "editor" };
  if (tool.custom === "assistant") return { kind: "assistant" };
  if (tool.custom === "media" && tool.media) return { kind: "media", media: tool.media };
  if (tool.custom === "playlist") return { kind: "playlist" };
  if (tool.custom === "pptx-to-pdf") return { kind: "pptx-to-pdf" };
  if (tool.custom === "pptx-editor") return { kind: "pptx-editor" };
  if (tool.custom === "slides-import" && tool.slides) return { kind: "slides-import", format: tool.slides.format };
  if (tool.custom === "samples") return { kind: "samples" };
  if (tool.custom === "pages" && tool.pages) return { kind: "pages", mode: tool.pages.mode, slug: tool.slug };
  if (tool.custom === "crop") return { kind: "crop", slug: tool.slug };
  if (tool.custom === "compare") return { kind: "compare", slug: tool.slug };
  if (tool.custom === "redact") return { kind: "redact", slug: tool.slug };
  if (tool.custom === "scan") return { kind: "scan", slug: tool.slug };
  if (tool.custom === "translate") return { kind: "translate", slug: tool.slug };
  if (tool.custom === "office") return { kind: "office", tool: tool.slug as OfficeTool };
  if (tool.custom === "web-to-pdf") return { kind: "web-to-pdf", slug: tool.slug };
  return { kind: "workbench", slug: tool.slug };
}

const SCAN_HEIGHT = [
  "h-[610px] min-[420px]:h-[552px] sm:h-[312px]",
  "[@media(hover:none)_and_(pointer:coarse)]:h-[340px]",
  "[@media(hover:none)_and_(pointer:coarse)_and_(min-width:380px)]:h-[324px]",
  "[@media(hover:none)_and_(pointer:coarse)_and_(min-width:480px)]:h-[252px]",
].join(" ");

/** Rendered heights of each kind of tool panel before a file is chosen. */
export function placeholderSize(kind: PanelSpec["kind"], mode?: "sign" | "text"): string {
  // Fill & Sign and Edit PDF text have no Blank page button under Choose PDF on phones.
  if (kind === "editor") return mode ? "h-[244px]" : "h-[296px] sm:h-[244px]";
  if (kind === "assistant") return "h-[300px] sm:h-[272px]";
  if (kind === "media" || kind === "playlist" || kind === "samples") return "h-[206px] sm:h-[150px]";
  if (kind === "slides-import") return "h-[158px] sm:h-[182px]";
  if (kind === "translate") return "h-[308px] sm:h-[276px]";
  // The drop zone's upload note wraps to two lines on a phone.
  if (kind === "office") return "h-[348px] sm:h-[332px]";
  // Scan to PDF lays out by the pointer, as the tool does (a finger and no
  // hover: the camera button and its tip, which wraps below 380 px, and a
  // shorter panel on a tablet); with a mouse, the QR code card sits beside
  // the drop zone from sm up and above it in a narrow window.
  if (kind === "scan") return SCAN_HEIGHT;
  return "h-[292px]";
}

export function ToolPlaceholder({ className }: { className: string }) {
  return <div aria-hidden className={`rounded-2xl border-2 border-dashed border-border bg-card/60 ${className}`} />;
}

