"use client";

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RotateCw, Trash2, Plus, GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import type { LoadedPdf } from "@/lib/pdf/render";
import { pageActionFocus, type PageAction } from "@/lib/editor/keyboard";
import { DRAWN_AT_ONCE, NEAR_MARGIN, taskLimiter } from "@/lib/editor/thumbnails";
import { cn } from "@/lib/utils";

/** Thumbnails are drawn at this zoom. */
const THUMB_SCALE = 0.24;
/** An A4 page at that zoom: a thumbnail's size until a page has been measured. */
const A4_THUMB = { width: 595 * THUMB_SCALE, height: 842 * THUMB_SCALE };

type Size = { width: number; height: number };
type Watch = (el: Element, onChange: (near: boolean) => void) => () => void;
type Slot = <T>(task: () => Promise<T>) => Promise<T>;

/** What the thumbnails draw with. Rows don't take it, so a new document redraws thumbnails, not rows. */
const Drawing = createContext<{ loaded: LoadedPdf; placeholder: Size; watch: Watch; slot: Slot } | null>(null);

/** The rows' handlers, the same for the life of the list, so rows are drawn again only when their own page changes. */
interface RowActions {
  goTo(i: number): void;
  keyDown(e: React.KeyboardEvent, i: number): void;
  move(from: number, to: number): void;
  act(action: PageAction, i: number): void;
  dragStart(e: React.DragEvent, i: number): void;
  dragOver(e: React.DragEvent, i: number): void;
  dragLeave(i: number): void;
  drop(e: React.DragEvent, i: number): void;
}

/** Page navigator with drag-to-reorder and per-page actions. */
export function ThumbnailSidebar({
  loaded,
  numPages,
  currentPage,
  busy,
  onGoTo,
  onReorder,
  onRotate,
  onDelete,
  onInsertAfter,
}: {
  loaded: LoadedPdf;
  numPages: number;
  currentPage: number;
  busy: boolean;
  onGoTo: (page: number) => void;
  onReorder: (from: number, to: number) => void;
  /** Page actions resolve to whether they worked. */
  onRotate: (page: number) => Promise<boolean>;
  onDelete: (page: number) => Promise<boolean>;
  onInsertAfter: (page: number) => Promise<boolean>;
}) {
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const movedTo = useRef<number | null>(null);
  /** Where focus goes once a page action is done and the pages have caught up. */
  const refocus = useRef<ReturnType<typeof pageActionFocus> | null>(null);
  const [settled, setSettled] = useState(0);
  const aside = useRef<HTMLElement>(null);
  /** One observer for the list: tells each thumbnail when it comes near the visible part. */
  const [watch] = useState<Watch>(() => {
    const listeners = new Map<Element, (near: boolean) => void>();
    let observer: IntersectionObserver | null = null;
    const watchOne: Watch = (el, onChange) => {
      if (typeof IntersectionObserver === "undefined") {
        onChange(true);
        return () => {};
      }
      observer ??= new IntersectionObserver(
        (entries) => entries.forEach((e) => listeners.get(e.target)?.(e.isIntersecting)),
        { root: aside.current, rootMargin: NEAR_MARGIN }
      );
      listeners.set(el, onChange);
      observer.observe(el);
      return () => {
        listeners.delete(el);
        observer?.unobserve(el);
      };
    };
    return watchOne;
  });
  const [slot] = useState<Slot>(() => taskLimiter(DRAWN_AT_ONCE));
  /** The first page's size, for thumbnails not yet drawn. */
  const [placeholder, setPlaceholder] = useState<Size>(A4_THUMB);
  useEffect(() => {
    let live = true;
    loaded.getPageViewport(1, THUMB_SCALE).then(
      (vp) => live && setPlaceholder({ width: vp.width, height: vp.height }),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [loaded]);

  // Keyboard reordering re-renders the list; keep focus on the moved page.
  useEffect(() => {
    if (movedTo.current === null || busy || currentPage !== movedTo.current) return;
    movedTo.current = null;
    list.current?.querySelectorAll<HTMLButtonElement>("button[data-thumb]")[currentPage]?.focus();
  }, [busy, currentPage, numPages]);

  // Page actions disable the panel while they run, which drops focus. Put it
  // back: on Rotate again after a rotation, on the new page after an insert,
  // on the page that took the deleted one's place, or on the same button if
  // the action failed.
  useEffect(() => {
    const r = refocus.current;
    if (!r || busy || numPages !== r.pages) return;
    refocus.current = null;
    const row = list.current?.children[Math.min(r.index, numPages - 1)];
    row?.querySelector<HTMLElement>(r.action ? `[data-action="${r.action}"]` : "button[data-thumb]")?.focus();
  }, [busy, numPages, settled]);

  // A long document has thousands of rows: their handlers read the latest props.
  const latest = useRef({ numPages, busy, onGoTo, onReorder, onRotate, onDelete, onInsertAfter });
  useLayoutEffect(() => {
    latest.current = { numPages, busy, onGoTo, onReorder, onRotate, onDelete, onInsertAfter };
  });
  const [actions] = useState<RowActions>(() => ({
    goTo: (i) => latest.current.onGoTo(i),
    keyDown: (e, i) => {
      // Alt+↑/↓ moves the page: the keyboard version of dragging.
      if (!e.altKey || latest.current.busy) return;
      const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
      if (to < 0 || to >= latest.current.numPages) return;
      e.preventDefault();
      movedTo.current = to;
      latest.current.onReorder(i, to);
    },
    move: (from, to) => {
      movedTo.current = to;
      latest.current.onReorder(from, to);
    },
    act: (action, i) => {
      const { numPages: pages, onRotate: rotate, onInsertAfter: insert, onDelete: remove } = latest.current;
      const run = action === "rotate" ? rotate : action === "insert" ? insert : remove;
      const hadFocus = !!list.current?.contains(document.activeElement);
      run(i).then((ok) => {
        if (!hadFocus) return;
        refocus.current = pageActionFocus(action, i, ok, pages);
        setSettled((n) => n + 1);
      });
    },
    dragStart: (e, i) => {
      if (latest.current.busy) return e.preventDefault();
      dragFrom.current = i;
    },
    dragOver: (e, i) => {
      e.preventDefault();
      setDragOver(i);
    },
    dragLeave: (i) => setDragOver((d) => (d === i ? null : d)),
    drop: (e, i) => {
      e.preventDefault();
      setDragOver(null);
      if (dragFrom.current !== null && dragFrom.current !== i) latest.current.onReorder(dragFrom.current, i);
      dragFrom.current = null;
    },
  }));
  const drawing = useMemo(() => ({ loaded, placeholder, watch, slot }), [loaded, placeholder, watch, slot]);

  return (
    // Phones: a drawer over the page. Wider screens: a column beside it.
    <aside
      ref={aside}
      aria-label="Pages"
      className="absolute inset-y-0 left-0 z-20 w-56 overflow-y-auto border-r border-border bg-background p-2 shadow-2xl md:static md:z-auto md:w-44 md:shrink-0 md:shadow-none"
    >
      <p className="px-1 pb-2 text-xs font-medium text-muted-foreground">
        {numPages} {numPages === 1 ? "page" : "pages"}
      </p>
      {/* A page action disables the whole list while it runs, without drawing every row again. */}
      <fieldset disabled={busy} className="min-w-0">
        <Drawing.Provider value={drawing}>
          <ul ref={list} className="space-y-2">
            {Array.from({ length: numPages }, (_, i) => (
              <PageRow
                key={i}
                i={i}
                last={i === numPages - 1}
                only={numPages <= 1}
                current={currentPage === i}
                dragOver={dragOver === i}
                actions={actions}
              />
            ))}
          </ul>
        </Drawing.Provider>
      </fieldset>
    </aside>
  );
}

const PageRow = memo(function PageRow({
  i,
  last,
  only,
  current,
  dragOver,
  actions,
}: {
  i: number;
  last: boolean;
  only: boolean;
  current: boolean;
  dragOver: boolean;
  actions: RowActions;
}) {
  return (
    <li
      draggable
      onDragStart={(e) => actions.dragStart(e, i)}
      onDragOver={(e) => actions.dragOver(e, i)}
      onDragLeave={() => actions.dragLeave(i)}
      onDrop={(e) => actions.drop(e, i)}
      className={cn(
        "group rounded-lg border p-1.5 transition-colors",
        current ? "border-primary bg-accent" : "border-transparent hover:border-border",
        dragOver && "border-primary border-dashed"
      )}
    >
      <button
        data-thumb
        onClick={() => actions.goTo(i)}
        onKeyDown={(e) => actions.keyDown(e, i)}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        className="block w-full rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Go to page ${i + 1}`}
      >
        <Thumbnail pageIndex={i} />
      </button>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-y-1 px-0.5">
        <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
          <GripVertical className="h-3 w-3 cursor-grab hover-none:hidden" />
          {i + 1}
        </span>
        {/* Touch has no drag and drop: move buttons instead. */}
        <span className="hidden gap-0.5 hover-none:flex">
          <IconButton label={`Move page ${i + 1} up`} onClick={() => actions.move(i, i - 1)} disabled={i === 0}>
            <ArrowUp className="h-3 w-3" />
          </IconButton>
          <IconButton label={`Move page ${i + 1} down`} onClick={() => actions.move(i, i + 1)} disabled={last}>
            <ArrowDown className="h-3 w-3" />
          </IconButton>
        </span>
        <span className="flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 hover-none:opacity-100">
          <IconButton label={`Rotate page ${i + 1}`} action="rotate" onClick={() => actions.act("rotate", i)}>
            <RotateCw className="h-3 w-3" />
          </IconButton>
          <IconButton label={`Insert page after page ${i + 1}`} action="insert" onClick={() => actions.act("insert", i)}>
            <Plus className="h-3 w-3" />
          </IconButton>
          <IconButton label={`Delete page ${i + 1}`} action="delete" onClick={() => actions.act("delete", i)} disabled={only}>
            <Trash2 className="h-3 w-3" />
          </IconButton>
        </span>
      </div>
    </li>
  );
});

function IconButton({
  children,
  label,
  action,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  action?: PageAction;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      data-action={action}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 pointer-coarse:h-11 pointer-coarse:w-11"
    >
      {children}
    </button>
  );
}

/** Lets go of a canvas's pixels now, not when it is collected. */
function release(canvas: HTMLCanvasElement) {
  canvas.width = canvas.height = 0;
}

/**
 * A page drawn only while near the visible part of the list, a few at a time
 * (`slot`). Far away it lets go of its pixels and keeps its size.
 */
function Thumbnail({ pageIndex }: { pageIndex: number }) {
  const { loaded, placeholder, watch, slot } = useContext(Drawing)!;
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const nearRef = useRef(false);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState<Size | null>(null);
  const [failedFor, setFailedFor] = useState<LoadedPdf | null>(null);

  useEffect(() => {
    if (!box.current) return;
    return watch(box.current, (v) => {
      nearRef.current = v;
      setNear(v);
    });
  }, [watch]);

  useEffect(() => {
    const canvas = ref.current;
    if (!near || !canvas) return;
    let current = true;
    slot(async () => {
      if (!current) return;
      const vp = await loaded.getPageViewport(pageIndex + 1, THUMB_SCALE);
      if (!current) return;
      setSize({ width: vp.width, height: vp.height });
      await loaded.renderPage(pageIndex + 1, canvas, THUMB_SCALE);
      // Scrolled away while it was drawn.
      if (!nearRef.current) release(canvas);
    }).catch(() => {
      if (current) setFailedFor(loaded);
    });
    return () => {
      current = false;
    };
  }, [near, loaded, pageIndex, slot]);

  useEffect(() => {
    if (!near && ref.current) release(ref.current);
  }, [near]);

  const shown = size ?? placeholder;
  return (
    <div ref={box}>
      {failedFor === loaded ? (
        <div className="flex h-24 w-full items-center justify-center rounded border border-border bg-secondary text-xs text-muted-foreground">
          —
        </div>
      ) : (
        <div className="mx-auto max-w-full" style={{ width: shown.width, aspectRatio: `${shown.width} / ${shown.height}` }}>
          <canvas
            ref={ref}
            width={0}
            height={0}
            className="block !h-full !w-full rounded border border-border bg-white shadow-sm"
          />
        </div>
      )}
    </div>
  );
}
