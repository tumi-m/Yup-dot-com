"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Loader2, UploadCloud, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GULP_T, SPRING_POP } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

/**
 * Drag-over state for a drop target. Counts enter/leave pairs, so crossing a
 * child (icon, text, button) never flickers the state off and on again.
 */
export function useFileDrag(onDrop: (files: FileList) => void, disabled = false) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  /** Bumps on each drop, so the tile can play its "gulp". */
  const [drops, setDrops] = useState(0);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depth.current++;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) e.preventDefault();
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      // preventDefault marks the drop as handled for any parent listener.
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if (disabled || !e.dataTransfer.files.length) return;
      setDrops((n) => n + 1);
      onDrop(e.dataTransfer.files);
    },
  };
  return { over: over && !disabled, drops, handlers };
}

/**
 * The upload tile: bobs gently at rest (CSS), lifts and grows while a file is
 * held over it, and swallows the file with a small squash when it lands.
 */
export function DropTile({
  dragging,
  drops,
  busy = false,
  icon: Icon = UploadCloud,
  className,
}: {
  dragging: boolean;
  drops: number;
  busy?: boolean;
  icon?: LucideIcon;
  className?: string;
}) {
  const [gulping, setGulping] = useState(0);
  const gulp = drops > gulping;
  return (
    <motion.div
      animate={dragging ? { scale: 1.1, y: -4 } : gulp ? { scale: [1.1, 0.92, 1], y: 0 } : { scale: 1, y: 0 }}
      transition={gulp && !dragging ? GULP_T : SPRING_POP}
      onAnimationComplete={() => gulp && setGulping(drops)}
      className="relative mx-auto w-fit"
    >
      <div
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-2xl",
          !dragging && !busy && "motion-safe:animate-bob",
          className
        )}
      >
        {busy ? <Loader2 className="h-7 w-7 motion-safe:animate-spin" /> : <Icon className="h-7 w-7" />}
      </div>
    </motion.div>
  );
}

/**
 * The tool pages' drop zone: a large dashed card. The line reads `dragLabel`
 * and everything under it hides while a file is held over it. Buttons and
 * notes go in `children`; the file input stays with the caller.
 */
export function ToolDropzone({
  label,
  dragLabel = "Release to add",
  onFiles,
  busy = false,
  disabled = false,
  icon,
  tileClassName = "bg-primary/10 text-primary",
  className,
  children,
  ...rest
}: {
  label: string;
  dragLabel?: string;
  onFiles: (files: FileList) => void;
  busy?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  tileClassName?: string;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop" | "children">) {
  const { over, drops, handlers } = useFileDrag(onFiles, disabled || busy);
  return (
    <div
      {...rest}
      {...handlers}
      className={cn(
        "group relative overflow-hidden rounded-3xl border-2 border-dashed bg-card p-10 text-center transition-[border-color,background-color] duration-150",
        over ? "border-primary bg-primary/5" : "border-border hover:border-primary/60",
        className
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.10),transparent_60%)] opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-hover:duration-150"
      />
      <DropTile dragging={over} drops={drops} busy={busy} icon={icon} className={tileClassName} />
      <p className="relative mt-4 text-lg font-semibold">{over ? dragLabel : label}</p>
      <div className={cn("relative", over && "invisible")}>{children}</div>
    </div>
  );
}

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
  const { over, drops, handlers } = useFileDrag(onFiles, disabled);
  const dragging = (over || draggingFromParent) && !disabled;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed bg-card px-6 py-12 text-center transition-[border-color,background-color] duration-150",
        dragging ? "border-primary bg-primary/5" : "border-primary/30 hover:border-primary/60",
        className
      )}
      {...handlers}
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
      <DropTile
        dragging={dragging}
        drops={drops}
        busy={busy}
        className="bg-primary text-primary-foreground shadow-lg shadow-primary/30 [&_svg]:h-6 [&_svg]:w-6"
      />
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
