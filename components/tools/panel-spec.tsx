import type { ToolMeta } from "@/lib/tools";

/** Which panel a tool page shows; plain data, so a server page can pass it to ToolPanel. */
export type PanelSpec =
  | { kind: "editor" }
  | { kind: "assistant" }
  | { kind: "media"; media: NonNullable<ToolMeta["media"]> }
  | { kind: "playlist" }
  | { kind: "pptx-to-pdf" }
  | { kind: "pptx-editor" }
  | { kind: "slides-import"; format: "pdf" | "pptx" }
  | { kind: "workbench"; slug: string };

export function panelSpec(tool: ToolMeta): PanelSpec {
  if (tool.editor) return { kind: "editor" };
  if (tool.custom === "assistant") return { kind: "assistant" };
  if (tool.custom === "media" && tool.media) return { kind: "media", media: tool.media };
  if (tool.custom === "playlist") return { kind: "playlist" };
  if (tool.custom === "pptx-to-pdf") return { kind: "pptx-to-pdf" };
  if (tool.custom === "pptx-editor") return { kind: "pptx-editor" };
  if (tool.custom === "slides-import" && tool.slides) return { kind: "slides-import", format: tool.slides.format };
  return { kind: "workbench", slug: tool.slug };
}

/** Rendered heights of each kind of tool panel before a file is chosen. */
export function placeholderSize(kind: PanelSpec["kind"]): string {
  if (kind === "editor") return "h-[288px] sm:h-[240px]";
  if (kind === "assistant") return "h-[300px] sm:h-[272px]";
  if (kind === "media" || kind === "playlist") return "h-[206px] sm:h-[150px]";
  if (kind === "slides-import") return "h-[182px]";
  return "h-[292px]";
}

export function ToolPlaceholder({ className }: { className: string }) {
  return <div aria-hidden className={`rounded-2xl border-2 border-dashed border-border bg-card/60 ${className}`} />;
}

