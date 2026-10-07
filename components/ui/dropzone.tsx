"use client";

import { useRef, useState } from "react";
import { Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one drop zone look: dashed primary border, an upload tile that bobs at
 * rest and pops while a file is over it, one line of text and one button.
 * While dragging, the button hides and the line reads "Release".
 */
export function Dropzone({
  label,
  button,
  accept,
  multiple = false,
  onFiles,
  dragging: draggingFromParent = false,
  busy = false,
  disabled = false,
  className,
}: {
  label: string;
  button: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList | null) => void;
  /** For a parent that catches drops on a larger area. */
  dragging?: boolean;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const dragging = (over || draggingFromParent) && !disabled;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed bg-card px-6 py-12 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-primary/30 hover:border-primary/60",
        className
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        // preventDefault marks the drop as handled for any parent listener.
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled) onFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className={cn("transition-transform duration-300 ease-out", dragging && "scale-[1.12] motion-reduce:scale-100")}>
        <div
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30",
            !dragging && !busy && "motion-safe:animate-bob"
          )}
        >
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <UploadCloud className="h-6 w-6" />}
        </div>
      </div>
      <p className="text-lg font-semibold">{dragging ? "Release" : label}</p>
      <Button
        type="button"
        size="lg"
        className={cn("h-12 px-6 shadow-lg shadow-primary/25", dragging && "invisible")}
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        {button}
      </Button>
    </div>
  );
}
