"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCw, Trash2, Plus, GripVertical } from "lucide-react";
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

  return (
    <aside className="w-44 shrink-0 overflow-y-auto border-r border-border bg-background p-2">
      <p className="px-1 pb-2 text-xs font-medium text-muted-foreground">
        {numPages} {numPages === 1 ? "page" : "pages"}
      </p>
      <ul className="space-y-2">
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
              onClick={() => onGoTo(i)}
              className="block w-full"
              aria-label={`Go to page ${i + 1}`}
            >
              <Thumbnail loaded={loaded} pageIndex={i} />
            </button>

            <div className="mt-1 flex items-center justify-between px-0.5">
              <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                <GripVertical className="h-3 w-3 cursor-grab" />
                {i + 1}
              </span>
              <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
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
      className="mx-auto block max-w-full rounded border border-border bg-white shadow-sm"
    />
  );
}
