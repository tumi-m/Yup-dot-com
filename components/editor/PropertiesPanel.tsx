"use client";

import { X } from "lucide-react";
import type { Annotation } from "@/lib/editor/types";
import { annotationLabel } from "@/lib/editor/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const NOTE_COLORS = ["#fde047", "#86efac", "#93c5fd", "#fca5a5", "#f0abfc"];

/** Contextual editor for the selected annotation. */
export function PropertiesPanel({
  annotation,
  pageCount,
  onChange,
  onDelete,
  onClose,
}: {
  annotation: Annotation;
  pageCount: number;
  onChange: (next: Annotation) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-l border-border bg-background p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{annotationLabel(annotation)}</h2>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close properties"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 text-sm">
        {annotation.type === "text" && (
          <>
            <Field label="Font size">
              <select
                value={annotation.fontSize}
                onChange={(e) =>
                  onChange({ ...annotation, fontSize: Number(e.target.value) })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-2"
              >
                {[9, 10, 12, 14, 16, 20, 24, 32, 48].map((s) => (
                  <option key={s} value={s}>
                    {s}pt
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Colour">
              <input
                type="color"
                value={annotation.color}
                onChange={(e) => onChange({ ...annotation, color: e.target.value })}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-1"
              />
            </Field>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={annotation.bold}
                onChange={(e) => onChange({ ...annotation, bold: e.target.checked })}
              />
              Bold
            </label>
          </>
        )}

        {annotation.type === "note" && (
          <Field label="Colour">
            <div className="flex gap-1.5">
              {NOTE_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => onChange({ ...annotation, color: c })}
                  className={`h-7 w-7 rounded-full border ${
                    annotation.color === c ? "ring-2 ring-ring ring-offset-1" : ""
                  }`}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                />
              ))}
            </div>
          </Field>
        )}

        {annotation.type === "shape" && annotation.shape !== "whiteout" && (
          <>
            <Field label="Stroke">
              <input
                type="color"
                value={annotation.stroke}
                onChange={(e) => onChange({ ...annotation, stroke: e.target.value })}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-1"
              />
            </Field>
            <Field label="Thickness">
              <select
                value={annotation.strokeWidth}
                onChange={(e) =>
                  onChange({ ...annotation, strokeWidth: Number(e.target.value) })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-2"
              >
                {[1, 2, 3, 5, 8].map((s) => (
                  <option key={s} value={s}>
                    {s}px
                  </option>
                ))}
              </select>
            </Field>
            {(annotation.shape === "rect" || annotation.shape === "ellipse") && (
              <Field label="Fill">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={annotation.fill !== null}
                    onChange={(e) =>
                      onChange({
                        ...annotation,
                        fill: e.target.checked ? annotation.stroke : null,
                      })
                    }
                  />
                  {annotation.fill !== null && (
                    <input
                      type="color"
                      value={annotation.fill}
                      onChange={(e) => onChange({ ...annotation, fill: e.target.value })}
                      className="h-9 flex-1 cursor-pointer rounded-md border border-input bg-background px-1"
                    />
                  )}
                </div>
              </Field>
            )}
            <Field label={`Opacity — ${Math.round(annotation.opacity * 100)}%`}>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={annotation.opacity}
                onChange={(e) =>
                  onChange({ ...annotation, opacity: Number(e.target.value) })
                }
                className="w-full accent-[hsl(var(--primary))]"
              />
            </Field>
          </>
        )}

        {annotation.type === "markup" && (
          <>
            <Field label="Colour">
              <input
                type="color"
                value={annotation.color}
                onChange={(e) => onChange({ ...annotation, color: e.target.value })}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-1"
              />
            </Field>
            <Field label={`Opacity — ${Math.round(annotation.opacity * 100)}%`}>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={annotation.opacity}
                onChange={(e) =>
                  onChange({ ...annotation, opacity: Number(e.target.value) })
                }
                className="w-full accent-[hsl(var(--primary))]"
              />
            </Field>
          </>
        )}

        {annotation.type === "link" && (
          <>
            <Field label="Link type">
              <select
                value={annotation.targetPage === null ? "url" : "page"}
                onChange={(e) =>
                  onChange({
                    ...annotation,
                    targetPage: e.target.value === "url" ? null : 0,
                  })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-2"
              >
                <option value="url">Web address</option>
                <option value="page">Page in this document</option>
              </select>
            </Field>
            {annotation.targetPage === null ? (
              <Field label="URL">
                <Input
                  value={annotation.url}
                  placeholder="https://example.com"
                  onChange={(e) => onChange({ ...annotation, url: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Target page">
                <select
                  value={annotation.targetPage}
                  onChange={(e) =>
                    onChange({ ...annotation, targetPage: Number(e.target.value) })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-2"
                >
                  {Array.from({ length: pageCount }, (_, i) => (
                    <option key={i} value={i}>
                      Page {i + 1}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}

        {annotation.type === "field" && (
          <>
            <Field label="Field name">
              <Input
                value={annotation.name}
                onChange={(e) => onChange({ ...annotation, name: e.target.value })}
              />
            </Field>
            {annotation.field === "text" && (
              <Field label="Default value">
                <Input
                  value={annotation.value}
                  onChange={(e) => onChange({ ...annotation, value: e.target.value })}
                />
              </Field>
            )}
            {annotation.field === "checkbox" && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={annotation.value === "true"}
                  onChange={(e) =>
                    onChange({ ...annotation, value: e.target.checked ? "true" : "" })
                  }
                />
                Checked by default
              </label>
            )}
            {(annotation.field === "dropdown" || annotation.field === "radio") && (
              <Field label="Options (one per line)">
                <textarea
                  value={annotation.options.join("\n")}
                  onChange={(e) =>
                    onChange({
                      ...annotation,
                      options: e.target.value.split("\n").filter(Boolean),
                    })
                  }
                  rows={4}
                  className="w-full rounded-md border border-input bg-background p-2 text-sm"
                />
              </Field>
            )}
            <p className="rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">
              Stays fillable in the exported PDF.
            </p>
          </>
        )}

        <div className="border-t border-border pt-4">
          <Button variant="destructive" size="sm" className="w-full" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
