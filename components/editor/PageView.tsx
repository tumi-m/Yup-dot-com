"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { LoadedPdf } from "@/lib/pdf/render";
import type { Annotation, ToolId, ToolSettings } from "@/lib/editor/types";
import { DRAG_TOOLS } from "@/lib/editor/types";
import { createAnnotation, resizeDraft, isDraftUsable } from "@/lib/editor/factory";
import type { DetectedField } from "@/lib/pdf/forms";
import { AnnotationView } from "./AnnotationView";

export function PageView({
  loaded,
  pageIndex,
  scale,
  tool,
  settings,
  placementImage,
  annotations,
  selectedId,
  formFields,
  formValues,
  onFormChange,
  onSelect,
  onCreate,
  onChange,
  onCommitStart,
  onCommitEnd,
  onDelete,
  onPlacementUsed,
  onRendered,
}: {
  loaded: LoadedPdf;
  pageIndex: number;
  scale: number;
  tool: ToolId;
  settings: ToolSettings;
  /** Data URL waiting to be placed by the image/signature tool. */
  placementImage: string | null;
  annotations: Annotation[];
  selectedId: string | null;
  formFields: DetectedField[];
  formValues: Record<string, string>;
  onFormChange: (name: string, value: string) => void;
  onSelect: (id: string | null) => void;
  onCreate: (ann: Annotation) => void;
  onChange: (ann: Annotation) => void;
  onCommitStart: () => void;
  onCommitEnd: () => void;
  onDelete: (id: string) => void;
  onPlacementUsed: () => void;
  onRendered?: (size: { width: number; height: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** A tap waiting to place a box when the finger lifts. */
  const tap = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vp = await loaded.getPageViewport(pageIndex + 1, scale);
      if (cancelled) return;
      setSize({ w: vp.width, h: vp.height });
      if (canvasRef.current) {
        await loaded.renderPage(pageIndex + 1, canvasRef.current, scale);
        if (!cancelled) onRendered?.({ width: vp.width, height: vp.height });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, pageIndex, scale]);

  function toPoints(e: React.PointerEvent) {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (tool === "select") {
      onSelect(null);
      return;
    }
    const { x, y } = toPoints(e);

    // Click-to-place tools.
    if (!DRAG_TOOLS.includes(tool)) {
      if (e.pointerType !== "mouse") {
        // Touch: place on lift, inside the gesture, so the keyboard can open.
        // No emulated mousedown afterwards to pull focus off the new box.
        e.preventDefault();
        tap.current = { x, y, pointerId: e.pointerId };
        return;
      }
      // Keep the mousedown that follows from taking focus off the new box.
      e.preventDefault();
      place(x, y);
      return;
    }

    // Drag-to-create tools.
    layerRef.current!.setPointerCapture(e.pointerId);
    origin.current = { x, y };
    const ann = createAnnotation(tool, settings, x, y);
    if (ann) setDraft({ ...ann, page: pageIndex });
  }

  function place(x: number, y: number) {
    const dataUrl = placementImage ?? undefined;
    if ((tool === "image" || tool === "signature") && !dataUrl) return;
    const ann = createAnnotation(tool, settings, x, y, { dataUrl });
    if (!ann) return;
    flushSync(() => onCreate({ ...ann, page: pageIndex }));
    if (tool === "image" || tool === "signature") onPlacementUsed();
    const box = layerRef.current?.querySelector<HTMLTextAreaElement>(`[data-ann-id="${CSS.escape(ann.id)}"] textarea`);
    if (box && document.activeElement !== box) {
      box.focus({ preventScroll: true });
      box.select();
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!draft || !origin.current) return;
    const { x, y } = toPoints(e);
    setDraft(resizeDraft(draft, origin.current.x, origin.current.y, x, y));
  }

  function handlePointerUp(e: React.PointerEvent) {
    const pending = tap.current;
    if (pending && pending.pointerId === e.pointerId) {
      tap.current = null;
      if (e.type === "pointerup") place(pending.x, pending.y);
      return;
    }
    try {
      layerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const finished = draft;
    setDraft(null);
    origin.current = null;
    if (finished && isDraftUsable(finished)) onCreate(finished);
  }

  const editable = tool === "select";
  const cursor =
    tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  const pageFields = formFields.filter((f) => f.page === pageIndex);

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="pdf-page-canvas rounded-sm" />

      {size && (
        <div
          ref={layerRef}
          className="annotation-layer"
          style={{ width: size.w, height: size.h, cursor, touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Existing AcroForm fields, rendered as live inputs. */}
          {pageFields.map((field) => (
            <FormFieldOverlay
              key={field.id}
              field={field}
              scale={scale}
              value={formValues[field.name] ?? field.value}
              onChange={(v) => onFormChange(field.name, v)}
            />
          ))}

          {annotations.map((ann) => (
            <AnnotationView
              key={ann.id}
              ann={ann}
              scale={scale}
              selected={selectedId === ann.id}
              interactive={editable}
              onSelect={() => onSelect(ann.id)}
              onChange={onChange}
              onCommitStart={onCommitStart}
              onCommitEnd={onCommitEnd}
              onDelete={() => onDelete(ann.id)}
            />
          ))}

          {draft && (
            <AnnotationView
              ann={draft}
              scale={scale}
              selected={false}
              interactive={false}
              onSelect={() => {}}
              onChange={() => {}}
              onCommitStart={() => {}}
              onCommitEnd={() => {}}
              onDelete={() => {}}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** A live input positioned over an existing form field in the PDF. */
function FormFieldOverlay({
  field,
  scale,
  value,
  onChange,
}: {
  field: DetectedField;
  scale: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: field.x * scale,
    top: field.y * scale,
    width: Math.max(8, field.width * scale),
    height: Math.max(8, field.height * scale),
  };

  const shared =
    "border border-emerald-500/70 bg-emerald-400/10 outline-none focus:ring-2 focus:ring-emerald-500";

  if (field.readOnly) {
    return <div style={style} className="pointer-events-none rounded-sm border border-dashed border-muted-foreground/40" />;
  }

  if (field.kind === "checkbox") {
    return (
      <div style={style} onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          role="checkbox"
          aria-checked={value === "true"}
          aria-label={field.name}
          onClick={() => onChange(value === "true" ? "" : "true")}
          className={`flex h-full w-full items-center justify-center rounded-sm text-sm ${shared}`}
        >
          {value === "true" ? "✓" : ""}
        </button>
      </div>
    );
  }

  if (field.kind === "radio") {
    const on = value && field.exportValue === value;
    return (
      <div style={style} onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          role="radio"
          aria-checked={!!on}
          aria-label={`${field.name}: ${field.exportValue ?? ""}`}
          onClick={() => onChange(field.exportValue ?? "")}
          className={`flex h-full w-full items-center justify-center rounded-full text-sm ${shared}`}
        >
          {on ? "●" : ""}
        </button>
      </div>
    );
  }

  if (field.kind === "dropdown") {
    return (
      <div style={style} onPointerDown={(e) => e.stopPropagation()}>
        <select
          aria-label={field.name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`h-full w-full rounded-sm px-1 ${shared}`}
          data-fit-text
          style={{ fontSize: Math.max(8, field.height * scale * 0.6) }}
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div style={style} onPointerDown={(e) => e.stopPropagation()}>
      <input
        aria-label={field.name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-full w-full rounded-sm px-1 ${shared}`}
        data-fit-text
        style={{ fontSize: Math.max(8, field.height * scale * 0.55) }}
      />
    </div>
  );
}
