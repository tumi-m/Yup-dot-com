"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import type { Annotation, TextEditAnnotation } from "@/lib/editor/types";
import { NEW_TEXT } from "@/lib/editor/factory";
import { annotationTouchAction } from "@/lib/editor/canvas";
import { annotationName, nudgeAnnotation } from "@/lib/editor/keyboard";
import { runTransform } from "@/lib/editor/text-edit";
import { cssBaseline, cssFamily } from "@/lib/pdf/edit-text/fonts";

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
  page,
  describedBy,
  selected,
  interactive,
  onSelect,
  onChange,
  onCommitStart,
  onCommitEnd,
  onDelete,
  onCommit,
  onLeave,
  tabStop = true,
}: {
  ann: Annotation;
  scale: number;
  /** The page's size in points, which keyboard moves keep to. */
  page: { width: number; height: number };
  /** The id of the keyboard hint. */
  describedBy?: string;
  selected: boolean;
  /** False while a creation drag is previewing this annotation. */
  interactive: boolean;
  onSelect: () => void;
  onChange: (next: Annotation) => void;
  onCommitStart: () => void;
  onCommitEnd: () => void;
  onDelete: () => void;
  /** Changed text: each change is an undo step, a burst of typing one step (`continuous`). */
  onCommit?: (next: Annotation, continuous?: boolean) => void;
  /** Changed text: Enter (done) or Escape (cancel, with the words put back) in its words. Without it, focus comes back here. */
  onLeave?: (how: "done" | "cancel", reverted?: Annotation) => void;
  /** Whether Tab stops on it (Edit text's runs stand in for changed text). */
  tabStop?: boolean;
}) {
  const gesture = useRef<{
    kind: "move" | Handle;
    startX: number;
    startY: number;
    origin: Annotation;
  } | null>(null);
  /** A finger on an unselected annotation: it's selected when the finger lifts. */
  const tapping = useRef<number | null>(null);

  const isLine =
    ann.type === "shape" && (ann.shape === "line" || ann.shape === "arrow");
  const hasText = ann.type === "text" || ann.type === "note" || ann.type === "edit";
  /** Changed text stays where the old words were: it isn't moved or resized. */
  const fixed = ann.type === "edit";
  const self = useRef<HTMLDivElement>(null);

  /** The keyboard version of the pointer gestures: move, resize, edit. */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!interactive || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const box = e.currentTarget.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input");
      if (!box) return;
      box.focus({ preventScroll: true });
      if (box.value === NEW_TEXT) box.select();
      else box.setSelectionRange(box.value.length, box.value.length);
      return;
    }
    if (fixed) return;
    const next = nudgeAnnotation(ann, e, page);
    if (!next) return;
    e.preventDefault();
    if (!selected) onSelect();
    // One undo step per key press.
    onCommitStart();
    onChange(next);
    onCommitEnd();
  }

  function begin(e: React.PointerEvent, kind: "move" | Handle) {
    if (!interactive) return;
    if (fixed) {
      // Selects it; the press goes on to the words, to type there.
      e.stopPropagation();
      if (!selected) onSelect();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    // A finger selects on lift and drags once selected, so a swipe that
    // starts on an annotation still scrolls the page (and ends in pointercancel).
    if (e.pointerType !== "mouse" && !selected) {
      tapping.current = e.pointerId;
      return;
    }
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
    if (tapping.current === e.pointerId) {
      tapping.current = null;
      if (e.type === "pointerup") onSelect();
      return;
    }
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
    cursor: fixed ? "text" : interactive ? "move" : "default",
    touchAction: fixed ? undefined : annotationTouchAction(interactive, selected),
  };

  return (
    <div
      data-ann-id={ann.id}
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

      {/* Reachable with Tab; focusing it selects it, so the Properties panel
          and the Delete key work on it. The selection chrome sits beside it,
          not inside, so nothing interactive is nested in it. */}
      <div
        ref={self}
        data-ann-focus={interactive ? "" : undefined}
        tabIndex={interactive ? (tabStop ? 0 : -1) : undefined}
        role={interactive ? (hasText ? "group" : "button") : undefined}
        aria-label={interactive ? annotationName(ann) : undefined}
        aria-describedby={interactive ? describedBy : undefined}
        onFocus={(e) => interactive && !selected && e.target === e.currentTarget && onSelect()}
        onKeyDown={onKeyDown}
        className="h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Content
          ann={ann}
          scale={scale}
          selected={selected}
          interactive={interactive}
          onChange={onChange}
          onCommit={onCommit ?? onChange}
          onDone={(how, reverted) => (onLeave ? onLeave(how, reverted) : self.current?.focus({ preventScroll: true }))}
        />
      </div>

      {selected && interactive && (
        <>
          {/* Changed text is removed from the panel or with Delete: a button over the line above would hide it. */}
          {!fixed && (
          <button
            type="button"
            // The Delete key and the Properties panel do this from the keyboard.
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            // Clear of the corner handles: above the middle, or below when the
            // box is at the top of the page.
            className={`absolute left-1/2 z-30 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow pointer-coarse:h-8 pointer-coarse:w-8 ${
              ann.y * scale < 44 ? "-bottom-10 pointer-coarse:-bottom-11" : "-top-10 pointer-coarse:-top-11"
            }`}
            aria-label="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
          )}

          {(fixed ? [] : isLine ? (["p1", "p2"] as Handle[]) : BOX_HANDLES).map((h) => (
            <span
              key={h}
              onPointerDown={(e) => begin(e, h)}
              onPointerMove={move}
              onPointerUp={end}
              style={{ cursor: CURSORS[h], ...handlePosition(h, ann) }}
              // A finger gets a bigger target than the dot shows.
              className="absolute z-30 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary shadow pointer-coarse:before:absolute pointer-coarse:before:-inset-[7px] pointer-coarse:before:content-['']"
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
  onCommit,
  onDone,
}: {
  ann: Annotation;
  scale: number;
  selected: boolean;
  interactive: boolean;
  onChange: (next: Annotation) => void;
  onCommit: (next: Annotation, continuous?: boolean) => void;
  /** Escape in a text: back to the annotation itself. */
  onDone: (how: "done" | "cancel", reverted?: Annotation) => void;
}) {
  /** Escape leaves the text for the annotation, which stays selected. */
  const leave = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || !interactive) return;
    e.stopPropagation();
    onDone("done");
  };
  switch (ann.type) {
    case "text":
      return <TextBody ann={ann} scale={scale} selected={selected} interactive={interactive} onChange={onChange} onKeyDown={leave} />;

    case "edit":
      return <EditBody ann={ann} scale={scale} interactive={interactive} onCommit={onCommit} onDone={onDone} />;

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
            // Points on the page, like the saved file; the box itself stretches.
            strokeWidth={ann.strokeWidth * scale}
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
            onKeyDown={leave}
            readOnly={!interactive}
            // Reached through the note itself (Enter), so it isn't a second Tab stop.
            tabIndex={-1}
            aria-label="Comment"
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
        // Drawn in screen pixels, one to one with the box, so a level line
        // (a box 1px tall) doesn't squash the arrow head.
        const w = Math.max(1, ann.width * scale);
        const h = Math.max(1, ann.height * scale);
        const x1 = ((ann.x1 ?? ann.x) - ann.x) * scale;
        const y1 = ((ann.y1 ?? ann.y) - ann.y) * scale;
        const x2 = ((ann.x2 ?? ann.x + ann.width) - ann.x) * scale;
        const y2 = ((ann.y2 ?? ann.y + ann.height) - ann.y) * scale;
        const id = `arrow-${ann.id}`;
        // The saved head, in stroke widths: two strokes `head` points long,
        // 0.18 of a turn off the line, plus the strokes' own thickness.
        const head = Math.max(8, ann.strokeWidth * 4) / Math.max(0.1, ann.strokeWidth);
        return (
          <svg className="pointer-events-none h-full w-full overflow-visible" viewBox={`0 0 ${w} ${h}`}>
            {ann.shape === "arrow" && (
              <defs>
                <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={head * 0.84 + 0.5} markerHeight={head * 1.07 + 1} preserveAspectRatio="none" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={ann.stroke} />
                </marker>
              </defs>
            )}
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={ann.stroke}
              // Points on the page, like the saved file.
              strokeWidth={ann.strokeWidth * scale}
              strokeLinecap="round"
              opacity={ann.opacity}
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
        // Its value is what the button stands for, not whether it's chosen.
        return <div className={`${base} rounded-full`} />;
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

/**
 * A text box. A newly placed one takes focus with its placeholder selected,
 * so typing replaces it instead of firing tool shortcuts.
 */
function TextBody({
  ann,
  scale,
  selected,
  interactive,
  onChange,
  onKeyDown,
}: {
  ann: Extract<Annotation, { type: "text" }>;
  scale: number;
  selected: boolean;
  interactive: boolean;
  onChange: (next: Annotation) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Type at 16px or more and scale down to the page, so phones don't zoom in on focus.
  const px = ann.fontSize * scale;
  const k = px < 16 ? 16 / px : 1;
  useEffect(() => {
    if (selected && interactive && ann.text === NEW_TEXT) {
      ref.current?.focus({ preventScroll: true });
      ref.current?.select();
    }
    // Only when the box first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A bigger or bolder font (Properties) grows the box to show every line,
  // as the saved file prints them. A live change, so it undoes with the font.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const needed = box.scrollHeight / k / scale;
    if (needed > ann.height + 1) onChange({ ...ann, height: Math.ceil(needed) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ann.fontSize, ann.bold, scale]);
  return (
    <textarea
      ref={ref}
      value={ann.text}
      // The click that placed the box ends on it; keep the placeholder selected.
      onMouseUp={(e) => {
        if (ann.text === NEW_TEXT && interactive) {
          e.preventDefault();
          e.currentTarget.select();
        }
      }}
      onChange={(e) => {
        // Grow the box as lines wrap, so earlier lines don't scroll out of view.
        const needed = Math.ceil(e.target.scrollHeight / k / scale);
        onChange({ ...ann, text: e.target.value, height: Math.max(ann.height, needed) });
      }}
      onPointerDown={(e) => selected && e.stopPropagation()}
      onKeyDown={onKeyDown}
      readOnly={!interactive}
      // Reached through the text box itself (Enter), so it isn't a second Tab stop.
      tabIndex={-1}
      aria-label="Text"
      spellCheck={false}
      data-fit-text
      className="block resize-none overflow-hidden border-none bg-transparent p-0 outline-none"
      style={{
        // The saved file's line spacing, so long text ends where it will print.
        lineHeight: 1.2,
        width: `${100 * k}%`,
        height: `${100 * k}%`,
        transform: k === 1 ? undefined : `scale(${1 / k})`,
        transformOrigin: "0 0",
        fontSize: px * k,
        color: ann.color,
        fontWeight: ann.bold ? 700 : 400,
        fontFamily: "Helvetica, Arial, sans-serif",
      }}
    />
  );
}

/**
 * Changed text: a box in the page's colour over the old words, and the new
 * words in a box to type in, both laid along the old words' own line (turned
 * with it on a turned page). Each change is saved to the history as typed,
 * so Save sees it; Enter is done, Escape puts back the words it had when the
 * box was entered.
 */
function EditBody({
  ann,
  scale,
  interactive,
  onCommit,
  onDone,
}: {
  ann: TextEditAnnotation;
  scale: number;
  interactive: boolean;
  onCommit: (next: Annotation, continuous?: boolean) => void;
  onDone: (how: "done" | "cancel", reverted?: Annotation) => void;
}) {
  const run = ann.run;
  const start = useRef(ann.text);
  // Typed at 16px or more and scaled down to the page, so phones don't zoom in on focus.
  const k = Math.max(1, 16 / Math.max(1, ann.fontSize));
  const lineHeight = 1.25;
  const font: React.CSSProperties = {
    fontFamily: cssFamily(run.font.family),
    fontSize: ann.fontSize * k,
    fontWeight: ann.bold ? 700 : 400,
    fontStyle: ann.italic ? "italic" : "normal",
    lineHeight,
    letterSpacing: 0,
  };
  const padX = run.size * 0.04;
  const padY = run.size * 0.06;
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 h-0 w-0"
      style={{ transform: runTransform(run, scale, k, { x: ann.x, y: ann.y }), transformOrigin: "0 0" }}
    >
      <div
        aria-hidden
        className="absolute"
        style={{
          left: (run.x0 - padX) * k,
          top: -(run.ascent * run.size + padY) * k,
          width: (run.x1 - run.x0 + 2 * padX) * k,
          height: ((run.ascent - run.descent) * run.size + 2 * padY) * k,
          background: ann.background,
        }}
      />
      <div className="absolute left-0 inline-grid" style={{ top: -cssBaseline(run.font.family, lineHeight) * ann.fontSize * k }}>
        {/* Sizes the box to the words, so it grows as they are typed. */}
        <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre pr-0.5" style={font}>
          {ann.text || "Removed"}
        </span>
        <input
          value={ann.text}
          onChange={(e) => onCommit({ ...ann, text: e.target.value.replace(/[\r\n]+/g, " ") }, true)}
          onFocus={() => (start.current = ann.text)}
          onKeyDown={(e) => {
            if (!interactive) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onDone("done");
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onDone("cancel", { ...ann, text: start.current });
            }
          }}
          readOnly={!interactive}
          // Reached through the text itself (Enter), so it isn't a second Tab stop.
          tabIndex={-1}
          aria-label={`New text for: ${run.text.length > 60 ? `${run.text.slice(0, 60)}…` : run.text}`}
          placeholder="Removed"
          spellCheck={false}
          autoComplete="off"
          className="pointer-events-auto col-start-1 row-start-1 w-full min-w-[2em] border-none bg-transparent p-0 outline-none placeholder:italic placeholder:text-slate-400"
          style={{ ...font, color: ann.color }}
        />
      </div>
    </div>
  );
}
