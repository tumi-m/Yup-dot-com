"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePlus2,
  Loader2,
  PanelLeft,
  Redo2,
  Save,
  Undo2,
  ZoomIn,
  ZoomOut,
  Maximize,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { loadForRender, type LoadedPdf } from "@/lib/pdf/render";
import { bakeAnnotations, rotatePagesBy, insertBlankPage } from "@/lib/pdf/bake";
import { deletePages, reorderPages, mergePdfs } from "@/lib/pdf/operations";
import { detectFormFields, fillFormFields, type DetectedField } from "@/lib/pdf/forms";
import { useHistory } from "@/lib/editor/history";
import {
  DEFAULT_SETTINGS,
  type Annotation,
  type ToolId,
  type ToolSettings,
} from "@/lib/editor/types";
import type { DocumentRecord, PlanId } from "@/lib/types";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { useToasts, ToastStack } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Toolbar } from "./Toolbar";
import { PageView } from "./PageView";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { PropertiesPanel } from "./PropertiesPanel";
import { SignaturePad } from "./SignaturePad";

const SHORTCUTS: Record<string, ToolId> = {
  v: "select",
  t: "text",
  n: "note",
  h: "highlight",
  u: "underline",
  k: "strikeout",
  d: "draw",
  w: "whiteout",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  s: "signature",
};

export function PdfEditor({
  document: doc,
  plan,
}: {
  document: DocumentRecord;
  plan: PlanId;
}) {
  const supabase = useMemo(() => createClient(), []);
  const mergeInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const canvasArea = useRef<HTMLDivElement>(null);

  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);

  const history = useHistory<Annotation[]>([]);
  const annotations = history.state;

  const [tool, setTool] = useState<ToolId>("select");
  const [settings, setSettings] = useState<ToolSettings>(DEFAULT_SETTINGS);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [formFields, setFormFields] = useState<DetectedField[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  const [placementImage, setPlacementImage] = useState<string | null>(null);
  const [sigOpen, setSigOpen] = useState(false);

  const { toasts, toast, dismiss } = useToasts();

  // ---- load bytes from storage ----
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
      setBytes(new Uint8Array(await data.arrayBuffer()));
    })();
    return () => {
      active = false;
    };
  }, [supabase, doc.storage_path]);

  // ---- (re)build render doc + detect form fields whenever bytes change ----
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
        const fields = await detectFormFields(bytes);
        if (active) {
          setFormFields(fields);
          if (fields.length) {
            toast(
              `${fields.length} fillable field${fields.length === 1 ? "" : "s"} detected`,
              "info"
            );
          }
        }
      } catch {
        if (active) setLoadError("Failed to render this PDF.");
      }
    })();
    return () => {
      active = false;
      local?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  const selected = annotations.find((a) => a.id === selectedId) ?? null;
  const pageAnnotations = annotations.filter((a) => a.page === page);

  // ---- annotation mutations ----
  const createAnnotation = useCallback(
    (ann: Annotation) => {
      history.commit((prev) => [...prev, ann]);
      setSelectedId(ann.id);
      if (ann.type === "text" || ann.type === "note" || ann.type === "image") {
        setTool("select");
      }
    },
    [history]
  );

  const updateAnnotation = useCallback(
    (next: Annotation) => {
      history.live((prev) => prev.map((a) => (a.id === next.id ? next : a)));
    },
    [history]
  );

  /** Property-panel edits are discrete, so they record their own history entry. */
  const commitAnnotation = useCallback(
    (next: Annotation) => {
      history.commit((prev) => prev.map((a) => (a.id === next.id ? next : a)));
    },
    [history]
  );

  const deleteAnnotation = useCallback(
    (id: string) => {
      history.commit((prev) => prev.filter((a) => a.id !== id));
      setSelectedId((s) => (s === id ? null : s));
    },
    [history]
  );

  // ---- structural page operations ----
  const runStructural = useCallback(
    async (
      transform: (input: Uint8Array) => Promise<Uint8Array>,
      message: string
    ) => {
      if (!bytes) return;
      setBusy(true);
      try {
        const baked = annotations.length
          ? await bakeAnnotations(bytes, annotations)
          : bytes;
        const result = await transform(new Uint8Array(baked));
        history.reset([]);
        setSelectedId(null);
        setBytes(new Uint8Array(result));
        toast(message, "success");
      } catch (err) {
        toast(err instanceof Error ? err.message : "Operation failed.", "error");
      } finally {
        setBusy(false);
      }
    },
    [bytes, annotations, history, toast]
  );

  const handleReorder = (from: number, to: number) => {
    const order = Array.from({ length: numPages }, (_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    runStructural((b) => reorderPages(b, order), "Pages reordered.").then(() =>
      setPage(to)
    );
  };

  const handleDeletePage = (target: number) => {
    if (numPages <= 1) {
      toast("A document must keep at least one page.", "error");
      return;
    }
    runStructural((b) => deletePages(b, [target]), "Page deleted.").then(() =>
      setPage((p) => Math.max(0, Math.min(p, numPages - 2)))
    );
  };

  async function handleMerge(files: FileList | null) {
    if (!files?.length) return;
    const extra = new Uint8Array(await files[0].arrayBuffer());
    await runStructural((b) => mergePdfs([b, extra]), `Merged "${files[0].name}".`);
    if (mergeInput.current) mergeInput.current.value = "";
  }

  async function handleImagePicked(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPlacementImage(String(reader.result));
      setTool("image");
      toast("Click on the page to place the image.", "info");
    };
    reader.readAsDataURL(file);
    if (imageInput.current) imageInput.current.value = "";
  }

  // ---- export ----
  const buildOutput = useCallback(async () => {
    if (!bytes) throw new Error("Nothing to export.");
    let out = await bakeAnnotations(bytes, annotations, {
      watermark: plan === "free",
    });
    if (Object.keys(formValues).length) {
      out = await fillFormFields(out, formValues);
    }
    return out;
  }, [bytes, annotations, formValues, plan]);

  async function handleDownload() {
    setBusy(true);
    try {
      const out = await buildOutput();
      downloadBlob(
        new Blob([out.slice() as unknown as BlobPart], { type: "application/pdf" }),
        `${doc.name}.pdf`
      );
      toast("Downloaded.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  const handleSave = useCallback(async () => {
    if (!bytes) return;
    setBusy(true);
    try {
      const out = await buildOutput();
      const blob = new Blob([out.slice() as unknown as BlobPart], {
        type: "application/pdf",
      });
      const { error } = await supabase.storage
        .from("documents")
        .upload(doc.storage_path, blob, {
          contentType: "application/pdf",
          upsert: true,
        });
      if (error) throw error;
      await supabase
        .from("documents")
        .update({
          page_count: numPages,
          size_bytes: blob.size,
          updated_at: new Date().toISOString(),
        })
        .eq("id", doc.id);

      history.reset([]);
      setSelectedId(null);
      setFormValues({});
      setBytes(new Uint8Array(out));
      toast("Saved to your library.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed.", "error");
    } finally {
      setBusy(false);
    }
  }, [bytes, buildOutput, supabase, doc, numPages, history, toast]);

  // ---- tool switching side effects ----
  const handleToolChange = (next: ToolId) => {
    if (next === "signature") {
      if (!placementImage) {
        setSigOpen(true);
        return;
      }
    }
    if (next === "image") {
      imageInput.current?.click();
      return;
    }
    setTool(next);
  };

  // ---- zoom ----
  const fitWidth = useCallback(async () => {
    if (!loaded || !canvasArea.current) return;
    const vp = await loaded.getPageViewport(page + 1, 1);
    const available = canvasArea.current.clientWidth - 64;
    setScale(Math.max(0.4, Math.min(3, available / vp.baseWidth)));
  }, [loaded, page]);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (typing) return;

      if (e.key === "Escape") {
        setTool("select");
        setSelectedId(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteAnnotation(selectedId);
        return;
      }
      const mapped = SHORTCUTS[e.key.toLowerCase()];
      if (mapped && !mod) {
        e.preventDefault();
        handleToolChange(mapped);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, selectedId, deleteAnnotation, handleSave, placementImage]);

  const dirty = annotations.length > 0 || Object.keys(formValues).length > 0;

  return (
    <div className="flex h-screen flex-col bg-secondary/30">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon">
            <Link href="/dashboard" aria-label="Back to dashboard">
              <ArrowLeft />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSidebar((s) => !s)}
            aria-label="Toggle page panel"
            aria-pressed={showSidebar}
          >
            <PanelLeft />
          </Button>
          <span className="truncate font-semibold">{doc.name}</span>
          {dirty && (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              Unsaved
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={history.undo}
            disabled={!history.canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={history.redo}
            disabled={!history.canRedo}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <Redo2 />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mergeInput.current?.click()}
            disabled={busy}
            title="Merge another PDF"
          >
            <FilePlus2 />
            <span className="hidden lg:inline">Merge</span>
          </Button>
          <div className="mx-1 h-6 w-px bg-border" />
          <Button variant="outline" onClick={handleDownload} disabled={busy || !bytes}>
            <Download />
            <span className="hidden sm:inline">Download</span>
          </Button>
          <Button onClick={handleSave} disabled={busy || !bytes}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            <span className="hidden sm:inline">Save</span>
          </Button>
        </div>
      </header>

      <Toolbar
        tool={tool}
        onToolChange={handleToolChange}
        settings={settings}
        onSettingsChange={setSettings}
      />

      <div className="flex min-h-0 flex-1">
        {showSidebar && loaded && (
          <ThumbnailSidebar
            loaded={loaded}
            numPages={numPages}
            currentPage={page}
            busy={busy}
            onGoTo={setPage}
            onReorder={handleReorder}
            onRotate={(i) => runStructural((b) => rotatePagesBy(b, [i], 90), "Page rotated.")}
            onDelete={handleDeletePage}
            onInsertAfter={(i) =>
              runStructural((b) => insertBlankPage(b, i), "Blank page inserted.")
            }
          />
        )}

        <div ref={canvasArea} className="relative min-w-0 flex-1 overflow-auto">
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
                placementImage={placementImage}
                annotations={pageAnnotations}
                selectedId={selectedId}
                formFields={formFields}
                formValues={formValues}
                onFormChange={(name, value) =>
                  setFormValues((v) => ({ ...v, [name]: value }))
                }
                onSelect={setSelectedId}
                onCreate={createAnnotation}
                onChange={updateAnnotation}
                onCommitStart={history.begin}
                onCommitEnd={history.end}
                onDelete={deleteAnnotation}
                onPlacementUsed={() => setPlacementImage(null)}
              />
            </div>
          )}

          {loaded && (
            <div className="pointer-events-none sticky bottom-4 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  aria-label="Previous page"
                >
                  <ChevronLeft />
                </Button>
                <span className="px-2 text-sm tabular-nums">
                  {page + 1} / {numPages}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPage((p) => Math.min(numPages - 1, p + 1))}
                  disabled={page >= numPages - 1}
                  aria-label="Next page"
                >
                  <ChevronRight />
                </Button>
                <div className="mx-1 h-5 w-px bg-border" />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setScale((s) => Math.max(0.4, +(s - 0.2).toFixed(2)))}
                  aria-label="Zoom out"
                >
                  <ZoomOut />
                </Button>
                <span className="w-12 text-center text-sm tabular-nums">
                  {Math.round(scale * 100)}%
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))}
                  aria-label="Zoom in"
                >
                  <ZoomIn />
                </Button>
                <Button variant="ghost" size="icon" onClick={fitWidth} aria-label="Fit width">
                  <Maximize />
                </Button>
              </div>
            </div>
          )}
        </div>

        {selected && (
          <PropertiesPanel
            annotation={selected}
            pageCount={numPages}
            onChange={commitAnnotation}
            onDelete={() => deleteAnnotation(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      <input
        ref={mergeInput}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => handleMerge(e.target.files)}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => handleImagePicked(e.target.files)}
      />

      <SignaturePad
        open={sigOpen}
        onOpenChange={setSigOpen}
        onSave={(url) => {
          setPlacementImage(url);
          setTool("signature");
          toast("Click on the page to place your signature.", "info");
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {busy && (
        <div className={cn("pointer-events-none fixed inset-0 z-50 bg-background/20")} />
      )}
    </div>
  );
}
