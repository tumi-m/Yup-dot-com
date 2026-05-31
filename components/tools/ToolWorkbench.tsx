"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import JSZip from "jszip";
import {
  UploadCloud,
  File as FileIcon,
  X,
  Loader2,
  Download,
  CheckCircle2,
  Sparkles,
  GripVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadBlob } from "@/lib/download";
import { formatBytes, cn } from "@/lib/utils";
import type { ToolFile } from "@/lib/pdf/toolkit";
import { PROCESSORS, type ToolField } from "./processors";

type Status = "idle" | "working" | "done" | "error";

export function ToolWorkbench({ slug }: { slug: string }) {
  const proc = PROCESSORS[slug];
  const inputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(proc.fields.map((f) => [f.key, f.default]))
  );
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ToolFile[]>([]);
  const dragIndex = useRef<number | null>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => (proc.multiple ? [...prev, ...incoming] : incoming.slice(0, 1)));
    setStatus("idle");
    setResults([]);
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function reorder(from: number, to: number) {
    setFiles((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function setOption(key: string, value: string) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function visibleFields(): ToolField[] {
    return proc.fields.filter(
      (f) => !f.showIf || options[f.showIf.key] === f.showIf.value
    );
  }

  async function run() {
    if (files.length < proc.minFiles) {
      setError(`Please add at least ${proc.minFiles} file${proc.minFiles > 1 ? "s" : ""}.`);
      setStatus("error");
      return;
    }
    setStatus("working");
    setError(null);
    try {
      const out = await proc.run(files, options);
      setResults(Array.isArray(out) ? out : [out]);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  async function downloadAll() {
    if (results.length === 1) {
      downloadBlob(results[0].blob, results[0].filename);
      return;
    }
    if (proc.zipName) {
      const zip = new JSZip();
      for (const r of results) zip.file(r.filename, r.blob);
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, proc.zipName);
    } else {
      results.forEach((r) => downloadBlob(r.blob, r.filename));
    }
  }

  function reset() {
    setFiles([]);
    setResults([]);
    setStatus("idle");
    setError(null);
  }

  // ---- success state ----
  if (status === "done") {
    return (
      <div className="rounded-2xl border border-border bg-card p-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <h2 className="mt-4 text-xl font-semibold">Spell complete ✨</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {results.length === 1
            ? "Your file is ready to download."
            : `${results.length} files are ready.`}
        </p>
        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button onClick={downloadAll} size="lg">
            <Download />
            {results.length > 1 && proc.zipName ? "Download zip" : "Download"}
          </Button>
          <Button onClick={reset} variant="outline" size="lg">
            Start over
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Dropzone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
        className="rounded-2xl border-2 border-dashed border-border bg-card p-8 text-center transition-colors hover:border-primary"
      >
        <input
          ref={inputRef}
          type="file"
          accept={proc.accept}
          multiple={proc.multiple}
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UploadCloud className="h-6 w-6" />
        </div>
        <p className="mt-3 font-medium">
          Drop {proc.multiple ? "files" : "a file"} here or
        </p>
        <Button className="mt-3" onClick={() => inputRef.current?.click()}>
          Choose {proc.multiple ? "files" : "file"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Files are processed in your browser — nothing is uploaded.
        </p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              draggable={proc.multiple}
              onDragStart={() => (dragIndex.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex.current !== null && dragIndex.current !== i) {
                  reorder(dragIndex.current, i);
                }
                dragIndex.current = null;
              }}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              {proc.multiple && (
                <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
              )}
              <FileIcon className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
              </div>
              <button
                onClick={() => removeFile(i)}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Remove file"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Options */}
      {files.length > 0 && visibleFields().length > 0 && (
        <div className="grid gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-2">
          {visibleFields().map((field) => (
            <div key={field.key}>
              <label className="mb-1.5 block text-sm font-medium">{field.label}</label>
              {field.type === "select" && (
                <select
                  value={options[field.key]}
                  onChange={(e) => setOption(field.key, e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  {field.options!.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {field.type === "text" && (
                <Input
                  value={options[field.key]}
                  onChange={(e) => setOption(field.key, e.target.value)}
                />
              )}
              {field.type === "color" && (
                <input
                  type="color"
                  value={options[field.key]}
                  onChange={(e) => setOption(field.key, e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-lg border border-input bg-background px-1"
                />
              )}
              {field.type === "range" && (
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={options[field.key]}
                    onChange={(e) => setOption(field.key, e.target.value)}
                    className="flex-1 accent-[hsl(var(--primary))]"
                  />
                  <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                    {Math.round(Number(options[field.key]) * 100)}%
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Action */}
      {files.length > 0 && (
        <div className="flex flex-col items-center gap-3">
          <Button size="lg" onClick={run} disabled={status === "working"} className="min-w-48">
            {status === "working" ? (
              <>
                <Loader2 className="animate-spin" /> Casting…
              </>
            ) : (
              <>
                <Sparkles /> Cast spell
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            Need cloud storage and history?{" "}
            <Link href="/signup" className="text-primary hover:underline">
              Create a free account
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
