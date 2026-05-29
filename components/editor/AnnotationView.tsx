"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import type { Annotation } from "@/lib/types";

/**
 * Renders a single annotation inside the page overlay. Positions are stored in
 * PDF points; we multiply by `scale` to get on-screen pixels.
 */
export function AnnotationView({
  ann,
  scale,
  selected,
  editable,
  onSelect,
  onChange,
  onDelete,
}: {
  ann: Annotation;
  scale: number;
  selected: boolean;
  editable: boolean;
  onSelect: () => void;
  onChange: (next: Annotation) => void;
  onDelete: () => void;
}) {
  const dragState = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null
  );

  function onPointerDown(e: React.PointerEvent) {
    if (!editable) return;
    e.stopPropagation();
    onSelect();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { x: e.clientX, y: e.clientY, ox: ann.x, oy: ann.y };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragState.current) return;
    const dx = (e.clientX - dragState.current.x) / scale;
    const dy = (e.clientY - dragState.current.y) / scale;
    onChange({ ...ann, x: dragState.current.ox + dx, y: dragState.current.oy + dy });
  }

  function onPointerUp(e: React.PointerEvent) {
    dragState.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }

  const style: React.CSSProperties = {
    position: "absolute",
    left: ann.x * scale,
    top: ann.y * scale,
    width: ann.width * scale,
    height: ann.height * scale,
    cursor: editable ? "move" : "default",
    outline: selected ? "2px solid hsl(244 76% 59%)" : "none",
    outlineOffset: 2,
    touchAction: "none",
  };

  return (
    <div
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {selected && editable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -right-2.5 -top-2.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow"
          aria-label="Delete annotation"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {ann.type === "text" && (
        <textarea
          value={ann.text}
          onChange={(e) => onChange({ ...ann, text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          readOnly={!editable}
          spellCheck={false}
          className="h-full w-full resize-none overflow-hidden border-none bg-transparent p-0 leading-tight outline-none"
          style={{
            fontSize: ann.fontSize * scale,
            color: ann.color,
            fontFamily: "Helvetica, Arial, sans-serif",
          }}
        />
      )}

      {ann.type === "highlight" && (
        <div
          className="h-full w-full rounded-sm"
          style={{ background: ann.color, opacity: ann.opacity }}
        />
      )}

      {ann.type === "draw" && (
        <svg
          className="pointer-events-none h-full w-full overflow-visible"
          viewBox={`0 0 ${ann.width} ${ann.height}`}
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
      )}

      {ann.type === "signature" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ann.dataUrl}
          alt="signature"
          className="pointer-events-none h-full w-full object-contain"
          draggable={false}
        />
      )}
    </div>
  );
}
