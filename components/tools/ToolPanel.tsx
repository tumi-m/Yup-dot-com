"use client";

import { lazy, Suspense, type ReactNode } from "react";
import type { Tier } from "@/lib/limits";
import { placeholderSize, ToolPlaceholder, type PanelSpec } from "./panel-spec";

// Each panel is its own chunk, so a tool page only downloads its own tool.
const EditorLaunch = lazy(() => import("./EditorLaunch").then((m) => ({ default: m.EditorLaunch })));
const PdfAssistant = lazy(() => import("./PdfAssistant").then((m) => ({ default: m.PdfAssistant })));
const MediaDownloader = lazy(() => import("./MediaDownloader").then((m) => ({ default: m.MediaDownloader })));
const PlaylistDownloader = lazy(() => import("./PlaylistDownloader").then((m) => ({ default: m.PlaylistDownloader })));
const PptxToPdf = lazy(() => import("./PptxToPdf").then((m) => ({ default: m.PptxToPdf })));
const PptxEditor = lazy(() => import("./PptxEditor").then((m) => ({ default: m.PptxEditor })));
const SlidesImporter = lazy(() => import("./SlidesImporter").then((m) => ({ default: m.SlidesImporter })));
const ToolWorkbench = lazy(() => import("./ToolWorkbench").then((m) => ({ default: m.ToolWorkbench })));

export function ToolPanel({ spec, tier }: { spec: PanelSpec; tier: Tier }) {
  return <Suspense fallback={<ToolPlaceholder className={placeholderSize(spec.kind)} />}>{panel(spec, tier)}</Suspense>;
}

function panel(spec: PanelSpec, tier: Tier): ReactNode {
  switch (spec.kind) {
    case "editor":
      return <EditorLaunch tier={tier} />;
    case "assistant":
      return <PdfAssistant tier={tier} />;
    case "media":
      return <MediaDownloader config={spec.media} tier={tier} />;
    case "playlist":
      return <PlaylistDownloader tier={tier} />;
    case "pptx-to-pdf":
      return <PptxToPdf tier={tier} />;
    case "pptx-editor":
      return <PptxEditor tier={tier} />;
    case "slides-import":
      return <SlidesImporter tier={tier} format={spec.format} />;
    case "workbench":
      return <ToolWorkbench slug={spec.slug} tier={tier} />;
  }
}
