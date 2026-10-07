"use client";

import { useRef, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A modal canvas where the user draws a signature, returned as a PNG data URL. */
export function SignaturePad({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0f172a";
    hasInk.current = false;
    setEmpty(true);
    setTyped("");
  }, [open]);

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

  function save() {
    if (!hasInk.current) return;
    onSave(canvasRef.current!.toDataURL("image/png"));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Draw your signature</DialogTitle>
          <DialogDescription>
            Sign in the box below, then place it on the page.
          </DialogDescription>
        </DialogHeader>
        <canvas
          ref={canvasRef}
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
          <Button onClick={save} disabled={empty}>
            Use signature
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
