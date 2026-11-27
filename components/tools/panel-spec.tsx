import type { ToolMeta } from "@/lib/tools";

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
  return { kind: "workbench", slug: tool.slug };
}

/** Rendered heights of each kind of tool panel before a file is chosen. */
export function placeholderSize(kind: PanelSpec["kind"], mode?: "sign" | "text"): string {
  // Fill & Sign and Edit PDF text have no Blank page button under Choose PDF on phones.
  if (kind === "editor") return mode ? "h-[244px]" : "h-[296px] sm:h-[244px]";
  if (kind === "assistant") return "h-[300px] sm:h-[272px]";
  if (kind === "media" || kind === "playlist" || kind === "samples") return "h-[206px] sm:h-[150px]";
  if (kind === "slides-import") return "h-[158px] sm:h-[182px]";
  return "h-[292px]";
}

export function ToolPlaceholder({ className }: { className: string }) {
  return <div aria-hidden className={`rounded-2xl border-2 border-dashed border-border bg-card/60 ${className}`} />;
}

