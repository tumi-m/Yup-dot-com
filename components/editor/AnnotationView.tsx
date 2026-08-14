"use client";

import { useRef } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import type { Annotation } from "@/lib/editor/types";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "p1" | "p2";

const BOX_HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const CURSORS: Record<Handle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
  p1: "move",
  p2: "move",
};

const MIN = 6;

function resizeBox(
  ann: Annotation,
  handle: Handle,
  dx: number,
  dy: number
): Partial<Annotation> {
  let { x, y, width, height } = ann;
  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("e")) width += dx;
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (handle.includes("s")) height += dy;

  if (width < MIN) {
    if (handle.includes("w")) x -= MIN - width;
    width = MIN;
  }
  if (height < MIN) {
    if (handle.includes("n")) y -= MIN - height;
    height = MIN;
  }
  return { x, y, width, height };
}

export function AnnotationView({
  ann,
  scale,
  selected,
  interactive,
  onSelect,
  onChange,
  onCommitStart,
  onCommitEnd,
  onDelete,
}: {
  ann: Annotation;
  scale: number;
  selected: boolean;
  /** False while a creation drag is previewing this annotation. */
  interactive: boolean;
  onSelect: () => void;
  onChange: (next: Annotation) => void;
  onCommitStart: () => void;
  onCommitEnd: () => void;
  onDelete: () => void;
}) {
  const gesture = useRef<{
    kind: "move" | Handle;
    startX: number;
    startY: number;
    origin: Annotation;
  } | null>(null);

  const isLine =
    ann.type === "shape" && (ann.shape === "line" || ann.shape === "arrow");

  function begin(e: React.PointerEvent, kind: "move" | Handle) {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origin: ann,
    };
    onCommitStart();
  }

  function move(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    const dx = (e.clientX - g.startX) / scale;
    const dy = (e.clientY - g.startY) / scale;
    const origin = g.origin;

    if (g.kind === "move") {
      if (isLine && origin.type === "shape") {
        onChange({
          ...origin,
          x: origin.x + dx,
          y: origin.y + dy,
          x1: (origin.x1 ?? 0) + dx,
          y1: (origin.y1 ?? 0) + dy,
          x2: (origin.x2 ?? 0) + dx,
          y2: (origin.y2 ?? 0) + dy,
        });
      } else {
        onChange({ ...origin, x: origin.x + dx, y: origin.y + dy });
      }
      return;
    }

    // Endpoint drag for lines and arrows.
    if ((g.kind === "p1" || g.kind === "p2") && origin.type === "shape") {
      const next = { ...origin };
      if (g.kind === "p1") {
        next.x1 = (origin.x1 ?? 0) + dx;
        next.y1 = (origin.y1 ?? 0) + dy;
      } else {
        next.x2 = (origin.x2 ?? 0) + dx;
        next.y2 = (origin.y2 ?? 0) + dy;
      }
      next.x = Math.min(next.x1!, next.x2!);
      next.y = Math.min(next.y1!, next.y2!);
      next.width = Math.abs(next.x2! - next.x1!);
      next.height = Math.abs(next.y2! - next.y1!);
      onChange(next);
      return;
    }

    const box = resizeBox(origin, g.kind, dx, dy);
    if (origin.type === "draw") {
      // Scale the stroke with its bounding box.
      const sx = (box.width as number) / Math.max(1, origin.width);
      const sy = (box.height as number) / Math.max(1, origin.height);
      onChange({
        ...origin,
        ...box,
        points: origin.points.map((p) => ({ x: p.x * sx, y: p.y * sy })),
      } as Annotation);
    } else {
      onChange({ ...origin, ...box } as Annotation);
    }
  }

  function end(e: React.PointerEvent) {
    if (!gesture.current) return;
    gesture.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    onCommitEnd();
  }

  const style: React.CSSProperties = {
    position: "absolute",
    left: ann.x * scale,
    top: ann.y * scale,
    width: Math.max(1, ann.width * scale),
    height: Math.max(1, ann.height * scale),
    cursor: interactive ? "move" : "default",
    touchAction: "none",
  };

  return (
    <div
      style={style}
      onPointerDown={(e) => begin(e, "move")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={selected ? "z-20" : "z-10"}
    >
      {/* selection frame */}
      {selected && interactive && (
        <div className="pointer-events-none absolute -inset-[2px] rounded-[2px] border-2 border-primary" />
      )}

      <Content ann={ann} scale={scale} selected={selected} interactive={interactive} onChange={onChange} />

      {selected && interactive && (
        <>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="absolute -right-3 -top-3 z-30 flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow"
            aria-label="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>

          {(isLine ? (["p1", "p2"] as Handle[]) : BOX_HANDLES).map((h) => (
            <span
              key={h}
              onPointerDown={(e) => begin(e, h)}
              onPointerMove={move}
              onPointerUp={end}
              style={{ cursor: CURSORS[h], ...handlePosition(h, ann) }}
              className="absolute z-30 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary shadow"
            />
          ))}
        </>
      )}
    </div>
  );
}

function handlePosition(handle: Handle, ann: Annotation): React.CSSProperties {
  if (handle === "p1" || handle === "p2") {
    const w = Math.max(1, ann.width);
    const h = Math.max(1, ann.height);
    if (ann.type !== "shape") return {};
    const px = handle === "p1" ? ann.x1 ?? ann.x : ann.x2 ?? ann.x + w;
    const py = handle === "p1" ? ann.y1 ?? ann.y : ann.y2 ?? ann.y + h;
    return {
      left: `${((px - ann.x) / w) * 100}%`,
      top: `${((py - ann.y) / h) * 100}%`,
    };
  }
  const left = handle.includes("w") ? "0%" : handle.includes("e") ? "100%" : "50%";
  const top = handle.includes("n") ? "0%" : handle.includes("s") ? "100%" : "50%";
  return { left, top };
}

/** The visual body of an annotation, independent of selection chrome. */
function Content({
  ann,
  scale,
  selected,
  interactive,
  onChange,
}: {
  ann: Annotation;
  scale: number;
  selected: boolean;
  interactive: boolean;
  onChange: (next: Annotation) => void;
}) {
  switch (ann.type) {
    case "text":
      return (
        <textarea
          value={ann.text}
          onChange={(e) => onChange({ ...ann, text: e.target.value })}
          onPointerDown={(e) => selected && e.stopPropagation()}
          readOnly={!interactive}
          spellCheck={false}
          className="h-full w-full resize-none overflow-hidden border-none bg-transparent p-0 leading-tight outline-none"
          style={{
            fontSize: ann.fontSize * scale,
            color: ann.color,
            fontWeight: ann.bold ? 700 : 400,
            fontFamily: "Helvetica, Arial, sans-serif",
          }}
        />
      );

    case "draw":
      return (
        <svg
          className="pointer-events-none h-full w-full overflow-visible"
          viewBox={`0 0 ${Math.max(1, ann.width)} ${Math.max(1, ann.height)}`}
          preserveAspectRatio="none"
        >
          <polyline
            points={ann.points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={ann.color}
            strokeWidth={ann.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );

    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return (
        <img
          src={ann.dataUrl}
          alt={ann.signature ? "Signature" : "Image"}
          className="pointer-events-none h-full w-full object-contain"
          draggable={false}
        />
      );

    case "note":
      return (
        <div
          className="flex h-full w-full flex-col overflow-hidden rounded-sm border shadow-sm"
          style={{ borderColor: ann.color, background: `${ann.color}33` }}
        >
          <div
            className="px-1.5 py-0.5 text-[10px] font-semibold text-black/70"
            style={{ background: ann.color }}
          >
            Note
          </div>
          <textarea
            value={ann.text}
            onChange={(e) => onChange({ ...ann, text: e.target.value })}
            onPointerDown={(e) => selected && e.stopPropagation()}
            readOnly={!interactive}
            placeholder="Add a comment…"
            className="flex-1 resize-none border-none bg-transparent p-1.5 text-[11px] leading-snug outline-none"
          />
        </div>
      );

    case "shape": {
      if (ann.shape === "whiteout") {
        return (
          <div className="h-full w-full bg-white" style={{ outline: selected ? "1px dashed #94a3b8" : "none" }} />
        );
      }
      if (ann.shape === "line" || ann.shape === "arrow") {
        const w = Math.max(1, ann.width);
        const h = Math.max(1, ann.height);
        const x1 = ((ann.x1 ?? ann.x) - ann.x);
        const y1 = ((ann.y1 ?? ann.y) - ann.y);
        const x2 = ((ann.x2 ?? ann.x + w) - ann.x);
        const y2 = ((ann.y2 ?? ann.y + h) - ann.y);
        const id = `arrow-${ann.id}`;
        return (
          <svg className="pointer-events-none h-full w-full overflow-visible" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            {ann.shape === "arrow" && (
              <defs>
                <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={ann.stroke} />
                </marker>
              </defs>
            )}
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={ann.stroke}
              strokeWidth={ann.strokeWidth}
              strokeLinecap="round"
              opacity={ann.opacity}
              vectorEffect="non-scaling-stroke"
              markerEnd={ann.shape === "arrow" ? `url(#${id})` : undefined}
            />
          </svg>
        );
      }
      return (
        <div
          className="h-full w-full"
          style={{
            border: `${ann.strokeWidth * scale}px solid ${ann.stroke}`,
            background: ann.fill ?? "transparent",
            opacity: ann.opacity,
            borderRadius: ann.shape === "ellipse" ? "50%" : 2,
          }}
        />
      );
    }

    case "markup": {
      if (ann.markup === "highlight") {
        return (
          <div
            className="h-full w-full rounded-[1px]"
            style={{ background: ann.color, opacity: ann.opacity, mixBlendMode: "multiply" }}
          />
        );
      }
      const thickness = Math.max(1, ann.height * 0.08 * scale);
      return (
        <div className="relative h-full w-full">
          <div
            className="absolute left-0 w-full"
            style={{
              background: ann.color,
              height: thickness,
              opacity: ann.opacity,
              top: ann.markup === "underline" ? "100%" : "50%",
              transform: "translateY(-50%)",
            }}
          />
        </div>
      );
    }

    case "link":
      return (
        <div className="flex h-full w-full items-center gap-1 overflow-hidden rounded-sm border border-dashed border-blue-500/70 bg-blue-500/5 px-1">
          <ExternalLink className="h-3 w-3 shrink-0 text-blue-600" />
          <span className="truncate text-[10px] text-blue-700">
            {ann.targetPage !== null ? `Page ${ann.targetPage + 1}` : ann.url || "Set a URL"}
          </span>
        </div>
      );

    case "field": {
      const base =
        "h-full w-full rounded-sm border border-dashed border-violet-500 bg-violet-500/10 text-[11px] text-violet-900";
      if (ann.field === "checkbox") {
        return (
          <div className={`${base} flex items-center justify-center`}>
            {ann.value === "true" ? "✓" : ""}
          </div>
        );
      }
      if (ann.field === "radio") {
        return (
          <div className={`${base} flex items-center justify-center rounded-full`}>
            {ann.value ? "●" : ""}
          </div>
        );
      }
      if (ann.field === "dropdown") {
        return (
          <div className={`${base} flex items-center justify-between px-1`}>
            <span className="truncate">{ann.value || ann.options[0] || "Select…"}</span>
            <span>▾</span>
          </div>
        );
      }
      return (
        <div className={`${base} flex items-center px-1`}>
          <span className="truncate">{ann.value || ann.name}</span>
        </div>
      );
    }
  }
}
