"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inkBounds } from "@/lib/editor/signature";

/** The pen: set before each stroke, since typing a name shares the context. */
function pen(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#0f172a";
}

/** A modal canvas where the user draws a signature, returned as a PNG data URL. */
export function SignaturePad({
  open,
  onOpenChange,
  onSave,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `keyboard`: "Use signature" was pressed with Enter or Space. */
  onSave: (dataUrl: string, keyboard: boolean) => void;
  /** Once the dialog has closed; prevent the default to put focus elsewhere. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [typed, setTyped] = useState("");

  /** Keyboard alternative to drawing: the typed name in a handwriting face. */
  function type(name: string) {
    setTyped(name);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const text = name.trim();
    hasInk.current = text.length > 0;
    setEmpty(!text);
    if (!text) return;
    let size = 64;
    const face = (px: number) => `italic ${px}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
    ctx.font = face(size);
    while (size > 16 && ctx.measureText(text).width > canvas.width - 40) ctx.font = face((size -= 4));
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  // Each time it opens, start empty. The canvas itself is new each time
  // (the dialog mounts its content after this runs), so it is set up below.
  useEffect(() => {
    if (!open) return;
    hasInk.current = false;
    setEmpty(true);
    setTyped("");
  }, [open]);

  const setCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pen(ctx);
  }, []);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    // The canvas is drawn at a fixed resolution but shown at the dialog's
    // width (narrower on phones): map screen pixels to canvas pixels.
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (typed) setTyped("");
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current!.getContext("2d")!;
    pen(ctx);
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    hasInk.current = true;
    if (empty) setEmpty(false);
  }

  function end() {
    drawing.current = false;
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    setEmpty(true);
    setTyped("");
  }

  function save(keyboard: boolean) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!hasInk.current || !canvas || !ctx) return;
    // Just the ink, so a small signature fills the box it is placed in.
    const box = inkBounds(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, 6);
    if (!box) {
      hasInk.current = false;
      setEmpty(true);
      return;
    }
    const out = document.createElement("canvas");
    out.width = box.width;
    out.height = box.height;
    out.getContext("2d")!.drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    onSave(out.toDataURL("image/png"), keyboard);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        // Focus the dialog, not the name field: on a phone that would open
        // the keyboard over the pad. Typing a name is a tap away.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        className="focus:outline-none"
      >
        <DialogHeader>
          <DialogTitle>Draw your signature</DialogTitle>
          <DialogDescription>
            Sign in the box below, then place it on the page.
          </DialogDescription>
        </DialogHeader>
        <canvas
          ref={setCanvas}
          width={460}
          height={180}
          aria-label="Signature"
          className="w-full touch-none rounded-lg border border-dashed border-border bg-secondary/40"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        <Input
          value={typed}
          onChange={(e) => type(e.target.value)}
          placeholder="Or type your name"
          aria-label="Type your name to sign"
          autoComplete="name"
        />
        <div className="flex justify-between">
          <Button variant="ghost" onClick={clear}>
            Clear
          </Button>
          <Button onClick={(e) => save(e.detail === 0)} disabled={empty}>
            Use signature
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
