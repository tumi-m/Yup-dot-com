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
import { tryCreateClient } from "@/lib/supabase/client";
import { getLocalDoc, saveLocalDoc } from "@/lib/local-store";
import { limitsFor, type Tier } from "@/lib/limits";
import { UpgradeDialog } from "@/components/upsell/Upsell";
import { documentFingerprint, EditCheckError, requestEdit } from "@/lib/edit-usage";
import { loadForRender, type LoadedPdf } from "@/lib/pdf/render";
import { bakeAnnotations, rotatePagesBy, insertBlankPage } from "@/lib/pdf/bake";
import { deletePages, reorderPages, mergePdfs } from "@/lib/pdf/operations";
import { detectFormFields, fillFormFields, type DetectedField } from "@/lib/pdf/forms";
import { useHistory } from "@/lib/editor/history";
import { useUnsavedGuard } from "@/lib/editor/unsaved-guard";
import { revealOffset } from "@/lib/editor/canvas";
import { scrollBehavior } from "@/components/motion/focus";
import { readShortcutsOn, toolShortcut, writeShortcutsOn } from "@/lib/editor/keyboard";
import {
  annotationLabel,
  DEFAULT_SETTINGS,
  type Annotation,
  type ToolId,
  type ToolSettings,
} from "@/lib/editor/types";
import type { DocumentRecord } from "@/lib/types";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { friendlyPdfError } from "@/lib/pdf/errors";
import { Button } from "@/components/ui/button";
import { useToasts, ToastStack } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Toolbar } from "./Toolbar";
import { PageView } from "./PageView";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { PropertiesPanel } from "./PropertiesPanel";
import { SignaturePad } from "./SignaturePad";

/**
 * Where the document lives. Cloud documents belong to a signed-in user's
 * library; local documents live in this browser only, so anyone can edit
 * without an account (the PDFescape journey).
 */
export type EditorSource =
  | { kind: "cloud"; doc: DocumentRecord }
  | { kind: "local"; id: string };

/** Zoom limits. Low enough to fit a poster-size page on a phone. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;

/** Phone-width layout, where side panels become overlays. */
const narrow = () => window.matchMedia("(max-width: 767px)").matches;

export function PdfEditor({
  source,
  tier,
}: {
  source: EditorSource;
  tier: Tier;
}) {
  const supabase = useMemo(() => (source.kind === "cloud" ? tryCreateClient() : null), [source.kind]);
  const [docName, setDocName] = useState(source.kind === "cloud" ? source.doc.name : "Document");
  const [upsellOpen, setUpsellOpen] = useState(false);
  const [editsOpen, setEditsOpen] = useState(false);
  /** The bytes last loaded or saved. */
  const savedRef = useRef<{ bytes: Uint8Array | null }>({ bytes: null });
  /** The file last built, for which edits, and the fingerprint it was claimed under. */
  const builtRef = useRef<{ key: string; out: Uint8Array; fp: string; watermark: boolean } | null>(null);
  const upsellShown = useRef(false);
  const mergeInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const canvasArea = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const showSidebarRef = useRef(true);

  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set while a page operation, save or download runs; Ctrl+S must not start another. */
  const busyRef = useRef(false);
  const [showSidebar, setShowSidebar] = useState(true);

  const history = useHistory<Annotation[]>([]);
  const annotations = history.state;

  const [tool, setTool] = useState<ToolId>("select");
  /** Single-key tool shortcuts, which the visitor can turn off. */
  const [shortcuts, setShortcuts] = useState(true);
  useEffect(() => setShortcuts(readShortcutsOn()), []);
  const [settings, setSettings] = useState<ToolSettings>(DEFAULT_SETTINGS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Phones: how much of the canvas the properties sheet covers, in px. */
  const [sheetCover, setSheetCover] = useState(0);

  const [formFields, setFormFields] = useState<DetectedField[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  const [placementImage, setPlacementImage] = useState<string | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  /** Bumped to place the current tool's item in the middle of the page. */
  const [placeNow, setPlaceNow] = useState(0);
  /** The last tool was chosen with the keyboard, so its item is placed for the visitor. */
  const keyboardTool = useRef(false);
  /** Place the signature once its dialog has closed (and let go of focus). */
  const placeAfterSign = useRef(false);
  /** An annotation id, or "page": where focus goes once a deleted annotation has gone. */
  const focusAfter = useRef<string | null>(null);

  const { toasts, toast, dismiss } = useToasts();

  // ---- load bytes from storage ----
  useEffect(() => {
    let active = true;
    (async () => {
      if (source.kind === "local") {
        const local = await getLocalDoc(source.id).catch(() => undefined);
        if (!active) return;
        if (!local) {
          setLoadError("This document is no longer on this device.");
          return;
        }
        setDocName(local.name.replace(/\.pdf$/i, ""));
        savedRef.current = { bytes: local.bytes };
        setBytes(local.bytes);
        return;
      }
      if (!supabase) {
        setLoadError("Cloud documents are unavailable on this deployment.");
        return;
      }
      const { data, error } = await supabase.storage
        .from("documents")
        .download(source.doc.storage_path);
      if (!active) return;
      if (error || !data) {
        setLoadError("Could not load this document.");
        return;
      }
      const loadedBytes = new Uint8Array(await data.arrayBuffer());
      savedRef.current = { bytes: loadedBytes };
      setBytes(loadedBytes);
    })();
    return () => {
      active = false;
    };
  }, [supabase, source]);

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
        // Size the first page to the screen before it renders, so it doesn't jump.
        if (!fitted.current && canvasArea.current) {
          fitted.current = true;
          const vp = await local.getPageViewport(1, 1);
          if (!active) return;
          const wide = window.matchMedia("(min-width: 768px)").matches;
          const available =
            canvasArea.current.clientWidth -
            (wide && showSidebarRef.current ? 176 : 0) -
            (window.matchMedia("(min-width: 640px)").matches ? 64 : 32);
          if (available > 0 && vp.width * 1.3 > available) {
            setScale(Math.max(MIN_ZOOM, Math.min(1.3, available / vp.width)));
          }
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
    (ann: Annotation, keyboard = false) => {
      history.commit((prev) => [...prev, ann]);
      setSelectedId(ann.id);
      // Placed from the keyboard: select it, so the keys move it from here.
      if (keyboard || ann.type === "text" || ann.type === "note" || ann.type === "image") {
        setTool("select");
      }
      if (keyboard && ann.type !== "text" && ann.type !== "note") {
        toast(`${annotationLabel(ann)} added. Arrow keys move it, Alt+arrow keys resize it.`, "info");
      }
    },
    [history, toast]
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
      // Keep focus on the page: on the next annotation when the deleted one
      // had it, or on the page itself when its delete button or panel did.
      const area = canvasArea.current;
      const own = area?.querySelector<HTMLElement>(`[data-ann-id="${CSS.escape(id)}"]`);
      const active = document.activeElement;
      if (area && own && active) {
        const all = Array.from(area.querySelectorAll<HTMLElement>("[data-ann-focus]"));
        const i = all.indexOf(active as HTMLElement);
        if (i >= 0 && own.contains(active)) {
          const next = all[i + 1] ?? all[i - 1];
          focusAfter.current = next?.closest<HTMLElement>("[data-ann-id]")?.dataset.annId ?? "page";
        } else if (own.contains(active) || active.closest("[data-properties]")) {
          focusAfter.current = "page";
        }
      }
      history.commit((prev) => prev.filter((a) => a.id !== id));
      setSelectedId((s) => (s === id ? null : s));
    },
    [history]
  );

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    const area = canvasArea.current;
    const el =
      target === "page"
        ? area?.querySelector<HTMLElement>("[data-page-layer]")
        : area?.querySelector<HTMLElement>(`[data-ann-id="${CSS.escape(target)}"] [data-ann-focus]`);
    el?.focus({ preventScroll: true });
  }, [annotations]);

  // ---- structural page operations ----
  const runStructural = useCallback(
    async (
      transform: (input: Uint8Array) => Promise<Uint8Array>,
      message: string
    ): Promise<boolean> => {
      if (!bytes || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        // Bake pending edits — including typed form values — first, or the
        // page operation would silently throw them away.
        let baked = annotations.length ? await bakeAnnotations(bytes, annotations) : bytes;
        if (Object.keys(formValues).length) baked = await fillFormFields(baked, formValues);
        const result = await transform(new Uint8Array(baked));
        history.reset([]);
        setSelectedId(null);
        setFormValues({});
        setBytes(new Uint8Array(result));
        toast(message, "success");
        return true;
      } catch (err) {
        toast(friendlyPdfError(err).message || "Operation failed.", "error");
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [bytes, annotations, formValues, history, toast]
  );

  const handleReorder = (from: number, to: number) => {
    const order = Array.from({ length: numPages }, (_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    runStructural((b) => reorderPages(b, order), "Pages reordered.").then(() =>
      setPage(to)
    );
  };

  const handleDeletePage = async (target: number) => {
    if (numPages <= 1) {
      toast("A document must keep at least one page.", "error");
      return false;
    }
    const ok = await runStructural((b) => deletePages(b, [target]), "Page deleted.");
    setPage((p) => Math.max(0, Math.min(p, numPages - 2)));
    return ok;
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
      if (keyboardTool.current) setPlaceNow((n) => n + 1);
      else toast("Click on the page to place the image.", "info");
    };
    reader.readAsDataURL(file);
    if (imageInput.current) imageInput.current.value = "";
  }

  // ---- export ----
  const pristine = !!bytes && bytes === savedRef.current.bytes && !annotations.length && !Object.keys(formValues).length;
  /** Page operations change the bytes, so they count as unsaved too. */
  const dirty = !!bytes && !pristine;

  const buildOutput = useCallback(
    async (watermark: boolean) => {
      if (!bytes) throw new Error("Nothing to export.");
      let out = await bakeAnnotations(bytes, annotations, { watermark });
      if (Object.keys(formValues).length) {
        out = await fillFormFields(out, formValues);
      }
      return out;
    },
    [bytes, annotations, formValues]
  );

  /**
   * One edit a day on Free: builds the file, then asks the server for it.
   * The claim is the fingerprint of the file itself (of the document, when
   * nothing changed), so downloading it again, saving it, or reopening the
   * saved copy later is the same edit. The answer says whether the file gets
   * the "Made with PDF Wizard" mark; it is rebuilt if the plan has changed.
   */
  const buildAuthorized = useCallback(async () => {
    if (!bytes) return null;
    const key = await documentFingerprint(bytes, JSON.stringify(annotations), JSON.stringify(formValues));
    let built = builtRef.current?.key === key ? builtRef.current : null;
    if (!built) {
      const watermark = limitsFor(tier).watermark;
      const out = await buildOutput(watermark);
      built = { key, out, watermark, fp: await documentFingerprint(pristine ? bytes : out) };
    }
    let grant;
    try {
      grant = await requestEdit(built.fp);
    } catch (err) {
      toast(err instanceof EditCheckError ? err.message : "Couldn't save right now. Try again.", "error");
      return null;
    }
    if (!grant.allowed) {
      setEditsOpen(true);
      return null;
    }
    if (grant.watermark !== built.watermark) {
      built = { ...built, watermark: grant.watermark, out: await buildOutput(grant.watermark) };
    }
    builtRef.current = built;
    return built;
  }, [bytes, pristine, annotations, formValues, buildOutput, tier, toast]);

  async function handleDownload() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const built = await buildAuthorized();
      if (!built) return;
      downloadBlob(
        new Blob([built.out.slice() as unknown as BlobPart], { type: "application/pdf" }),
        `${docName}.pdf`
      );
      trackToolUsed();
      toast("Downloaded.", "success");
    } catch (err) {
      toast(friendlyPdfError(err).message || "Export failed.", "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const handleSave = useCallback(async () => {
    if (!bytes || busyRef.current) return;
    if (pristine) {
      toast(source.kind === "local" ? "Saved on this device." : "Saved to your library.", "success");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const built = await buildAuthorized();
      if (!built) return;
      const out = built.out;
      const blob = new Blob([out.slice() as unknown as BlobPart], {
        type: "application/pdf",
      });
      if (source.kind === "local") {
        await saveLocalDoc({
          id: source.id,
          name: docName,
          bytes: new Uint8Array(out),
          pageCount: numPages,
          updatedAt: Date.now(),
        });
      } else {
        if (!supabase) throw new Error("Cloud saving is unavailable.");
        const { error } = await supabase.storage
          .from("documents")
          .upload(source.doc.storage_path, blob, {
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
          .eq("id", source.doc.id);
      }

      const saved = new Uint8Array(out);
      // Downloading what was just saved, now or after reopening it, is the same edit.
      savedRef.current = { bytes: saved };
      history.reset([]);
      setSelectedId(null);
      setFormValues({});
      setBytes(saved);
      trackToolUsed();
      if (source.kind === "local") {
        toast("Saved on this device.", "success");
        // Offer the cloud once, after the user has saved something they value.
        if (tier === "guest" && !upsellShown.current) {
          upsellShown.current = true;
          setTimeout(() => setUpsellOpen(true), 700);
        }
      } else {
        toast("Saved to your library.", "success");
      }
    } catch (err) {
      toast(friendlyPdfError(err).message || "Save failed.", "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bytes, pristine, buildAuthorized, supabase, source, docName, numPages, history, toast, tier]);

  // ---- tool switching side effects ----
  const handleToolChange = (next: ToolId, keyboard = false) => {
    keyboardTool.current = keyboard;
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
    // Chosen with the keyboard: there is no pointer to place it with, so it
    // goes in the middle of the page, ready to move with the arrow keys.
    if (keyboard && next === "draw") toast("Draw with a mouse, pen or finger.", "info");
    else if (keyboard && next !== "select") setPlaceNow((n) => n + 1);
  };

  // ---- zoom ----
  const fitWidth = useCallback(async () => {
    if (!loaded || !canvasArea.current) return;
    const vp = await loaded.getPageViewport(page + 1, 1);
    const available =
      canvasArea.current.clientWidth - (window.matchMedia("(min-width: 640px)").matches ? 64 : 32);
    setScale(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, available / vp.baseWidth)));
  }, [loaded, page]);

  // Phones: start without the page panel. The page panel and the properties
  // sheet cover the page there, so only one is open at a time.
  useEffect(() => {
    if (narrow()) setShowSidebar(false);
  }, []);
  useEffect(() => {
    showSidebarRef.current = showSidebar;
  }, [showSidebar]);
  useEffect(() => {
    if (selectedId && narrow()) setShowSidebar(false);
  }, [selectedId]);
  // Phones: bring the selected annotation (a text box just placed near the
  // bottom, say) out from under the properties sheet.
  useEffect(() => {
    const main = canvasArea.current;
    if (!main || !selectedId || !sheetCover) return;
    const el = main.querySelector(`[data-ann-id="${CSS.escape(selectedId)}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    const view = main.getBoundingClientRect();
    const delta = revealOffset(box, { top: view.top, bottom: Math.min(view.bottom, window.innerHeight) - sheetCover });
    if (delta) main.scrollBy({ top: delta, behavior: scrollBehavior() });
  }, [selectedId, sheetCover]);

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

      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      // Inside a text box, keys type (Ctrl+Z undoes typing, not the last
      // annotation); Escape leaves the box so shortcuts work again.
      if (typing) {
        if (e.key === "Escape") {
          target.blur();
          setSelectedId(null);
        }
        return;
      }
      if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        if (e.shiftKey || e.key.toLowerCase() === "y") history.redo();
        else history.undo();
        return;
      }

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
      const mapped = toolShortcut(e, shortcuts);
      if (mapped) {
        e.preventDefault();
        handleToolChange(mapped);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, selectedId, deleteAnnotation, handleSave, placementImage, shortcuts]);

  // Don't let a stray tab close, link or Back throw away unsaved edits.
  useUnsavedGuard(dirty);

  return (
    <div className="flex h-dvh flex-col bg-secondary/30">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2 sm:gap-3 sm:px-3">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" size="icon" className="shrink-0">
            <Link
              href={source.kind === "cloud" ? "/dashboard" : "/tools"}
              aria-label={source.kind === "cloud" ? "Back to dashboard" : "Back to tools"}
            >
              <ArrowLeft />
            </Link>
          </Button>
          {!loadError && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => {
              if (!showSidebar && narrow()) setSelectedId(null);
              setShowSidebar((s) => !s);
            }}
            aria-label="Toggle page panel"
            aria-pressed={showSidebar}
          >
            <PanelLeft />
          </Button>
          )}
          <h1 className="min-w-0 truncate text-base font-semibold">{docName}</h1>
          {source.kind === "local" && (
            <span
              title="Stored in this browser only"
              className="hidden shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800 sm:inline"
            >
              On this device
            </span>
          )}
          {dirty && (
            // A dot on phones, so the document name keeps its room.
            <span
              title="Unsaved"
              className="h-2 w-2 shrink-0 rounded-full bg-amber-500 sm:h-auto sm:w-auto sm:bg-amber-100 sm:px-2 sm:py-0.5 sm:text-[11px] sm:font-medium sm:text-amber-700"
            >
              <span className="sr-only sm:not-sr-only">Unsaved</span>
            </span>
          )}
        </div>

        {!loadError && (
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={history.undo}
            // aria-disabled, not disabled: a disabled button drops the focus it has.
            aria-disabled={!history.canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={history.redo}
            aria-disabled={!history.canRedo}
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
            aria-label="Merge another PDF"
          >
            <FilePlus2 />
            <span className="hidden lg:inline">Merge</span>
          </Button>
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
          <Button variant="outline" onClick={handleDownload} disabled={busy || !bytes} aria-label="Download">
            <Download />
            <span className="hidden sm:inline">Download</span>
          </Button>
          <Button onClick={handleSave} disabled={busy || !bytes} aria-label="Save">
            {busy ? <Loader2 className="motion-safe:animate-spin" /> : <Save />}
            <span className="hidden sm:inline">Save</span>
          </Button>
        </div>
        )}
      </header>

      {!loadError && (
        <Toolbar
          tool={tool}
          onToolChange={handleToolChange}
          settings={settings}
          onSettingsChange={setSettings}
          shortcuts={shortcuts}
          onShortcutsChange={(on) => {
            setShortcuts(on);
            writeShortcutsOn(on);
          }}
        />
      )}

      <div className="relative flex min-h-0 flex-1">
        {showSidebar && loaded && (
          <ThumbnailSidebar
            loaded={loaded}
            numPages={numPages}
            currentPage={page}
            busy={busy}
            onGoTo={(i) => {
              setPage(i);
              if (narrow()) setShowSidebar(false);
            }}
            onReorder={handleReorder}
            onRotate={(i) => runStructural((b) => rotatePagesBy(b, [i], 90), "Page rotated.")}
            onDelete={handleDeletePage}
            onInsertAfter={(i) =>
              runStructural((b) => insertBlankPage(b, i), "Blank page inserted.")
            }
          />
        )}

        <main id="main" ref={canvasArea} className="relative min-w-0 flex-1 overflow-auto">
          {loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-muted-foreground">
              <p>{loadError}</p>
              <Button asChild>
                <Link href="/tools/edit-pdf">Edit PDF</Link>
              </Button>
            </div>
          ) : !loaded ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 motion-safe:animate-spin" /> Loading document…
            </div>
          ) : (
            // As wide as the page when zoomed in, so it overflows to the
            // right only and its left edge can be scrolled to.
            <div className="flex w-max min-w-full justify-center p-4 sm:p-8">
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
                placeNow={placeNow}
              />
            </div>
          )}
          {/* Room to scroll the bottom of the page above the phone sheet. */}
          {loaded && sheetCover > 0 && <div aria-hidden style={{ height: sheetCover }} />}

          {loaded && (
            // left-0 keeps the controls in view while a zoomed page scrolls sideways.
            <div className="pointer-events-none sticky bottom-4 left-0 flex justify-center">
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
                  onClick={() => setScale((s) => Math.max(MIN_ZOOM, +(s - 0.2).toFixed(2)))}
                  disabled={scale <= MIN_ZOOM}
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
                  onClick={() => setScale((s) => Math.min(MAX_ZOOM, +(s + 0.2).toFixed(2)))}
                  disabled={scale >= MAX_ZOOM}
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
        </main>

        {selected && (
          <PropertiesPanel
            annotation={selected}
            pageCount={numPages}
            onChange={commitAnnotation}
            onDelete={() => deleteAnnotation(selected.id)}
            onClose={() => {
              // Back to the annotation the panel was for, not to the top of the page.
              if (document.activeElement?.closest("[data-properties]")) {
                canvasArea.current
                  ?.querySelector<HTMLElement>(`[data-ann-id="${CSS.escape(selected.id)}"] [data-ann-focus]`)
                  ?.focus({ preventScroll: true });
              }
              setSelectedId(null);
            }}
            onCover={setSheetCover}
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
        onSave={(url, keyboard) => {
          setPlacementImage(url);
          setTool("signature");
          if (keyboard) placeAfterSign.current = true;
          else toast("Click on the page to place your signature.", "info");
        }}
        onCloseAutoFocus={(e) => {
          if (!placeAfterSign.current) return;
          placeAfterSign.current = false;
          // The placed signature takes focus instead of the toolbar.
          e.preventDefault();
          setPlaceNow((n) => n + 1);
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      <UpgradeDialog
        open={upsellOpen}
        onOpenChange={setUpsellOpen}
        reason="save"
        tier={tier}
        returnTo="/dashboard"
      />
      <UpgradeDialog open={editsOpen} onOpenChange={setEditsOpen} reason="edits" tier={tier} />

      {busy && (
        <div className={cn("pointer-events-none fixed inset-0 z-50 bg-background/20")} />
      )}
    </div>
  );
}
