"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  MousePointer2,
  Type,
  Highlighter,
  Pen,
  Signature,
  RotateCw,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Download,
  Save,
  Loader2,
  ArrowLeft,
  FilePlus2,
  MoveLeft,
  MoveRight,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { loadForRender, type LoadedPdf } from "@/lib/pdf/render";
import {
  applyAnnotations,
  rotatePages,
  deletePages,
  reorderPages,
  mergePdfs,
} from "@/lib/pdf/operations";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Annotation, AnnotationType, DocumentRecord, PlanId } from "@/lib/types";
import { PageView, type ToolSettings } from "./PageView";
import { SignaturePad } from "./SignaturePad";

type Tool = AnnotationType | "select";

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#6366f1", "#0f172a"];
const HIGHLIGHT_COLORS = ["#fde047", "#86efac", "#93c5fd", "#fca5a5"];

export function PdfEditor({
  document: doc,
  plan,
}: {
  document: DocumentRecord;
  plan: PlanId;
}) {
  const supabase = createClient();
  const mergeInput = useRef<HTMLInputElement>(null);

  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(0); // 0-indexed
  const [scale, setScale] = useState(1.3);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[5]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [fontSize, setFontSize] = useState(16);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [sigOpen, setSigOpen] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // --- load the PDF bytes from storage ---
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase.storage
        .from("documents")
        .download(doc.storage_path);
      if (!active) return;
      if (error || !data) {
        setLoadError("Could not load this document.");
        return;
      }
      const buf = new Uint8Array(await data.arrayBuffer());
      setBytes(buf);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.storage_path]);

  // --- (re)build the render document whenever bytes change ---
  useEffect(() => {
    if (!bytes) return;
    let active = true;
    let local: LoadedPdf | null = null;
    (async () => {
      try {
        local = await loadForRender(bytes);
        if (!active) {
          local.destroy();
          return;
        }
        setLoaded(local);
        setNumPages(local.numPages);
        setPage((p) => Math.min(p, local!.numPages - 1));
      } catch {
        setLoadError("Failed to render this PDF.");
      }
    })();
    return () => {
      active = false;
      local?.destroy();
    };
  }, [bytes]);

  const settings: ToolSettings = {
    color: tool === "highlight" ? highlightColor : color,
    fontSize,
    strokeWidth,
    highlightOpacity: 0.4,
  };

  const pageAnnotations = annotations.filter((a) => a.page === page);

  const upsert = useCallback((ann: Annotation) => {
    setAnnotations((prev) => {
      const idx = prev.findIndex((a) => a.id === ann.id);
      if (idx === -1) return [...prev, ann];
      const next = [...prev];
      next[idx] = ann;
      return next;
    });
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  function createAnnotation(ann: Annotation) {
    upsert(ann);
    setSelectedId(ann.id);
    if (tool === "text" || tool === "signature") setTool("select");
  }

  // --- structural page operations (bake annotations first) ---
  async function runStructural(
    transform: (input: Uint8Array) => Promise<Uint8Array>,
    message: string
  ) {
    if (!bytes) return;
    setBusy(true);
    setStatus(null);
    try {
      const baked =
        annotations.length > 0
          ? await applyAnnotations(bytes, annotations)
          : bytes;
      const result = await transform(new Uint8Array(baked));
      setAnnotations([]);
      setSelectedId(null);
      setBytes(new Uint8Array(result));
      setStatus(message);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }

  const rotateCurrent = () =>
    runStructural((b) => rotatePages(b, [page], 90), "Page rotated.");

  const deleteCurrent = () => {
    if (numPages <= 1) {
      setStatus("A document must have at least one page.");
      return;
    }
    if (!confirm(`Delete page ${page + 1}?`)) return;
    runStructural((b) => deletePages(b, [page]), "Page deleted.");
  };

  const movePage = (dir: -1 | 1) => {
    const target = page + dir;
    if (target < 0 || target >= numPages) return;
    const order = Array.from({ length: numPages }, (_, i) => i);
    [order[page], order[target]] = [order[target], order[page]];
    runStructural((b) => reorderPages(b, order), "Pages reordered.").then(() =>
      setPage(target)
    );
  };

  async function handleMerge(files: FileList | null) {
    if (!files || files.length === 0) return;
    const extra = new Uint8Array(await files[0].arrayBuffer());
    await runStructural(
      (b) => mergePdfs([b, extra]),
      `Merged "${files[0].name}".`
    );
    if (mergeInput.current) mergeInput.current.value = "";
  }

  // --- export / save ---
  async function buildExport(): Promise<Uint8Array> {
    if (!bytes) throw new Error("Nothing to export.");
    return applyAnnotations(bytes, annotations, { watermark: plan === "free" });
  }

  async function handleDownload() {
    setBusy(true);
    try {
      const out = await buildExport();
      const blob = new Blob([out.slice() as unknown as BlobPart], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement("a");
      a.href = url;
      a.download = `${doc.name}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setStatus(null);
    try {
      const out = await buildExport();
      const blob = new Blob([out.slice() as unknown as BlobPart], {
        type: "application/pdf",
      });
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(doc.storage_path, blob, {
          contentType: "application/pdf",
          upsert: true,
        });
      if (upErr) throw upErr;
      await supabase
        .from("documents")
        .update({
          page_count: numPages,
          size_bytes: blob.size,
          updated_at: new Date().toISOString(),
        })
        .eq("id", doc.id);
      // Persist the flattened version as our working copy.
      setBytes(new Uint8Array(out));
      setAnnotations([]);
      setSelectedId(null);
      setStatus("Saved to your library.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const tools: { id: Tool; icon: typeof Type; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Select" },
    { id: "text", icon: Type, label: "Text" },
    { id: "highlight", icon: Highlighter, label: "Highlight" },
    { id: "draw", icon: Pen, label: "Draw" },
    { id: "signature", icon: Signature, label: "Sign" },
  ];

  const palette = tool === "highlight" ? HIGHLIGHT_COLORS : COLORS;
  const activeColor = tool === "highlight" ? highlightColor : color;
  const setActiveColor = tool === "highlight" ? setHighlightColor : setColor;

  return (
    <div className="flex h-screen flex-col bg-secondary/30">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/dashboard" aria-label="Back to dashboard">
              <ArrowLeft />
            </Link>
          </Button>
          <span className="max-w-[40vw] truncate font-semibold">{doc.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {status && (
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {status}
            </span>
          )}
          <Button variant="outline" onClick={handleDownload} disabled={busy || !bytes}>
            <Download /> Download
          </Button>
          <Button onClick={handleSave} disabled={busy || !bytes}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2">
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                if (t.id === "signature" && !signatureDataUrl) {
                  setSigOpen(true);
                }
                setTool(t.id);
              }}
              title={t.label}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
                tool === t.id
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              )}
            >
              <t.icon className="h-4 w-4" />
              <span className="hidden md:inline">{t.label}</span>
            </button>
          ))}
        </div>

        {/* contextual colour palette */}
        {(tool === "text" || tool === "highlight" || tool === "draw") && (
          <div className="flex items-center gap-1 rounded-lg border border-border p-1">
            {palette.map((c) => (
              <button
                key={c}
                onClick={() => setActiveColor(c)}
                className={cn(
                  "h-6 w-6 rounded-full border",
                  activeColor === c ? "ring-2 ring-ring ring-offset-1" : ""
                )}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
              />
            ))}
          </div>
        )}

        {tool === "text" && (
          <select
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            {[10, 12, 14, 16, 20, 24, 32].map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        )}

        {tool === "draw" && (
          <select
            value={strokeWidth}
            onChange={(e) => setStrokeWidth(Number(e.target.value))}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            {[1, 2, 3, 5, 8].map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        )}

        <div className="mx-1 h-6 w-px bg-border" />

        {/* page operations */}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={rotateCurrent} disabled={busy} title="Rotate page">
            <RotateCw /> <span className="hidden lg:inline">Rotate</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => movePage(-1)} disabled={busy || page === 0} title="Move page earlier">
            <MoveLeft />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => movePage(1)} disabled={busy || page >= numPages - 1} title="Move page later">
            <MoveRight />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => mergeInput.current?.click()} disabled={busy} title="Merge another PDF">
            <FilePlus2 /> <span className="hidden lg:inline">Merge</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={deleteCurrent} disabled={busy} title="Delete page">
            <Trash2 /> <span className="hidden lg:inline">Delete</span>
          </Button>
          <input
            ref={mergeInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => handleMerge(e.target.files)}
          />
        </div>
      </div>

      {/* Canvas area */}
      <div className="relative flex-1 overflow-auto">
        {loadError ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {loadError}
          </div>
        ) : !loaded ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 animate-spin" /> Loading document…
          </div>
        ) : (
          <div className="flex justify-center p-8">
            <PageView
              key={`${page}-${numPages}`}
              loaded={loaded}
              pageIndex={page}
              scale={scale}
              tool={tool}
              settings={settings}
              signatureDataUrl={signatureDataUrl}
              annotations={pageAnnotations}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCreate={createAnnotation}
              onChange={upsert}
              onDelete={removeAnnotation}
              onSignaturePlaced={() => {}}
            />
          </div>
        )}

        {/* Floating page + zoom controls */}
        {loaded && (
          <div className="pointer-events-none sticky bottom-4 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur">
              <Button variant="ghost" size="icon" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                <ChevronLeft />
              </Button>
              <span className="px-2 text-sm tabular-nums">
                {page + 1} / {numPages}
              </span>
              <Button variant="ghost" size="icon" onClick={() => setPage((p) => Math.min(numPages - 1, p + 1))} disabled={page >= numPages - 1}>
                <ChevronRight />
              </Button>
              <div className="mx-1 h-5 w-px bg-border" />
              <Button variant="ghost" size="icon" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))}>
                <ZoomOut />
              </Button>
              <span className="w-12 text-center text-sm tabular-nums">
                {Math.round(scale * 100)}%
              </span>
              <Button variant="ghost" size="icon" onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))}>
                <ZoomIn />
              </Button>
            </div>
          </div>
        )}
      </div>

      <SignaturePad
        open={sigOpen}
        onOpenChange={setSigOpen}
        onSave={(url) => {
          setSignatureDataUrl(url);
          setTool("signature");
        }}
      />
    </div>
  );
}
