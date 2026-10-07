"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCw, Trash2, Plus, GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import type { LoadedPdf } from "@/lib/pdf/render";
import { cn } from "@/lib/utils";

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
  onRotate: (page: number) => void;
  onDelete: (page: number) => void;
  onInsertAfter: (page: number) => void;
}) {
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const movedTo = useRef<number | null>(null);

  // Keyboard reordering re-renders the list; keep focus on the moved page.
  useEffect(() => {
    if (movedTo.current === null || busy || currentPage !== movedTo.current) return;
    movedTo.current = null;
    list.current?.querySelectorAll<HTMLButtonElement>("button[data-thumb]")[currentPage]?.focus();
  }, [busy, currentPage, numPages]);

  return (
    // Phones: a drawer over the page. Wider screens: a column beside it.
    <aside
      aria-label="Pages"
      className="absolute inset-y-0 left-0 z-20 w-56 overflow-y-auto border-r border-border bg-background p-2 shadow-2xl md:static md:z-auto md:w-44 md:shrink-0 md:shadow-none"
    >
      <p className="px-1 pb-2 text-xs font-medium text-muted-foreground">
        {numPages} {numPages === 1 ? "page" : "pages"}
      </p>
      <ul ref={list} className="space-y-2">
        {Array.from({ length: numPages }, (_, i) => (
          <li
            key={`${i}-${numPages}`}
            draggable={!busy}
            onDragStart={() => (dragFrom.current = i)}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver((d) => (d === i ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              if (dragFrom.current !== null && dragFrom.current !== i) {
                onReorder(dragFrom.current, i);
              }
              dragFrom.current = null;
            }}
            className={cn(
              "group rounded-lg border p-1.5 transition-colors",
              currentPage === i
                ? "border-primary bg-accent"
                : "border-transparent hover:border-border",
              dragOver === i && "border-primary border-dashed"
            )}
          >
            <button
              data-thumb
              onClick={() => onGoTo(i)}
              onKeyDown={(e) => {
                // Alt+↑/↓ moves the page: the keyboard version of dragging.
                if (!e.altKey || busy) return;
                const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
                if (to < 0 || to >= numPages) return;
                e.preventDefault();
                movedTo.current = to;
                onReorder(i, to);
              }}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className="block w-full rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Go to page ${i + 1}`}
            >
              <Thumbnail loaded={loaded} pageIndex={i} />
            </button>

            <div className="mt-1 flex flex-wrap items-center justify-between gap-y-1 px-0.5">
              <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                <GripVertical className="h-3 w-3 cursor-grab hover-none:hidden" />
                {i + 1}
              </span>
              {/* Touch has no drag and drop: move buttons instead. */}
              <span className="hidden gap-0.5 hover-none:flex">
                <IconButton
                  label="Move up"
                  onClick={() => {
                    movedTo.current = i - 1;
                    onReorder(i, i - 1);
                  }}
                  disabled={busy || i === 0}
                >
                  <ArrowUp className="h-3 w-3" />
                </IconButton>
                <IconButton
                  label="Move down"
                  onClick={() => {
                    movedTo.current = i + 1;
                    onReorder(i, i + 1);
                  }}
                  disabled={busy || i >= numPages - 1}
                >
                  <ArrowDown className="h-3 w-3" />
                </IconButton>
              </span>
              <span className="flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 hover-none:opacity-100">
                <IconButton label="Rotate" onClick={() => onRotate(i)} disabled={busy}>
                  <RotateCw className="h-3 w-3" />
                </IconButton>
                <IconButton
                  label="Insert page after"
                  onClick={() => onInsertAfter(i)}
                  disabled={busy}
                >
                  <Plus className="h-3 w-3" />
                </IconButton>
                <IconButton
                  label="Delete page"
                  onClick={() => onDelete(i)}
                  disabled={busy || numPages <= 1}
                >
                  <Trash2 className="h-3 w-3" />
                </IconButton>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
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

function Thumbnail({ loaded, pageIndex }: { loaded: LoadedPdf; pageIndex: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (ref.current) await loaded.renderPage(pageIndex + 1, ref.current, 0.24);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, pageIndex]);

  if (failed) {
    return (
      <div className="flex h-24 w-full items-center justify-center rounded border border-border bg-secondary text-xs text-muted-foreground">
        —
      </div>
    );
  }

  return (
    <canvas
      ref={ref}
      className="mx-auto block max-w-full !h-auto rounded border border-border bg-white shadow-sm"
    />
  );
}
