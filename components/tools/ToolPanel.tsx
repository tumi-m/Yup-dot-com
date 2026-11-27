"use client";

import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isLoadError, loadErrorMessage } from "@/lib/load-error";
import type { Tier } from "@/lib/limits";
import { placeholderSize, ToolPlaceholder, type PanelSpec } from "./panel-spec";

// Each panel is its own chunk, so a tool page only downloads its own tool.
// React keeps a lazy component's failed load for good, so after a failure
// (offline, a flaky connection, a deploy that replaced the chunk) Try again
// makes a fresh set that asks for the chunk again.
function makePanels() {
  return {
    EditorLaunch: lazy(() => import("./EditorLaunch").then((m) => ({ default: m.EditorLaunch }))),
    PdfAssistant: lazy(() => import("./PdfAssistant").then((m) => ({ default: m.PdfAssistant }))),
    MediaDownloader: lazy(() => import("./MediaDownloader").then((m) => ({ default: m.MediaDownloader }))),
    PlaylistDownloader: lazy(() => import("./PlaylistDownloader").then((m) => ({ default: m.PlaylistDownloader }))),
    PptxToPdf: lazy(() => import("./PptxToPdf").then((m) => ({ default: m.PptxToPdf }))),
    PptxEditor: lazy(() => import("./PptxEditor").then((m) => ({ default: m.PptxEditor }))),
    SampleFinder: lazy(() => import("./SampleFinder").then((m) => ({ default: m.SampleFinder }))),
    SlidesImporter: lazy(() => import("./SlidesImporter").then((m) => ({ default: m.SlidesImporter }))),
    PageOrganizer: lazy(() => import("./PageOrganizer").then((m) => ({ default: m.PageOrganizer }))),
    CropTool: lazy(() => import("./CropTool").then((m) => ({ default: m.CropTool }))),
    CompareTool: lazy(() => import("./CompareTool").then((m) => ({ default: m.CompareTool }))),
    RedactTool: lazy(() => import("./RedactTool").then((m) => ({ default: m.RedactTool }))),
    ScanTool: lazy(() => import("./ScanTool").then((m) => ({ default: m.ScanTool }))),
    TranslateTool: lazy(() => import("./TranslateTool").then((m) => ({ default: m.TranslateTool }))),
    OfficeToPdf: lazy(() => import("./OfficeToPdf").then((m) => ({ default: m.OfficeToPdf }))),
    WebToPdf: lazy(() => import("./WebToPdf").then((m) => ({ default: m.WebToPdf }))),
    ToolWorkbench: lazy(() => import("./ToolWorkbench").then((m) => ({ default: m.ToolWorkbench }))),
  };
}
let panels = makePanels();

export function ToolPanel({ spec, tier }: { spec: PanelSpec; tier: Tier }) {
  const [attempt, setAttempt] = useState(0);
  const size = placeholderSize(spec.kind, spec.kind === "editor" ? spec.mode : undefined);
  const retry = () => {
    panels = makePanels();
    setAttempt((n) => n + 1);
  };
  return (
    <PanelBoundary key={attempt} size={size} onRetry={retry}>
      <Suspense fallback={<ToolPlaceholder className={size} />}>{panel(spec, tier)}</Suspense>
    </PanelBoundary>
  );
}

/**
 * A panel that failed to load or broke says so in its own place, with Try
 * again, instead of taking the whole page down with it.
 */
class PanelBoundary extends Component<{ size: string; onRetry: () => void; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className={`flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-border bg-card/60 p-6 text-center ${this.props.size}`}
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          {isLoadError(error) ? loadErrorMessage() : "Something went wrong with the tool. Try again."}
        </p>
        <Button onClick={this.props.onRetry}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
}

function panel(spec: PanelSpec, tier: Tier): ReactNode {
  switch (spec.kind) {
    case "editor":
      return <panels.EditorLaunch tier={tier} mode={spec.mode} />;
    case "assistant":
      return <panels.PdfAssistant tier={tier} />;
    case "media":
      return <panels.MediaDownloader config={spec.media} tier={tier} />;
    case "playlist":
      return <panels.PlaylistDownloader tier={tier} />;
    case "pptx-to-pdf":
      return <panels.PptxToPdf tier={tier} />;
    case "pptx-editor":
      return <panels.PptxEditor tier={tier} />;
    case "slides-import":
      return <panels.SlidesImporter tier={tier} format={spec.format} />;
    case "samples":
      return <panels.SampleFinder tier={tier} />;
    case "pages":
      return <panels.PageOrganizer mode={spec.mode} slug={spec.slug} tier={tier} />;
    case "crop":
      return <panels.CropTool slug={spec.slug} tier={tier} />;
    case "compare":
      return <panels.CompareTool slug={spec.slug} tier={tier} />;
    case "redact":
      return <panels.RedactTool slug={spec.slug} tier={tier} />;
    case "scan":
      return <panels.ScanTool slug={spec.slug} tier={tier} />;
    case "translate":
      return <panels.TranslateTool slug={spec.slug} tier={tier} />;
    case "office":
      return <panels.OfficeToPdf tool={spec.tool} tier={tier} />;
    case "web-to-pdf":
      return <panels.WebToPdf slug={spec.slug} tier={tier} />;
    case "workbench":
      return <panels.ToolWorkbench slug={spec.slug} tier={tier} />;
  }
}
