"use client";

import { useEffect, useRef, useState } from "react";
import type { LoadedPdf } from "@/lib/pdf/render";
import type { Annotation, AnnotationType } from "@/lib/types";
import { uuid } from "@/lib/utils";
import { AnnotationView } from "./AnnotationView";

export interface ToolSettings {
  color: string;
  fontSize: number;
  strokeWidth: number;
  highlightOpacity: number;
}

export function PageView({
  loaded,
  pageIndex,
  scale,
  tool,
  settings,
  signatureDataUrl,
  annotations,
  selectedId,
  onSelect,
  onCreate,
  onChange,
  onDelete,
  onSignaturePlaced,
}: {
  loaded: LoadedPdf;
  pageIndex: number; // 0-indexed
  scale: number;
  tool: AnnotationType | "select";
  settings: ToolSettings;
  signatureDataUrl: string | null;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (ann: Annotation) => void;
  onChange: (ann: Annotation) => void;
  onDelete: (id: string) => void;
  onSignaturePlaced: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // in-progress drag (highlight / draw)
  const draft = useRef<Annotation | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vp = await loaded.getPageViewport(pageIndex + 1, scale);
      if (cancelled) return;
      setSize({ w: vp.width, h: vp.height });
      if (canvasRef.current) {
        await loaded.renderPage(pageIndex + 1, canvasRef.current, scale);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, pageIndex, scale]);

  function toPoints(e: React.PointerEvent) {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function onLayerPointerDown(e: React.PointerEvent) {
    if (tool === "select") {
      onSelect(null);
      return;
    }
    const { x, y } = toPoints(e);

    if (tool === "text") {
      onCreate({
        id: uuid(),
        type: "text",
        page: pageIndex,
        x,
        y,
        width: 160,
        height: settings.fontSize * 1.6,
        text: "Type here",
        fontSize: settings.fontSize,
        color: settings.color,
      });
      return;
    }

    if (tool === "signature") {
      if (!signatureDataUrl) return;
      onCreate({
        id: uuid(),
        type: "signature",
        page: pageIndex,
        x,
        y,
        width: 160,
        height: 70,
        dataUrl: signatureDataUrl,
      });
      onSignaturePlaced();
      return;
    }

    // highlight + draw start a drag
    layerRef.current!.setPointerCapture(e.pointerId);
    if (tool === "highlight") {
      draft.current = {
        id: uuid(),
        type: "highlight",
        page: pageIndex,
        x,
        y,
        width: 0,
        height: 0,
        color: settings.color,
        opacity: settings.highlightOpacity,
      };
    } else if (tool === "draw") {
      draft.current = {
        id: uuid(),
        type: "draw",
        page: pageIndex,
        x,
        y,
        width: 1,
        height: 1,
        points: [{ x: 0, y: 0 }],
        color: settings.color,
        strokeWidth: settings.strokeWidth,
      };
    }
    force((n) => n + 1);
  }

  function onLayerPointerMove(e: React.PointerEvent) {
    if (!draft.current) return;
    const { x, y } = toPoints(e);
    const d = draft.current;

    if (d.type === "highlight") {
      draft.current = {
        ...d,
        x: Math.min(d.x, x),
        y: Math.min(d.y, y),
        width: Math.abs(x - d.x),
        height: Math.abs(y - d.y),
      };
    } else if (d.type === "draw") {
      const relX = x - d.x;
      const relY = y - d.y;
      const points = [...d.points, { x: relX, y: relY }];
      const maxX = Math.max(...points.map((p) => p.x), 1);
      const maxY = Math.max(...points.map((p) => p.y), 1);
      draft.current = { ...d, points, width: maxX, height: maxY };
    }
    force((n) => n + 1);
  }

  function onLayerPointerUp(e: React.PointerEvent) {
    try {
      layerRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    // Discard accidental zero-size shapes.
    if (d.type === "highlight" && (d.width < 3 || d.height < 3)) {
      force((n) => n + 1);
      return;
    }
    if (d.type === "draw" && d.points.length < 2) {
      force((n) => n + 1);
      return;
    }
    onCreate(d);
    force((n) => n + 1);
  }

  const editable = tool === "select";
  const cursor =
    tool === "select"
      ? "default"
      : tool === "text"
        ? "text"
        : "crosshair";

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="pdf-page-canvas rounded-sm" />
      {size && (
        <div
          ref={layerRef}
          className="annotation-layer"
          style={{ width: size.w, height: size.h, cursor, touchAction: "none" }}
          onPointerDown={onLayerPointerDown}
          onPointerMove={onLayerPointerMove}
          onPointerUp={onLayerPointerUp}
        >
          {annotations.map((ann) => (
            <AnnotationView
              key={ann.id}
              ann={ann}
              scale={scale}
              editable={editable}
              selected={selectedId === ann.id}
              onSelect={() => onSelect(ann.id)}
              onChange={onChange}
              onDelete={() => onDelete(ann.id)}
            />
          ))}
          {draft.current && (
            <AnnotationView
              ann={draft.current}
              scale={scale}
              editable={false}
              selected={false}
              onSelect={() => {}}
              onChange={() => {}}
              onDelete={() => {}}
            />
          )}
        </div>
      )}
    </div>
  );
}
