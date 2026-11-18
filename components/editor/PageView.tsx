"use client";

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { LoadedPdf } from "@/lib/pdf/render";
import type { Annotation, ToolId, ToolSettings } from "@/lib/editor/types";
import { DRAG_TOOLS } from "@/lib/editor/types";
import { createAnnotation, createCentred, resizeDraft, finishDraft } from "@/lib/editor/factory";
import { pageTouchAction } from "@/lib/editor/canvas";
import { radioStep, radioTabStops } from "@/lib/editor/keyboard";
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
  placeNow,
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
  onCreate: (ann: Annotation, keyboard?: boolean) => void;
  onChange: (ann: Annotation) => void;
  onCommitStart: () => void;
  onCommitEnd: () => void;
  onDelete: (id: string) => void;
  onPlacementUsed: () => void;
  onRendered?: (size: { width: number; height: number }) => void;
  /** Bumped to place the current tool's item in the middle of the view (keyboard). */
  placeNow: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** A tap waiting to place a box when the finger lifts. */
  const tap = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const placed = useRef(placeNow);
  /** An annotation placed from the keyboard, to focus once it has rendered. */
  const focusNew = useRef<string | null>(null);
  const hint = useId();
  const textHint = useId();
  const pageFields = formFields.filter((f) => f.page === pageIndex);
  // Fields shown as inputs are left off the canvas. They are found after the
  // first render, so the page is drawn again once they are.
  const hasFields = pageFields.length > 0;
  const radioStops = radioTabStops(pageFields, formValues);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A page the document doesn't have (it is being replaced) isn't drawn.
      if (pageIndex >= loaded.numPages) return;
      const vp = await loaded.getPageViewport(pageIndex + 1, scale);
      if (cancelled) return;
      setSize({ w: vp.width, h: vp.height });
      if (canvasRef.current) {
        await loaded.renderPage(pageIndex + 1, canvasRef.current, scale, { liveFields: hasFields });
        if (!cancelled) onRendered?.({ width: vp.width, height: vp.height });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, pageIndex, scale, hasFields]);

  function toPoints(e: React.PointerEvent) {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (tool === "select") {
      // A finger may be starting a swipe that scrolls the page: deselect on
      // lift, and not when the swipe takes over (pointercancel).
      if (e.pointerType !== "mouse") tap.current = { x: 0, y: 0, pointerId: e.pointerId };
      else onSelect(null);
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

  // Keyboard placement: the middle of the part of the page in view.
  useEffect(() => {
    if (placeNow === placed.current) return;
    placed.current = placeNow;
    const layer = layerRef.current;
    if (!layer || !size) return;
    const rect = layer.getBoundingClientRect();
    const view = layer.closest("main")?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const mid = (lo: number, hi: number, start: number, end: number) =>
      Math.max(lo, start) < Math.min(hi, end) ? (Math.max(lo, start) + Math.min(hi, end)) / 2 : (lo + hi) / 2;
    const cx = (mid(rect.left, rect.right, view.left, view.right) - rect.left) / scale;
    const cy = (mid(rect.top, rect.bottom, view.top, view.bottom) - rect.top) / scale;
    const dataUrl = placementImage ?? undefined;
    const ann = createCentred(tool, settings, cx, cy, { width: size.w / scale, height: size.h / scale }, { dataUrl });
    if (!ann) return;
    focusNew.current = ann.id;
    onCreate({ ...ann, page: pageIndex }, true);
    if (tool === "image" || tool === "signature") onPlacementUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeNow]);

  // It takes focus once it is on the page: a text in its box, anything else itself.
  useEffect(() => {
    const id = focusNew.current;
    const el = id && layerRef.current?.querySelector<HTMLElement>(`[data-ann-id="${CSS.escape(id)}"]`);
    if (!el) return;
    focusNew.current = null;
    const box = el.querySelector("textarea");
    if (box) {
      box.focus({ preventScroll: true });
      box.select();
    } else {
      el.querySelector<HTMLElement>("[data-ann-focus]")?.focus({ preventScroll: true });
    }
  }, [annotations]);

  function handlePointerMove(e: React.PointerEvent) {
    if (!draft || !origin.current) return;
    const { x, y } = toPoints(e);
    setDraft(resizeDraft(draft, origin.current.x, origin.current.y, x, y));
  }

  function handlePointerUp(e: React.PointerEvent) {
    const pending = tap.current;
    if (pending && pending.pointerId === e.pointerId) {
      tap.current = null;
      if (e.type !== "pointerup") return;
      if (tool === "select") onSelect(null);
      else place(pending.x, pending.y);
      return;
    }
    try {
      layerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const finished = draft && finishDraft(draft);
    setDraft(null);
    origin.current = null;
    if (finished) onCreate(finished);
  }

  const editable = tool === "select";
  const cursor =
    tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="pdf-page-canvas rounded-sm" />

      {size && (
        <div
          ref={layerRef}
          className="annotation-layer outline-none"
          role="group"
          aria-label={`Page ${pageIndex + 1}`}
          // Somewhere for focus to land when the focused annotation goes away.
          tabIndex={-1}
          data-page-layer
          style={{ width: size.w, height: size.h, cursor, touchAction: pageTouchAction(tool) }}
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
              placing={tool !== "select"}
              tabStop={radioStops.has(field.id)}
              onChange={(v) => onFormChange(field.name, v)}
            />
          ))}

          <span id={hint} hidden>
            Arrow keys move it, Shift+arrow keys move it further, Alt+arrow keys resize it, Delete removes it.
          </span>
          <span id={textHint} hidden>
            Enter edits the text. Arrow keys move it, Alt+arrow keys resize it, Delete removes it.
          </span>

          {annotations.map((ann) => (
            <AnnotationView
              key={ann.id}
              ann={ann}
              scale={scale}
              page={{ width: size.w / scale, height: size.h / scale }}
              describedBy={ann.type === "text" || ann.type === "note" ? textHint : hint}
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
              page={{ width: size.w / scale, height: size.h / scale }}
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
  placing,
  tabStop,
  onChange,
}: {
  field: DetectedField;
  scale: number;
  value: string;
  /** A tool other than Select is armed: clicks go through to the page. */
  placing: boolean;
  /** Radio buttons: whether Tab stops on this one of its group. */
  tabStop: boolean;
  onChange: (value: string) => void;
}) {
  // A tiny field still gets a box big enough to see and tap, centred on it.
  const width = Math.max(8, field.width * scale);
  const height = Math.max(8, field.height * scale);
  const style: React.CSSProperties = {
    position: "absolute",
    left: field.x * scale - (width - field.width * scale) / 2,
    top: field.y * scale - (height - field.height * scale) / 2,
    width,
    height,
  };
  // Clicks fill the field, or, with a tool armed, place on the page over it
  // (a signature on a signature line).
  const hold: React.HTMLAttributes<HTMLDivElement> = placing
    ? { style: { ...style, pointerEvents: "none" } }
    : { style, onPointerDown: (e) => e.stopPropagation() };
  // The text size the PDF draws the field at.
  const fontSize = field.fontSize * scale;
  // On a turned page the control keeps the field's own shape and turns with
  // it, centred on the box the field takes up on screen.
  const turn = field.rotation;
  const sideways = turn === 90 || turn === 270;
  const inner: React.CSSProperties | undefined = turn
    ? {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: sideways ? height : width,
        height: sideways ? width : height,
        transform: `translate(-50%, -50%) rotate(${turn}deg)`,
      }
    : undefined;

  // The PDF's own description of the field, when it has one.
  const label = field.label ?? field.name;
  // A required field is marked in its corner.
  const mark = field.required && (
    <span aria-hidden className="pointer-events-none absolute -right-1 -top-2 z-10 text-xs font-bold leading-none text-red-600">
      *
    </span>
  );
  const shared =
    "block border border-emerald-500/70 bg-emerald-400/10 outline-none focus:ring-2 focus:ring-emerald-500";

  if (field.readOnly) {
    // The page leaves out the fields shown here as inputs, read-only ticks and
    // choices too; show their value. Read-only text is still on the page.
    const shown =
      field.kind === "checkbox" ? (value === "true" ? "✓" : "")
      : field.kind === "radio" ? (value && field.exportValue === value ? "●" : "")
      : field.kind === "dropdown" || field.kind === "listbox" ? value
      : "";
    const choice = field.kind === "dropdown" || field.kind === "listbox";
    return (
      <div style={style} className="pointer-events-none leading-none">
        <div
          style={{ ...inner, fontSize: choice ? fontSize : undefined }}
          className={`flex h-full w-full overflow-hidden whitespace-nowrap rounded-sm border border-dashed border-muted-foreground/40 text-slate-600 ${
            choice ? "px-1" : "justify-center text-sm"
          } ${field.kind === "listbox" ? "items-start pt-0.5" : "items-center"}`}
        >
          {shown}
        </div>
      </div>
    );
  }

  if (field.kind === "checkbox") {
    return (
      <div {...hold} className="leading-none">
        <button
          type="button"
          role="checkbox"
          aria-checked={value === "true"}
          aria-label={label}
          aria-required={field.required || undefined}
          onClick={() => onChange(value === "true" ? "" : "true")}
          style={inner}
          className={`flex h-full w-full items-center justify-center rounded-sm text-sm ${shared}`}
        >
          {value === "true" ? "✓" : ""}
        </button>
        {mark}
      </div>
    );
  }

  if (field.kind === "radio") {
    const on = value && field.exportValue === value;
    return (
      <div {...hold} className="leading-none">
        <button
          type="button"
          role="radio"
          aria-checked={!!on}
          aria-label={`${label}: ${field.exportValue ?? ""}`}
          aria-description={field.required ? "Required." : undefined}
          // One Tab stop per group; arrow keys choose among its buttons on
          // this page. They can sit far apart, so the group isn't one element.
          tabIndex={tabStop ? 0 : -1}
          data-radio-name={field.name}
          onKeyDown={(e) => {
            const step = radioStep(e.key);
            if (!step) return;
            e.preventDefault();
            const layer = e.currentTarget.closest("[data-page-layer]");
            const group = Array.from(
              layer?.querySelectorAll<HTMLButtonElement>(`[data-radio-name="${CSS.escape(field.name)}"]`) ?? []
            );
            const next = group[(group.indexOf(e.currentTarget) + step + group.length) % group.length];
            next?.focus();
            next?.click();
          }}
          onClick={() => onChange(field.exportValue ?? "")}
          style={inner}
          className={`flex h-full w-full items-center justify-center rounded-full text-sm ${shared}`}
        >
          {on ? "●" : ""}
        </button>
        {mark}
      </div>
    );
  }

  if (field.kind === "dropdown" || field.kind === "listbox") {
    // A list box shows as many options as its height holds, the empty one
    // included. Options are 1.15em tall, so whole rows fill it, none cut off.
    const ownHeight = sideways ? field.width : field.height;
    const rows = Math.max(2, Math.min(field.options.length + 1, Math.floor(ownHeight / ((field.fontSize || 10) * 1.15))));
    return (
      <div {...hold} className="leading-none">
        <select
          aria-label={label}
          aria-required={field.required || undefined}
          size={field.kind === "listbox" ? rows : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`h-full w-full rounded-sm px-1 [&>option]:h-[1.15em] [&>option]:min-h-0 [&>option]:py-0 ${shared}`}
          data-fit-text
          style={{ ...inner, fontSize }}
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {mark}
      </div>
    );
  }

  if (field.multiline) {
    return (
      <div {...hold} className="leading-none">
        <textarea
          aria-label={label}
          aria-required={field.required || undefined}
          value={value}
          maxLength={field.maxLength}
          onChange={(e) => onChange(e.target.value)}
          className={`h-full w-full resize-none rounded-sm px-1 leading-tight ${shared}`}
          data-fit-text
          style={{ ...inner, fontSize }}
        />
        {mark}
      </div>
    );
  }

  return (
    <div {...hold} className="leading-none">
      <input
        aria-label={label}
        aria-required={field.required || undefined}
        type={field.password ? "password" : undefined}
        autoComplete={field.password ? "off" : undefined}
        aria-description={field.password ? "Not saved in the PDF." : undefined}
        value={value}
        maxLength={field.maxLength}
        onChange={(e) => onChange(e.target.value)}
        className={`h-full w-full rounded-sm px-1 ${shared}`}
        data-fit-text
        style={{ ...inner, fontSize }}
      />
      {mark}
    </div>
  );
}
