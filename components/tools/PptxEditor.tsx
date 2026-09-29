"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, Reorder, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  Download,
  EyeOff,
  FileDown,
  Loader2,
  Presentation,
  Redo2,
  Trash2,
  Undo2,
  UploadCloud,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EASE, SPRING, SparkleBurst } from "@/components/motion/primitives";
import { UpgradeDialog, UpsellCard, type UpsellReason } from "@/components/upsell/Upsell";
import { SlideView } from "@/components/slides/SlideView";
import { downloadBlob } from "@/lib/download";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, setHandoff, takeHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { getTool } from "@/lib/tools";
import { cn, formatBytes } from "@/lib/utils";
import type { Deck as RenderDeck, DeckElement, DeckSlide } from "@/lib/pptx/parse";
import type { Deck as PkgDeck, TextShape } from "@/lib/pptx/package";
import type { History } from "@/lib/pptx/editor";

const SLUG = "edit-pptx";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const NEXT_STEPS = ["compress-pdf", "sign-pdf", "edit-pdf"];

type Status = "idle" | "reading" | "ready" | "exporting" | "done";

/** One undo step: the saved package plus the render model that matches it. */
interface Snap {
  bytes: Uint8Array;
  slides: DeckSlide[];
  keys: string[];
  index: number;
}

interface Meta {
  width: number;
  height: number;
  themeColors: string[];
}

interface EditTarget {
  elementId: string;
  /** The package state and slide the targets were read from. */
  bytes: Uint8Array;
  slide: number;
  kind: "shape" | "table";
  targets: TextShape[];
  values: string[];
  focus: number;
  rect: { left: number; top: number; width: number; height: number };
}

const loadLibs = () =>
  Promise.all([import("@/lib/pptx/package"), import("@/lib/pptx/parse"), import("@/lib/pptx/editor")]).then(
    ([pkg, parse, editor]) => ({ pkg, parse, editor })
  );
type Libs = Awaited<ReturnType<typeof loadLibs>>;

function isPptxName(name: string) {
  return /\.pptx$/i.test(name);
}

function baseName(name: string) {
  return name.replace(/\.(pptx|ppsx|potx)$/i, "") || "slides";
}

function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Callback ref + content width, for nodes that mount later than their owner. */
function useWidth<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, width, node] as const;
}

const Thumb = memo(function Thumb({ slide, meta }: { slide: DeckSlide; meta: Meta }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div
      ref={ref}
      aria-hidden
      className="relative w-full overflow-hidden rounded-md bg-white"
      style={{ aspectRatio: `${meta.width} / ${meta.height}` }}
    >
      {width > 0 && (
        <SlideView
          slide={slide}
          deckWidth={meta.width}
          deckHeight={meta.height}
          scale={width / meta.width}
          themeColors={meta.themeColors}
          className={cn(slide.hidden && "opacity-40")}
        />
      )}
    </div>
  );
}, sameLook);

/** Thumbnails only depend on what is drawn, not on the slide's position. */
function sameLook(a: { slide: DeckSlide; meta: Meta }, b: { slide: DeckSlide; meta: Meta }) {
  const x = a.slide;
  const y = b.slide;
  return (
    a.meta === b.meta &&
    x.elements === y.elements &&
    x.layoutElements === y.layoutElements &&
    x.fill === y.fill &&
    x.hidden === y.hidden &&
    x.linkColor === y.linkColor
  );
}

const iconBtn =
  "tap inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";

export function PptxEditor({ tier }: { tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const wide = useWide();
  const inputRef = useRef<HTMLInputElement>(null);
  const libs = useRef<Promise<Libs> | null>(null);
  const pkg = useRef<PkgDeck | null>(null);
  const history = useRef<History<Snap> | null>(null);
  const savedBytes = useRef<Uint8Array | null>(null);
  const orderRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const job = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const lastClick = useRef<EventTarget | null>(null);
  const dragging = useRef(false);
  const stripRef = useRef<HTMLOListElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [, setTick] = useState(0);

  const [stageRef, stageWidth, stageNode] = useWidth<HTMLDivElement>();
  const barRef = useRef<HTMLDivElement>(null);

  const getLibs = () => (libs.current ??= loadLibs());
  const dirty = !!snap && snap.bytes !== savedBytes.current;
  const index = snap?.index ?? 0;
  const slide = snap?.slides[index];
  const count = snap?.slides.length ?? 0;

  useEffect(() => () => abort.current?.abort(), []);

  // Warn before leaving only when there is something to lose.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (snap) setOrder(snap.keys);
  }, [snap]);
  orderRef.current = order;

  /* ------------------------------------------------------------ open */

  async function open(picked: File | null, sniffed = false) {
    if (!picked) return;
    setError(null);
    if (!sniffed && !isPptxName(picked.name) && picked.type !== PPTX_MIME) {
      setError(/\.ppt$/i.test(picked.name) ? "Save it as .pptx first." : "Choose a .pptx file.");
      return;
    }
    if (picked.size > limits.maxFileBytes) {
      setUpsell("file-size");
      setError(`Files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return;
    }
    const id = ++job.current;
    setFile(picked);
    setSnap(null);
    setMeta(null);
    setEdit(null);
    setPdf(null);
    setStatus("reading");
    try {
      const { pkg: P, parse } = await getLibs();
      let bytes: Uint8Array = new Uint8Array(await picked.arrayBuffer());
      let [deck, opened] = await Promise.all([parse.parsePptx(bytes), P.openDeck(bytes.slice())]);
      if (deck.slides.length !== opened.slideCount) {
        // Slide parts out of step with the slide list: normalise once.
        bytes = await P.saveDeck(opened);
        opened = await P.openDeck(bytes);
        deck = await parse.parsePptx(bytes);
        if (deck.slides.length !== opened.slideCount) throw new parse.PptxError(parse.PPTX_MESSAGES.invalid, "invalid");
      }
      if (id !== job.current) return;
      const { editor } = await getLibs();
      const first: Snap = { bytes, slides: deck.slides, keys: deck.slides.map(() => newKey()), index: 0 };
      pkg.current = opened;
      history.current = new editor.History<Snap>(first, (s) => s.bytes.byteLength);
      savedBytes.current = first.bytes;
      setMeta({ width: deck.width, height: deck.height, themeColors: deck.themeColors });
      setSnap(first);
      setStatus("ready");
      requestAnimationFrame(() => barRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    } catch (err) {
      if (id !== job.current) return;
      const { parse } = await getLibs();
      setError(parse.pptxErrorMessage(err));
      setFile(null);
      setStatus("idle");
    }
  }

  // A file handed over from the homepage dropzone or another tool. The
  // handoff's MIME type is unreliable for Office files, so look at the name,
  // then at the bytes.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        const byName = handed.find((h) => isPptxName(h.name));
        const byZip = handed.find((h) => h.bytes[0] === 0x50 && h.bytes[1] === 0x4b);
        const match = byName ?? byZip ?? handed[0];
        if (match) open(handoffToFile(match), !!(byName || byZip));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    if (dirty && !window.confirm("Discard changes?")) return;
    abort.current?.abort();
    job.current++;
    pkg.current = null;
    history.current = null;
    savedBytes.current = null;
    setFile(null);
    setSnap(null);
    setMeta(null);
    setEdit(null);
    setPdf(null);
    setError(null);
    setStatus("idle");
  }

  /* ------------------------------------------------------------ changes */

  /**
   * Runs one package operation, saves the package (the snapshot for undo)
   * and builds the matching render model. Operations are serialised.
   */
  async function commit(
    mutate: (P: Libs["pkg"], deck: PkgDeck) => void,
    build: (prev: Snap, bytes: Uint8Array, parts: string[]) => Promise<Omit<Snap, "bytes">> | Omit<Snap, "bytes">,
    message: string,
    keepEditor = false
  ) {
    const deck = pkg.current;
    const hist = history.current;
    if (!deck || !hist || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    if (!keepEditor) setEdit(null);
    const prev = hist.current;
    try {
      const L = await getLibs();
      mutate(L.pkg, deck);
      const bytes = await L.pkg.saveDeck(deck);
      const parts = L.pkg.listSlides(deck).map((s) => s.part);
      const next = await build(prev, bytes, parts);
      const slides = next.slides.map((s, k) =>
        s.number === k + 1 && s.part === parts[k] ? s : { ...s, number: k + 1, part: parts[k] }
      );
      const snapNext: Snap = { ...next, slides, bytes };
      hist.push(snapNext);
      setSnap(snapNext);
      setAnnounce(message);
      return true;
    } catch {
      // The package may be half-changed: go back to the last good state.
      try {
        pkg.current = await (await getLibs()).pkg.openDeck(prev.bytes);
      } catch {
        /* keep what we have */
      }
      setError("Couldn't do that on this file.");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const select = useCallback((k: number, focus = false) => {
    setSnap((s) => (s && s.index !== k && k >= 0 && k < s.slides.length ? { ...s, index: k } : s));
    setEdit(null);
    setSelectedId(null);
    if (focus) requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>(`[data-slide-index="${k}"]`)?.focus());
  }, []);

  // Selecting a slide changes only the view, not the package: keep it in
  // the current history entry so undo returns to the right slide.
  useEffect(() => {
    const hist = history.current;
    if (hist && snap && hist.current !== snap && hist.current.bytes === snap.bytes) {
      hist.current = snap;
    }
  }, [snap]);

  function focusThumb(k: number) {
    requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>(`[data-slide-index="${k}"]`)?.focus());
  }

  async function duplicate(i: number) {
    const ok = await commit(
      (P, d) => P.duplicateSlide(d, i),
      (prev) => {
        const slides = [...prev.slides];
        const keys = [...prev.keys];
        slides.splice(i + 1, 0, { ...prev.slides[i] });
        keys.splice(i + 1, 0, newKey());
        return { slides, keys, index: i + 1 };
      },
      `Slide ${i + 1} duplicated`
    );
    if (ok) focusThumb(i + 1);
  }

  async function remove(i: number) {
    if (count <= 1) return;
    const ok = await commit(
      (P, d) => P.deleteSlide(d, i),
      (prev) => ({
        slides: prev.slides.filter((_, k) => k !== i),
        keys: prev.keys.filter((_, k) => k !== i),
        index: Math.min(i, prev.slides.length - 2),
      }),
      `Slide ${i + 1} deleted`
    );
    if (ok) focusThumb(Math.min(i, count - 2));
  }

  async function move(from: number, to: number) {
    if (to < 0 || to >= count || from === to) return;
    const ok = await commit(
      (P, d) => P.moveSlide(d, from, to),
      (prev) => {
        const slides = [...prev.slides];
        const keys = [...prev.keys];
        slides.splice(to, 0, ...slides.splice(from, 1));
        keys.splice(to, 0, ...keys.splice(from, 1));
        return { slides, keys, index: to };
      },
      `Moved to ${to + 1}`
    );
    if (ok) focusThumb(to);
  }

  async function reorderTo(keys: string[]) {
    const prev = history.current?.current;
    if (!prev || keys.every((k, i) => k === prev.keys[i])) return;
    const newOrder = keys.map((k) => prev.keys.indexOf(k));
    if (newOrder.some((v) => v < 0)) return setOrder(prev.keys);
    const ok = await commit(
      (P, d) => P.reorderSlides(d, newOrder),
      (p) => ({
        slides: newOrder.map((k) => p.slides[k]),
        keys: newOrder.map((k) => p.keys[k]),
        index: Math.max(0, newOrder.indexOf(p.index)),
      }),
      "Slides reordered"
    );
    if (!ok) setOrder(prev.keys);
  }

  async function restore(which: "undo" | "redo") {
    const hist = history.current;
    if (!hist || busyRef.current) return;
    const target = which === "undo" ? hist.undo() : hist.redo();
    if (!target) return;
    busyRef.current = true;
    setBusy(true);
    try {
      pkg.current = await (await getLibs()).pkg.openDeck(target.bytes);
      setEdit(null);
      setSelectedId(null);
      setSnap(target);
      setAnnounce(which === "undo" ? "Undone" : "Redone");
    } catch {
      // Put the history back where it was.
      if (which === "undo") hist.redo();
      else hist.undo();
      setError("Couldn't do that on this file.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      setTick((t) => t + 1);
    }
  }

  /* ------------------------------------------------------------ text */

  function openEditor(el: DeckElement) {
    const deck = pkg.current;
    const stage = stageNode;
    if (!deck || !stage || !snap || busyRef.current) return;
    setSelectedId(el.id);
    // Two shapes sharing an id can't be told apart in the package.
    if (countId(snap.slides[snap.index].elements, el.id) > 1) {
      setEdit(null);
      return;
    }
    const texts = getLibsSync()?.pkg.getSlideTexts(deck, snap.index) ?? [];
    let targets: TextShape[];
    let focus = 0;
    if (el.type === "table") {
      targets = texts.filter((t) => t.kind === "tableCell" && t.shapeId === el.id);
      const td = lastClick.current instanceof Element ? lastClick.current.closest("td") : null;
      if (td && td.parentElement) {
        const tr = td.parentElement as HTMLTableRowElement;
        const row = Array.from(tr.parentElement?.children ?? []).indexOf(tr);
        const cells = (el as { data?: { hMerge?: unknown; vMerge?: unknown }[][] }).data?.[row] ?? [];
        const cols = cells.map((c, k) => (c.hMerge || c.vMerge ? -1 : k)).filter((k) => k >= 0);
        const col = cols[Array.from(tr.children).indexOf(td)];
        focus = Math.max(0, targets.findIndex((t) => t.row === row && t.col === col));
      }
    } else {
      targets = texts.filter((t) => t.kind === "shape" && t.id === el.id);
    }
    lastClick.current = null;
    if (!targets.length) {
      setEdit(null);
      return;
    }
    const node = stage.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(el.id)}"]`);
    const box = stage.getBoundingClientRect();
    const r = node?.getBoundingClientRect();
    const editorLibs = getLibsSync();
    setEdit({
      elementId: el.id,
      bytes: snap.bytes,
      slide: snap.index,
      kind: el.type === "table" ? "table" : "shape",
      targets,
      values: targets.map((t) => editorLibs?.editor.paragraphsToText(t.paragraphs) ?? t.paragraphs.join("\n")),
      focus,
      rect: r
        ? { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height }
        : { left: 0, top: 0, width: box.width, height: 0 },
    });
  }

  // Resolved module cache for synchronous use after the first load.
  const resolved = useRef<Libs | null>(null);
  function getLibsSync() {
    return resolved.current;
  }
  useEffect(() => {
    getLibs().then((l) => (resolved.current = l));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeEditor(refocus: boolean) {
    const id = edit?.elementId;
    setEdit(null);
    if (refocus && id)
      requestAnimationFrame(() =>
        stageNode?.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`)?.focus()
      );
  }

  async function applyEdit() {
    if (!edit || !snap) return;
    const L = getLibsSync();
    if (!L) return;
    const i = edit.slide;
    // The deck changed under the editor (should not happen: changes close it).
    if (history.current?.current.bytes !== edit.bytes || snap.index !== i) return closeEditor(false);
    const changes = edit.targets
      .map((t, k) => ({ id: t.id, paragraphs: L.editor.textToParagraphs(t.paragraphs, edit.values[k]) }))
      .filter((c, k) => c.paragraphs.join("\u0000") !== edit.targets[k].paragraphs.join("\u0000"));
    if (!changes.length) return closeEditor(true);
    const ok = await commit(
      (P, d) => changes.forEach((c) => P.setShapeText(d, i, c.id, c.paragraphs)),
      async (prev, bytes, parts) => {
        const fresh = await L.editor.parseSlidePart(bytes, parts[i]);
        const slides = [...prev.slides];
        slides[i] = L.editor.shareUnchanged(prev.slides[i], fresh);
        return { slides, keys: prev.keys, index: i };
      },
      "Text updated",
      true
    );
    if (ok) {
      closeEditor(true);
    }
  }

  /* ------------------------------------------------------------ output */

  async function downloadPptx() {
    const deck = pkg.current;
    if (!deck || !file || !snap || busyRef.current) return;
    const blob = new Blob([snap.bytes.slice().buffer as ArrayBuffer], { type: PPTX_MIME });
    downloadBlob(blob, `${baseName(file.name)}.pptx`);
    savedBytes.current = snap.bytes;
    setTick((t) => t + 1);
    if (recordTask(tier === "guest")) setTimeout(() => setUpsell("nudge"), 1600);
  }

  async function exportPdf() {
    if (!snap || !meta || busyRef.current) return;
    setEdit(null);
    setError(null);
    setStatus("exporting");
    const visible = snap.slides.filter((s) => !s.hidden).length;
    setProgress({ done: 0, total: visible || snap.slides.length });
    const controller = new AbortController();
    abort.current = controller;
    try {
      const { deckToPdf } = await import("@/lib/pptx/to-pdf");
      const deck: RenderDeck = { ...meta, slides: snap.slides };
      const bytes = await deckToPdf(deck, {
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (controller.signal.aborted) return;
      setPdf(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
      setStatus("done");
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) setTimeout(() => setUpsell("nudge"), 1600);
    } catch {
      // A cancelled export has already handed the UI back.
      if (controller.signal.aborted) return;
      setError("Couldn't export this deck.");
      setStatus("ready");
    } finally {
      if (abort.current === controller) {
        setProgress(null);
        abort.current = null;
      }
    }
  }

  function cancelExport() {
    abort.current?.abort();
    abort.current = null;
    setProgress(null);
    setStatus("ready");
  }

  async function continueWith(nextSlug: string) {
    if (!pdf || !file) return;
    await setHandoff([await fileToHandoff(pdf, `${baseName(file.name)}.pdf`)]);
    router.push(`/tools/${nextSlug}?handoff=1`);
  }

  /* ------------------------------------------------------------ keys */

  useEffect(() => {
    if (status !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        restore("undo");
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        restore("redo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onThumbKey(e: ReactKeyboardEvent, k: number) {
    const prevKeys = wide ? ["ArrowUp", "ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
    const nextKeys = wide ? ["ArrowDown", "ArrowRight"] : ["ArrowRight", "ArrowDown"];
    const dir = prevKeys.includes(e.key) ? -1 : nextKeys.includes(e.key) ? 1 : 0;
    const editable = status === "ready";
    if (dir) {
      e.preventDefault();
      if (!e.altKey) select(Math.min(count - 1, Math.max(0, k + dir)), true);
      else if (editable) move(k, k + dir);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      select(e.key === "Home" ? 0 : count - 1, true);
    } else if (e.key === "Delete" && count > 1 && editable) {
      e.preventDefault();
      remove(k);
    }
  }

  // Keep the current thumbnail in view.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-slide-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index]);

  /* ------------------------------------------------------------ view */

  const hist = history.current;
  const stageScale = meta && stageWidth ? stageWidth / meta.width : 0;
  const fraction = progress ? progress.done / Math.max(1, progress.total) : 0;
  const note = useMemo(() => noteText(slide?.note), [slide?.note]);
  const byKey = new Map(snap?.keys.map((k, i) => [k, i]) ?? []);
  const hiddenCount = snap?.slides.filter((s) => s.hidden).length ?? 0;

  const editorPanel = edit && (
    <TextEditor
      key={`${edit.elementId}:${index}`}
      edit={edit}
      floating={wide}
      stageWidth={stageWidth}
      busy={busy}
      onChange={(k, v) => setEdit((e) => (e ? { ...e, values: e.values.map((x, j) => (j === k ? v : x)) } : e))}
      onApply={applyEdit}
      onCancel={() => closeEditor(true)}
    />
  );

  return (
    <>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {status === "done" && pdf && file ? (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="relative overflow-hidden rounded-3xl border border-border bg-card p-6 text-center shadow-xl shadow-primary/5 sm:p-10"
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-emerald-400/15 to-transparent" />
            <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
              <SparkleBurst />
              <motion.div
                initial={{ scale: 0, rotate: -40 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ ...SPRING, delay: 0.05 }}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
              >
                <Check className="h-8 w-8" strokeWidth={3} />
              </motion.div>
            </div>
            <h2 className="relative mt-5 text-2xl font-bold">Spell complete</h2>
            <p className="relative mt-2 text-xs text-muted-foreground">
              {baseName(file.name)}.pdf · {formatBytes(pdf.size)}
            </p>
            <div className="relative mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                onClick={() => downloadBlob(pdf, `${baseName(file.name)}.pdf`)}
                size="lg"
                className="min-w-44 shadow-lg shadow-primary/25"
                data-testid="download-pdf"
              >
                <Download /> Download PDF
              </Button>
              <Button onClick={() => setStatus("ready")} variant="outline" size="lg" data-testid="back-to-slides">
                <ArrowLeft /> Back to slides
              </Button>
            </div>
            <div className="relative mt-8">
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Next</p>
              <div className="flex flex-wrap justify-center gap-2">
                {NEXT_STEPS.map((next) => {
                  const t = getTool(next);
                  if (!t) return null;
                  return (
                    <motion.button
                      key={next}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => continueWith(next)}
                      className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm font-medium transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className={cn("flex h-6 w-6 items-center justify-center rounded-full", t.tint)}>
                        <t.icon className="h-3.5 w-3.5" />
                      </span>
                      {t.name}
                    </motion.button>
                  );
                })}
              </div>
            </div>
            {showCard && (
              <UpsellCard
                tier={tier}
                onDismiss={() => {
                  dismissUpsellCard();
                  setShowCard(false);
                }}
              />
            )}
          </motion.div>
        ) : (
          <motion.div
            key="work"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.4, ease: EASE }}
            className={cn("space-y-4", snap && "lg:mx-[calc((42rem-min(100vw-4rem,76rem))/2)]")}
            data-testid="pptx-editor"
          >
            <input
              ref={inputRef}
              type="file"
              accept={`.pptx,${PPTX_MIME}`}
              className="hidden"
              aria-hidden
              tabIndex={-1}
              data-testid="pptx-input"
              onChange={(e) => {
                open(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />

            {!file ? (
              <motion.div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropping(false);
                  open(e.dataTransfer.files?.[0] ?? null);
                }}
                animate={{ scale: dropping ? 1.02 : 1 }}
                transition={SPRING}
                data-testid="dropzone"
                className={cn(
                  "group relative overflow-hidden rounded-3xl border-2 border-dashed bg-card p-10 text-center transition-colors",
                  dropping ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
                )}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.10),transparent_60%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                />
                <motion.div
                  animate={dropping ? { y: -6, scale: 1.1 } : { y: [0, -5, 0] }}
                  transition={dropping ? SPRING : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                  className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"
                >
                  <UploadCloud className="h-7 w-7" />
                </motion.div>
                <p className="relative mt-4 text-lg font-semibold">{dropping ? "Release to add" : "Drop a .pptx here"}</p>
                <p className="relative text-sm text-muted-foreground">or</p>
                <Button className="relative mt-3 h-11" onClick={() => inputRef.current?.click()}>
                  Choose file
                </Button>
                <p className="relative mt-4 text-xs text-muted-foreground">Stays on your device.</p>
              </motion.div>
            ) : (
              <div
                ref={barRef}
                className="flex scroll-mt-20 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-3 py-2 sm:px-4">
                <Presentation className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" data-testid="file-name">
                    {file.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {count ? `${count} slide${count === 1 ? "" : "s"}` : formatBytes(file.size)}
                    {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
                    {dirty && " · edited"}
                  </p>
                </div>
                {status === "exporting" && (
                  <div className="order-last flex w-full items-center justify-end gap-2 sm:order-none sm:w-auto" aria-live="polite">
                    <div
                      className="relative h-2 w-24 overflow-hidden rounded-full bg-secondary sm:w-40"
                      role="progressbar"
                      aria-label="Exporting PDF"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(fraction * 100)}
                    >
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400"
                        animate={{ width: `${Math.max(4, fraction * 100)}%` }}
                        transition={{ ease: "easeOut", duration: 0.3 }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {progress ? `${Math.min(progress.done + 1, progress.total)}/${progress.total}` : ""}
                    </span>
                    <Button variant="ghost" size="sm" className="tap" onClick={cancelExport} data-testid="cancel-export">
                      Cancel
                    </Button>
                  </div>
                )}
                {snap && status !== "exporting" && (
                  <div className="order-last flex w-full items-center justify-end gap-1 sm:order-none sm:w-auto" role="toolbar" aria-label="Deck">
                    {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin text-primary" aria-label="Working" />}
                    <button
                      className={iconBtn}
                      onClick={() => restore("undo")}
                      disabled={!hist?.canUndo || busy || status !== "ready"}
                      aria-label="Undo"
                      title="Undo (Ctrl+Z)"
                      data-testid="undo"
                    >
                      <Undo2 />
                    </button>
                    <button
                      className={iconBtn}
                      onClick={() => restore("redo")}
                      disabled={!hist?.canRedo || busy || status !== "ready"}
                      aria-label="Redo"
                      title="Redo (Ctrl+Shift+Z)"
                      data-testid="redo"
                    >
                      <Redo2 />
                    </button>
                    <span aria-hidden className="mx-1 h-6 w-px bg-border" />
                    <Button
                      variant="outline"
                      size="sm"
                      className="tap"
                      onClick={downloadPptx}
                      disabled={busy || status !== "ready"}
                      title="Download PPTX"
                      aria-label="Download PPTX"
                      data-testid="download-pptx"
                    >
                      <Download /> <span className="hidden sm:inline">PPTX</span>
                    </Button>
                    <Button
                      size="sm"
                      className="tap"
                      onClick={exportPdf}
                      disabled={busy || status !== "ready"}
                      title="Export PDF"
                      aria-label="Export PDF"
                      data-testid="export-pdf"
                    >
                      <FileDown /> <span className="hidden sm:inline">PDF</span>
                    </Button>
                  </div>
                )}
                {status !== "exporting" && (
                  <button onClick={reset} className={iconBtn} aria-label={`Close ${file.name}`} title="Close">
                    <X />
                  </button>
                )}
              </div>
            )}

            {status === "reading" && (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> Reading slides…
              </p>
            )}

            <AnimatePresence>
              {error && (
                <motion.p
                  role="alert"
                  data-testid="tool-error"
                  initial={{ opacity: 0, x: 0 }}
                  animate={{ opacity: 1, x: [0, -6, 6, -3, 3, 0] }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                  <span className="flex-1">{error}</span>
                  <button className={cn(iconBtn, "-my-2 h-8 w-8")} onClick={() => setError(null)} aria-label="Dismiss">
                    <X />
                  </button>
                </motion.p>
              )}
            </AnimatePresence>

            {snap && meta && slide && (
              <div className="grid gap-4 lg:grid-cols-[10.5rem_minmax(0,1fr)]">
                {/* Slide strip */}
                <Reorder.Group
                  as="ol"
                  ref={stripRef}
                  axis={wide ? "y" : "x"}
                  values={order}
                  onReorder={setOrder}
                  aria-label="Slides"
                  data-testid="slide-strip"
                  className={cn(
                    "order-2 flex gap-2 rounded-2xl border border-border bg-secondary/40 p-2 lg:order-1",
                    "overflow-x-auto lg:max-h-[min(40rem,80vh)] lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden"
                  )}
                >
                  {order.map((key) => {
                    const k = byKey.get(key);
                    if (k === undefined) return null;
                    const s = snap.slides[k];
                    const current = k === index;
                    return (
                      <Reorder.Item
                        as="li"
                        key={key}
                        value={key}
                        drag={wide && !busy && status === "ready" ? "y" : false}
                        onDragStart={() => (dragging.current = true)}
                        onDragEnd={() => {
                          reorderTo(orderRef.current);
                          setTimeout(() => (dragging.current = false), 0);
                        }}
                        className="relative w-28 shrink-0 lg:w-full"
                      >
                        <button
                          type="button"
                          data-slide-index={k}
                          data-testid="slide-thumb"
                          onClick={() => !dragging.current && select(k)}
                          onKeyDown={(e) => onThumbKey(e, k)}
                          aria-label={`Slide ${k + 1}${s.hidden ? ", hidden" : ""}`}
                          aria-current={current ? "true" : undefined}
                          title={wide ? "Drag or Alt+Arrow to move" : undefined}
                          className={cn(
                            "block w-full rounded-lg border-2 p-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            current ? "border-primary" : "border-transparent hover:border-primary/40"
                          )}
                        >
                          <Thumb slide={s} meta={meta} />
                          <span
                            aria-hidden
                            className={cn(
                              "absolute bottom-1.5 left-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                              current ? "bg-primary text-primary-foreground" : "bg-black/60 text-white"
                            )}
                          >
                            {k + 1}
                          </span>
                          {s.hidden && (
                            <span
                              aria-hidden
                              title="Hidden"
                              data-testid="hidden-badge"
                              className="absolute right-1.5 top-1.5 inline-flex items-center rounded-md bg-black/60 p-1 text-white"
                            >
                              <EyeOff className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      </Reorder.Item>
                    );
                  })}
                </Reorder.Group>

                {/* Stage */}
                <div className="order-1 min-w-0 space-y-2 lg:order-2">
                  <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Slide">
                    <p className="mr-auto text-sm tabular-nums text-muted-foreground" data-testid="slide-position">
                      {index + 1} / {count}
                      {slide.hidden && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                          <EyeOff className="h-3 w-3" aria-hidden /> Hidden
                        </span>
                      )}
                    </p>
                    <button
                      className={iconBtn}
                      onClick={() => move(index, index - 1)}
                      disabled={index === 0 || busy || status !== "ready"}
                      aria-label="Move slide earlier"
                      title={`Move earlier (Alt+${wide ? "↑" : "←"})`}
                      data-testid="move-up"
                    >
                      {wide ? <ArrowUp /> : <ArrowLeft />}
                    </button>
                    <button
                      className={iconBtn}
                      onClick={() => move(index, index + 1)}
                      disabled={index === count - 1 || busy || status !== "ready"}
                      aria-label="Move slide later"
                      title={`Move later (Alt+${wide ? "↓" : "→"})`}
                      data-testid="move-down"
                    >
                      {wide ? <ArrowDown /> : <ArrowRight />}
                    </button>
                    <button
                      className={iconBtn}
                      onClick={() => duplicate(index)}
                      disabled={busy || status !== "ready"}
                      aria-label="Duplicate slide"
                      title="Duplicate"
                      data-testid="duplicate"
                    >
                      <Copy />
                    </button>
                    <button
                      className={cn(iconBtn, "hover:text-destructive")}
                      onClick={() => remove(index)}
                      disabled={count <= 1 || busy || status !== "ready"}
                      aria-label="Delete slide"
                      title={count <= 1 ? "Can't delete the only slide" : "Delete (Del)"}
                      data-testid="delete"
                    >
                      <Trash2 />
                    </button>
                  </div>

                  <div
                    ref={stageRef}
                    data-testid="stage"
                    className="relative mx-auto w-full"
                    style={{ maxWidth: `calc(72vh * ${meta.width / meta.height})` }}
                    onClickCapture={(e) => (lastClick.current = e.target)}
                  >
                    <div
                      className="overflow-hidden rounded-xl border border-border bg-white shadow-lg shadow-primary/5"
                      style={{ aspectRatio: `${meta.width} / ${meta.height}` }}
                      onClick={() => {
                        setSelectedId(null);
                        setEdit(null);
                      }}
                    >
                      {stageScale > 0 && (
                        <SlideView
                          slide={slide}
                          deckWidth={meta.width}
                          deckHeight={meta.height}
                          scale={(stageWidth - 2) / meta.width}
                          themeColors={meta.themeColors}
                          interactive={status === "ready"}
                          selectedId={selectedId}
                          onElementClick={openEditor}
                        />
                      )}
                    </div>
                    {wide && editorPanel}
                  </div>
                  {!wide && editorPanel}

                  {note && (
                    <details className="group rounded-xl border border-border bg-card px-3 text-sm" data-testid="notes">
                      <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        Notes
                      </summary>
                      <p className="whitespace-pre-wrap pb-3 text-muted-foreground">{note}</p>
                    </details>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {upsell && (
        <UpgradeDialog
          open
          onOpenChange={(o) => !o && setUpsell(null)}
          reason={upsell}
          tier={tier}
          returnTo={`/tools/${SLUG}`}
        />
      )}
    </>
  );
}

/** Speaker notes HTML (from the parser) as plain text, one line per paragraph. */
function noteText(html?: string) {
  if (!html) return "";
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const blocks = Array.from(body.querySelectorAll("p, li")).filter((b) => !b.querySelector("p, li"));
  const lines = blocks.length ? blocks.map((b) => b.textContent ?? "") : [body.textContent ?? ""];
  return lines.join("\n").replace(/\u00a0/g, " ").trim();
}

/** Leaf elements (group children included) with this id. */
function countId(elements: DeckElement[], id: string): number {
  let n = 0;
  for (const el of elements) {
    const kids = (el as { elements?: DeckElement[] }).elements;
    if (el.type === "group" && kids) n += countId(kids, id);
    else if (el.id === id) n++;
  }
  return n;
}

let keySeq = 0;
function newKey() {
  return `k${++keySeq}`;
}

/* ------------------------------------------------------------------ text editor */

function TextEditor({
  edit,
  floating,
  stageWidth,
  busy,
  onChange,
  onApply,
  onCancel,
}: {
  edit: EditTarget;
  floating: boolean;
  stageWidth: number;
  busy: boolean;
  onChange: (k: number, v: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelectorAll<HTMLTextAreaElement>("textarea")[edit.focus];
    if (!el) return;
    el.focus({ preventScroll: !floating ? false : true });
    el.setSelectionRange(el.value.length, el.value.length);
    if (!floating) ref.current?.scrollIntoView({ block: "nearest" });
    // Focus once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onApply();
    }
  };

  const table = edit.kind === "table";
  const cols = table ? Math.max(...edit.targets.map((t) => (t.col ?? 0) + 1)) : 1;
  const width = floating ? Math.min(stageWidth, Math.max(edit.rect.width, table ? Math.min(cols * 150, 640) : 300)) : undefined;
  const left = floating ? Math.max(0, Math.min(edit.rect.left, stageWidth - (width ?? 0))) : undefined;

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={table ? "Edit table" : "Edit text"}
      data-testid="text-editor"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "z-20 rounded-xl border border-primary/40 bg-card p-2 shadow-2xl shadow-primary/20",
        floating ? "absolute" : "relative"
      )}
      style={floating ? { left, top: Math.max(0, edit.rect.top), width } : undefined}
    >
      {table ? (
        <div className="max-h-72 overflow-auto">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(6rem, 1fr))` }}>
            {edit.targets.map((t, k) => (
              <textarea
                key={t.id}
                value={edit.values[k]}
                onChange={(e) => onChange(k, e.target.value)}
                aria-label={`Row ${(t.row ?? 0) + 1}, column ${(t.col ?? 0) + 1}`}
                rows={Math.max(1, edit.values[k].split("\n").length)}
                style={{ gridColumn: (t.col ?? 0) + 1, gridRow: (t.row ?? 0) + 1 }}
                className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ))}
          </div>
        </div>
      ) : (
        <textarea
          value={edit.values[0]}
          onChange={(e) => onChange(0, e.target.value)}
          aria-label="Text"
          rows={Math.min(12, Math.max(2, edit.values[0].split("\n").length))}
          className="block w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" className="tap" onClick={onCancel} title="Esc">
          Cancel
        </Button>
        <Button size="sm" className="tap" onClick={onApply} disabled={busy} title="Ctrl+Enter" data-testid="apply-text">
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Apply
        </Button>
      </div>
    </motion.div>
  );
}
