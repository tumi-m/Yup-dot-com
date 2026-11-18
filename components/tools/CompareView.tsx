"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Image as ImageIcon, Loader2, Minus, MoveRight, Plus, Replace } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Compared } from "@/lib/pdf/compare/run";
import type { Change, PagePair } from "@/lib/pdf/compare/index";
import { marksByPage, marksFor, type Mark, type MarkKind } from "@/lib/pdf/compare/marks";
import { differencePicture } from "@/lib/pdf/compare/pixels";
import { describeChange, KIND_LABEL, pairOfChange, stepChange, SIDE_LABEL, type Side } from "@/lib/pdf/compare/view";
import type { PageInfo } from "@/lib/pdf/compare/words";
import type { LoadedPdf } from "@/lib/pdf/render";
import { cn } from "@/lib/utils";

interface Doc {
  loaded: LoadedPdf;
}

type View = "side" | "overlay";
type OverlayMode = "swipe" | "difference";

const ZOOMS = [
  { value: 1, label: "Fit" },
  { value: 1.5, label: "150%" },
  { value: 2, label: "200%" },
];

/** How each kind of mark looks on the page: a colour, and a line or outline that tells them apart without it. */
function markStyle(kind: MarkKind, side: Side): CSSProperties {
  switch (kind) {
    case "removed":
      // Struck through.
      return { background: "linear-gradient(transparent 44%, rgb(220 38 38 / 0.95) 44%, rgb(220 38 38 / 0.95) 58%, transparent 58%), rgb(239 68 68 / 0.18)" };
    case "added":
      // Underlined.
      return { background: "rgb(34 197 94 / 0.24)", borderBottom: "2px solid rgb(21 128 61)" };
    case "moved":
      return { background: "rgb(59 130 246 / 0.16)", borderBottom: "2px dashed rgb(29 78 216)" };
    case "picture":
      return { outline: "2px dashed rgb(234 88 12)", outlineOffset: 1, background: "rgb(249 115 22 / 0.08)" };
    case "gap":
      // Where the other file has words this one hasn't: red where they were taken out, green where they were put in.
      return { background: side === "b" ? "rgb(220 38 38)" : "rgb(21 128 61)", borderRadius: 1 };
  }
}

const KIND_ICON = { changed: Replace, added: Plus, removed: Minus, moved: MoveRight, picture: ImageIcon } as const;

/** The legend's samples. */
const LEGEND: { kind: MarkKind; side: Side; label: string }[] = [
  { kind: "removed", side: "a", label: "Taken out (struck through)" },
  { kind: "added", side: "b", label: "Put in (underlined)" },
  { kind: "moved", side: "b", label: "Moved (dashed line)" },
  { kind: "picture", side: "b", label: "Looks different (dashed box)" },
  { kind: "gap", side: "a", label: "Words only in the other file go here (bar)" },
];

/** Re-measures an element's width as it changes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return { ref, width };
}

/**
 * The comparison on screen: the list of changes with next and previous
 * (N and P on the keyboard), the pages side by side in one scroll (so they
 * scroll together), and an overlay of one pair of pages with a swipe or the
 * pixel difference.
 */
export function CompareView({ compared, a, b, reduce }: { compared: Compared; a: Doc; b: Doc; reduce: boolean }) {
  const { result, a: docA, b: docB } = compared;
  const { changes, pairs } = result;
  const [view, setView] = useState<View>("side");
  const [selected, setSelected] = useState(-1);
  const [pair, setPair] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [said, setSaid] = useState("");
  const marksA = useMemo(() => marksByPage(marksFor("a", changes, docA.words)), [changes, docA]);
  const marksB = useMemo(() => marksByPage(marksFor("b", changes, docB.words)), [changes, docB]);
  const list = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Set when a pick should bring the change into view once drawn. */
  const reveal = useRef(false);

  const pick = useCallback(
    (i: number) => {
      if (i < 0 || i >= changes.length) return;
      setSelected(i);
      setPair(pairOfChange(changes[i], pairs));
      // Read out even when the same change is picked again.
      const text = describeChange(changes[i], i, changes.length);
      setSaid((prev) => (prev === text ? `${text} ` : text));
      reveal.current = true;
    },
    [changes, pairs]
  );

  // N and P step through the changes, unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.closest("[role=dialog]"))) return;
      const key = e.key.toLowerCase();
      if (key !== "n" && key !== "p") return;
      if (!changes.length) return;
      e.preventDefault();
      pick(stepChange(selected, changes.length, key === "n" ? 1 : -1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [changes.length, selected, pick]);

  // A picked change comes into view: in the list, then on the pages.
  useEffect(() => {
    if (!reveal.current || selected < 0) return;
    reveal.current = false;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest", behavior });
    const t = setTimeout(() => {
      const root = view === "side" ? scroller.current : document.querySelector<HTMLElement>("[data-overlay]");
      const target = root?.querySelector(`[data-change="${selected}"]`) ?? root?.querySelector(`[data-pair="${pair}"]`);
      target?.scrollIntoView({ block: "center", inline: "nearest", behavior });
    }, 30);
    return () => clearTimeout(t);
  }, [selected, pair, view, reduce]);

  const count = changes.length;
  return (
    <section aria-labelledby="compare-changes" className="space-y-4" data-testid="compare-view">
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="compare-changes" className="text-base font-semibold">
            {count ? `Changes (${count.toLocaleString("en-US")})` : "Changes"}
          </h2>
          {count > 0 && (
            <div className="flex items-center gap-1.5 text-sm">
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11 pointer-coarse:w-11"
                onClick={() => pick(stepChange(selected, count, -1))}
                disabled={selected === 0}
                aria-label="Previous change"
                aria-keyshortcuts="P"
                data-testid="prev-change"
              >
                <ChevronLeft />
              </Button>
              <span className="min-w-[4.5rem] text-center tabular-nums text-muted-foreground">
                {selected < 0 ? `– of ${count.toLocaleString("en-US")}` : `${(selected + 1).toLocaleString("en-US")} of ${count.toLocaleString("en-US")}`}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11 pointer-coarse:w-11"
                onClick={() => pick(stepChange(selected, count, 1))}
                disabled={selected === count - 1}
                aria-label="Next change"
                aria-keyshortcuts="N"
                data-testid="next-change"
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
        {count ? (
          <>
            <ol ref={list} className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1" data-testid="change-list">
              {changes.map((c, i) => (
                <li key={i}>
                  <ChangeRow change={c} index={i} selected={i === selected} onPick={() => pick(i)} />
                </li>
              ))}
            </ol>
            <p className="mt-2 hidden text-xs text-muted-foreground hover-hover:block">Keys: N for the next change, P for the previous one.</p>
          </>
        ) : (
          <p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground" data-testid="no-differences">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            {result.summary.pagesAdded.length || result.summary.pagesRemoved.length
              ? "The words match, but the files don't have the same pages: see the pages below."
              : "No differences found. The words match on every page, and pages without text look the same."}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<View>
          name="compare-view"
          legend="View"
          value={view}
          onChange={setView}
          options={[
            { value: "side", label: "Side by side" },
            { value: "overlay", label: "Overlay" },
          ]}
        />
        {view === "side" && (
          <Segmented<string>
            name="compare-zoom"
            legend="Zoom"
            value={String(zoom)}
            onChange={(z) => setZoom(Number(z))}
            options={ZOOMS.map((z) => ({ value: String(z.value), label: z.label }))}
          />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="What the marks mean">
        {LEGEND.map((l) => (
          <li key={l.kind} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-6 rounded-[2px]" style={markStyle(l.kind, l.side)} />
            {l.label}
          </li>
        ))}
      </ul>

      {view === "side" ? (
        <SideBySide
          scroller={scroller}
          pairs={pairs}
          a={a.loaded}
          b={b.loaded}
          pagesA={docA.pages}
          pagesB={docB.pages}
          marksA={marksA}
          marksB={marksB}
          selected={selected}
          zoom={zoom}
          onPick={pick}
        />
      ) : (
        <Overlay
          pairs={pairs}
          pair={pair}
          onPair={setPair}
          a={a.loaded}
          b={b.loaded}
          pagesA={docA.pages}
          pagesB={docB.pages}
          marksA={marksA}
          marksB={marksB}
          selected={selected}
          onPick={pick}
        />
      )}
    </section>
  );
}

function ChangeRow({ change: c, index, selected, onPick }: { change: Change; index: number; selected: boolean; onPick: () => void }) {
  const Icon = KIND_ICON[c.kind];
  const page = (n: number | null) => (n === null ? "–" : String(n + 1));
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={selected || undefined}
      data-index={index}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
        selected ? "bg-primary/10" : "hover:bg-accent"
      )}
    >
      <span className="w-7 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <span className="inline-flex w-[6.5rem] shrink-0 items-center gap-1 pt-0.5 text-xs font-medium">
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        {KIND_LABEL[c.kind]}
      </span>
      <span className="min-w-0 flex-1 break-words">
        {c.kind === "picture" ? (
          <span className="text-muted-foreground">A picture or drawing</span>
        ) : (
          <>
            {c.oldText && c.kind !== "moved" && (
              <del className="rounded bg-red-100 px-0.5 text-red-900 decoration-red-700 decoration-2 dark:bg-red-950 dark:text-red-100">{clip(c.oldText)}</del>
            )}
            {c.oldText && c.newText && c.kind !== "moved" && <span aria-hidden> → </span>}
            {c.newText && (
              <ins className={cn("rounded px-0.5 underline decoration-2 underline-offset-2", c.kind === "moved" ? "bg-blue-100 text-blue-900 decoration-dashed decoration-blue-700 dark:bg-blue-950 dark:text-blue-100" : "bg-emerald-100 text-emerald-900 decoration-emerald-700 dark:bg-emerald-950 dark:text-emerald-100")}>
                {clip(c.newText)}
              </ins>
            )}
          </>
        )}
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {c.kind === "added"
            ? `Changed version, page ${page(c.newPage)}`
            : c.kind === "removed"
              ? `Original, page ${page(c.oldPage)}`
              : `Page ${page(c.oldPage)} → page ${page(c.newPage)}`}
        </span>
      </span>
    </button>
  );
}

const clip = (text: string) => {
  const t = [...text];
  return t.length > 160 ? `${t.slice(0, 160).join("")}…` : text;
};

/** Labelled radio pills: native radios, so arrow keys move between them. */
function Segmented<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex min-w-0 items-center gap-2">
      <legend className="sr-only">{legend}</legend>
      <span aria-hidden className="text-xs text-muted-foreground">
        {legend}
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm transition-colors pointer-coarse:min-h-11 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
              value === o.value ? "border-primary bg-primary/10 font-medium text-primary" : "border-border bg-background hover:bg-accent"
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface PagesProps {
  pairs: PagePair[];
  a: LoadedPdf;
  b: LoadedPdf;
  pagesA: PageInfo[];
  pagesB: PageInfo[];
  marksA: Map<number, Mark[]>;
  marksB: Map<number, Mark[]>;
  selected: number;
  onPick: (change: number) => void;
}

/** Both files' pages in one scroll, paired row by row, so they always scroll together. */
function SideBySide({ scroller, zoom, ...p }: PagesProps & { scroller: React.RefObject<HTMLDivElement | null>; zoom: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  // Two columns with a gap, each row's pages at one scale so their sizes compare.
  const column = Math.max(60, (width * zoom - 24) / 2);
  return (
    <div ref={ref} className="w-full">
      <div
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Pages side by side. N and P go to the next and previous change."
        className="relative max-h-[75vh] overflow-auto rounded-2xl border border-border bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="side-by-side"
      >
        <div style={{ width: zoom > 1 ? width * zoom : undefined }}>
          <div className="sticky top-0 z-20 grid grid-cols-2 gap-2 border-b border-border bg-card/95 px-2 py-1.5 text-xs font-semibold backdrop-blur">
            <span className="text-rose-700 dark:text-rose-300">{SIDE_LABEL.a}</span>
            <span className="text-emerald-700 dark:text-emerald-300">{SIDE_LABEL.b}</span>
          </div>
          {width > 0 &&
            p.pairs.map((pair, n) => {
              const infoA = pair.a !== null ? p.pagesA[pair.a] : null;
              const infoB = pair.b !== null ? p.pagesB[pair.b] : null;
              const scale = column / Math.max(infoA?.width ?? 0, infoB?.width ?? 0, 1);
              const height = Math.max((infoA?.height ?? 0) * scale, (infoB?.height ?? 0) * scale);
              return (
                <div key={n} data-pair={n} className="grid grid-cols-2 items-start gap-2 px-2 py-2">
                  <PageCell side="a" loaded={p.a} page={pair.a} info={infoA} scale={scale} rowHeight={height} marks={pair.a !== null ? p.marksA.get(pair.a) : undefined} selected={p.selected} root={scroller} onPick={p.onPick} other={pair.b} />
                  <PageCell side="b" loaded={p.b} page={pair.b} info={infoB} scale={scale} rowHeight={height} marks={pair.b !== null ? p.marksB.get(pair.b) : undefined} selected={p.selected} root={scroller} onPick={p.onPick} other={pair.a} />
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

/** Draws a page into a canvas while it is near the view, and lets go of its pixels once it's far away. */
function usePageCanvas(loaded: LoadedPdf, page: number | null, scale: number, root: React.RefObject<HTMLElement | null> | null) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(!root);
  const [state, setState] = useState<"drawing" | "drawn" | "failed">("drawing");
  useEffect(() => {
    if (!root) return;
    const el = canvas.current?.parentElement;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: root.current, rootMargin: "800px 400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || page === null || !scale) return;
    if (!near) {
      c.width = c.height = 0;
      setState("drawing");
      return;
    }
    let live = true;
    setState("drawing");
    loaded
      .renderPage(page + 1, c, scale, { forms: true })
      .then(() => live && setState("drawn"))
      .catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [loaded, page, scale, near]);
  // Let go of the page's pixels when it goes.
  useEffect(() => {
    const c = canvas.current;
    return () => {
      if (c) c.width = c.height = 0;
    };
  }, []);
  return { canvas, state };
}

function PageCell({
  side,
  loaded,
  page,
  info,
  scale,
  rowHeight,
  marks,
  selected,
  root,
  onPick,
  other,
}: {
  side: Side;
  loaded: LoadedPdf;
  page: number | null;
  info: PageInfo | null;
  scale: number;
  rowHeight: number;
  marks?: Mark[];
  selected: number;
  root: React.RefObject<HTMLElement | null> | null;
  onPick: (change: number) => void;
  other: number | null;
}) {
  const { canvas, state } = usePageCanvas(loaded, page, scale, root);
  if (page === null || !info) {
    return (
      <div
        className="flex items-center justify-center rounded-md border-2 border-dashed border-border px-2 text-center text-xs text-muted-foreground"
        style={{ height: rowHeight }}
      >
        <span>
          {side === "a" ? `Page ${(other ?? 0) + 1} of the changed version is new.` : `Page ${(other ?? 0) + 1} of the original is gone from the changed version.`}
          <canvas ref={canvas} hidden />
        </span>
      </div>
    );
  }
  const own = marks ?? [];
  const label = `${SIDE_LABEL[side]}, page ${page + 1}${own.length ? `: ${new Set(own.map((m) => m.change)).size} changes marked` : ""}`;
  return (
    <figure className="m-0 flex flex-col items-center" aria-label={label}>
      <PageSheet canvas={canvas} state={state} width={info.width * scale} height={info.height * scale} marks={own} scale={scale} side={side} selected={selected} onPick={onPick} />
      <figcaption className="mt-1 text-[11px] text-muted-foreground">Page {page + 1}</figcaption>
    </figure>
  );
}

/** A page's canvas with its marks over it. */
function PageSheet({
  canvas,
  state,
  width,
  height,
  marks,
  scale,
  side,
  selected,
  onPick,
  className,
  style,
}: {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  state: "drawing" | "drawn" | "failed";
  width: number;
  height: number;
  marks: Mark[];
  scale: number;
  side: Side;
  selected: number;
  onPick: (change: number) => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cn("relative bg-white shadow-sm ring-1 ring-black/10", className)} style={{ width, height, ...style }}>
      <canvas ref={canvas} width={0} height={0} aria-hidden className="block !h-full !w-full" />
      {state === "drawing" && (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />
        </span>
      )}
      {state === "failed" && <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">This page couldn&apos;t be drawn.</p>}
      {marks.map((m, i) => (
        <span
          key={i}
          aria-hidden
          data-change={m.change}
          onClick={() => onPick(m.change)}
          className={cn("absolute cursor-pointer", m.change === selected && "z-10 ring-2 ring-primary ring-offset-1 motion-safe:animate-pulse")}
          style={{
            left: m.box.x * scale,
            top: m.box.y * scale,
            width: Math.max(m.kind === "gap" ? 3 : 4, m.box.width * scale),
            height: Math.max(4, m.box.height * scale),
            ...markStyle(m.kind, side),
          }}
        />
      ))}
    </div>
  );
}

/** One pair of pages laid over each other: swipe between them, or see the pixels that differ. */
function Overlay({ pair: n, onPair, ...p }: PagesProps & { pair: number; onPair: (n: number) => void }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [mode, setMode] = useState<OverlayMode>("swipe");
  const [at, setAt] = useState(50);
  const pair = p.pairs[Math.min(n, p.pairs.length - 1)];
  const infoA = pair.a !== null ? p.pagesA[pair.a] : null;
  const infoB = pair.b !== null ? p.pagesB[pair.b] : null;
  const maxW = Math.max(infoA?.width ?? 0, infoB?.width ?? 0, 1);
  const maxH = Math.max(infoA?.height ?? 0, infoB?.height ?? 0, 1);
  const tall = typeof window === "undefined" ? 800 : Math.round(window.innerHeight * 0.75);
  const scale = width ? Math.min(width / maxW, tall / maxH) : 0;
  const pageA = usePageCanvas(p.a, pair.a, scale, null);
  const pageB = usePageCanvas(p.b, pair.b, scale, null);
  const diff = useRef<HTMLCanvasElement>(null);
  const [diffState, setDiffState] = useState<"idle" | "drawing" | "drawn">("idle");
  const both = pair.a !== null && pair.b !== null;

  // The Difference picture, from the two drawn pages, at the pixels they were drawn at.
  useEffect(() => {
    const out = diff.current;
    const ca = pageA.canvas.current;
    const cb = pageB.canvas.current;
    if (mode !== "difference" || !both || !out || !ca || !cb || pageA.state !== "drawn" || pageB.state !== "drawn") return;
    setDiffState("drawing");
    const w = Math.max(ca.width, cb.width);
    const h = Math.max(ca.height, cb.height);
    const flat = (c: HTMLCanvasElement) => {
      const sheet = document.createElement("canvas");
      sheet.width = w;
      sheet.height = h;
      const ctx = sheet.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(c, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      sheet.width = sheet.height = 0;
      return data;
    };
    const picture = differencePicture(flat(ca), flat(cb), w, h);
    out.width = w;
    out.height = h;
    out.getContext("2d")!.putImageData(new ImageData(picture as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    setDiffState("drawn");
  }, [mode, both, pageA.state, pageB.state, pageA.canvas, pageB.canvas]);

  useEffect(() => {
    const out = diff.current;
    return () => {
      if (out) out.width = out.height = 0;
    };
  }, []);

  const w = maxW * scale;
  const h = maxH * scale;
  const pageLabel = (side: Side, page: number | null) => (page === null ? `no ${side === "a" ? "original" : "changed"} page` : `${SIDE_LABEL[side].toLowerCase()} page ${page + 1}`);
  return (
    <div ref={ref} className="w-full space-y-3" data-overlay>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm">
          <Button size="sm" variant="outline" className="pointer-coarse:h-11 pointer-coarse:w-11" onClick={() => onPair(Math.max(0, n - 1))} disabled={n === 0} aria-label="Previous pages">
            <ChevronLeft />
          </Button>
          <span className="text-center text-muted-foreground" aria-live="polite">
            {pageLabel("a", pair.a).replace(/^./, (c) => c.toUpperCase())} · {pageLabel("b", pair.b)}
          </span>
          <Button size="sm" variant="outline" className="pointer-coarse:h-11 pointer-coarse:w-11" onClick={() => onPair(Math.min(p.pairs.length - 1, n + 1))} disabled={n >= p.pairs.length - 1} aria-label="Next pages">
            <ChevronRight />
          </Button>
        </div>
        {both && (
          <Segmented<OverlayMode>
            name="compare-overlay"
            legend="Show"
            value={mode}
            onChange={setMode}
            options={[
              { value: "swipe", label: "Swipe" },
              { value: "difference", label: "Difference" },
            ]}
          />
        )}
      </div>

      <div className="flex w-full justify-center rounded-2xl border border-border bg-secondary/40 p-2 sm:p-3" data-pair={n}>
        {scale > 0 && (
          <div className="relative" style={{ width: w, height: h }} data-testid="overlay">
            {/* The changed version underneath, the original on top as far as the swipe. */}
            <PageSheet
              canvas={pageB.canvas}
              state={pair.b === null ? "drawn" : pageB.state}
              width={(infoB?.width ?? maxW) * scale}
              height={(infoB?.height ?? maxH) * scale}
              marks={pair.b !== null ? (p.marksB.get(pair.b) ?? []) : []}
              scale={scale}
              side="b"
              selected={p.selected}
              onPick={p.onPick}
              className={cn("absolute left-0 top-0", (pair.b === null || mode === "difference") && "invisible")}
            />
            <PageSheet
              canvas={pageA.canvas}
              state={pair.a === null ? "drawn" : pageA.state}
              width={(infoA?.width ?? maxW) * scale}
              height={(infoA?.height ?? maxH) * scale}
              marks={pair.a !== null ? (p.marksA.get(pair.a) ?? []) : []}
              scale={scale}
              side="a"
              selected={p.selected}
              onPick={p.onPick}
              className={cn("absolute left-0 top-0", (pair.a === null || mode === "difference") && "invisible")}
              style={both ? { clipPath: `inset(0 ${100 - at}% 0 0)` } : undefined}
            />
            {both && mode === "swipe" && (
              <span aria-hidden className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-primary shadow" style={{ left: `${at}%` }} />
            )}
            {both && mode === "difference" && (
              <>
                <canvas ref={diff} width={0} height={0} aria-hidden className="absolute left-0 top-0 bg-white shadow-sm ring-1 ring-black/10" style={{ width: w, height: h }} />
                {diffState !== "drawn" && (
                  <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                    <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {both && mode === "swipe" && (
        <div className="mx-auto flex max-w-md items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-rose-700 dark:text-rose-300">{SIDE_LABEL.a}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={at}
            onChange={(e) => setAt(Number(e.target.value))}
            aria-label="Swipe: the original shows left of the line, the changed version right of it"
            aria-valuetext={`${at}% original`}
            className="h-11 flex-1 cursor-pointer accent-[hsl(var(--primary))]"
            data-testid="swipe"
          />
          <span className="font-medium text-emerald-700 dark:text-emerald-300">{SIDE_LABEL.b}</span>
        </div>
      )}
      {both && mode === "difference" && (
        <p className="text-center text-xs text-muted-foreground">
          Faint: the same in both. Red stripes: only in the original. Solid green: only in the changed version. Purple: a colour changed.
        </p>
      )}
      {!both && (
        <p className="text-center text-xs text-muted-foreground">
          {pair.a === null ? "This page is only in the changed version." : "This page is only in the original."}
        </p>
      )}
    </div>
  );
}
