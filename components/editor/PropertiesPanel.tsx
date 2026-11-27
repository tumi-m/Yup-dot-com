"use client";

import { cloneElement, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import type { Annotation, TextEditAnnotation } from "@/lib/editor/types";
import { annotationLabel } from "@/lib/editor/types";
import { COVERED } from "@/lib/editor/text-edit";
import { fontLabel, guessFont, undrawable } from "@/lib/pdf/edit-text/fonts";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const NOTE_COLORS = [
  { value: "#fde047", name: "Yellow" },
  { value: "#86efac", name: "Green" },
  { value: "#93c5fd", name: "Blue" },
  { value: "#fca5a5", name: "Red" },
  { value: "#f0abfc", name: "Pink" },
];

/** Contextual editor for the selected annotation. */
export function PropertiesPanel({
  annotation,
  pageCount,
  onChange,
  onDelete,
  onClose,
  onCover,
  onEditDone,
  onEditCancel,
}: {
  annotation: Annotation;
  pageCount: number;
  /** `continuous`: a slider, colour or typed value, whose run of changes is one undo step. */
  onChange: (next: Annotation, continuous?: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
  /** How much of the screen's bottom the sheet covers: 0 as a side panel. */
  onCover?: (px: number) => void;
  /** Changed text: Enter in its text box is done. */
  onEditDone?: () => void;
  /** Changed text: Escape in its text box puts back the words it had when entered. */
  onEditCancel?: (reverted: TextEditAnnotation) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onCover) return;
    const report = () => onCover(getComputedStyle(el).position === "fixed" ? el.offsetHeight : 0);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      observer.disconnect();
      onCover(0);
    };
  }, [onCover]);

  return (
    // Phones: a bottom sheet over the page. Wider screens: a side panel.
    <aside
      ref={ref}
      aria-label="Properties"
      data-properties
      className="fixed inset-x-0 bottom-0 z-30 max-h-[50dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-background p-4 shadow-2xl md:static md:z-auto md:max-h-none md:w-64 md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{annotationLabel(annotation)}</h2>
        <button
          onClick={onClose}
          className="-m-2.5 flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
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
                onChange={(e) => onChange({ ...annotation, color: e.target.value }, true)}
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

        {annotation.type === "edit" && <EditFields annotation={annotation} onChange={onChange} onDone={onEditDone} onCancel={onEditCancel} />}

        {annotation.type === "note" && (
          <Field label="Colour" group>
            <div className="flex gap-1.5">
              {NOTE_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => onChange({ ...annotation, color: c.value })}
                  className={`h-7 w-7 rounded-full border forced-color-adjust-none ${
                    annotation.color === c.value ? "ring-2 ring-ring ring-offset-1" : ""
                  }`}
                  style={{ background: c.value }}
                  aria-label={c.name}
                  aria-pressed={annotation.color === c.value}
                  title={c.name}
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
                onChange={(e) => onChange({ ...annotation, stroke: e.target.value }, true)}
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
              <Field label="Fill" group>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label="Fill"
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
                      aria-label="Fill colour"
                      value={annotation.fill}
                      onChange={(e) => onChange({ ...annotation, fill: e.target.value }, true)}
                      className="h-9 flex-1 cursor-pointer rounded-md border border-input bg-background px-1"
                    />
                  )}
                </div>
              </Field>
            )}
            <Field label={<OpacityLabel opacity={annotation.opacity} />}>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={annotation.opacity}
                aria-valuetext={`${Math.round(annotation.opacity * 100)}%`}
                onChange={(e) =>
                  onChange({ ...annotation, opacity: Number(e.target.value) }, true)
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
                onChange={(e) => onChange({ ...annotation, color: e.target.value }, true)}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-1"
              />
            </Field>
            <Field label={<OpacityLabel opacity={annotation.opacity} />}>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={annotation.opacity}
                aria-valuetext={`${Math.round(annotation.opacity * 100)}%`}
                onChange={(e) =>
                  onChange({ ...annotation, opacity: Number(e.target.value) }, true)
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
                  onChange={(e) => onChange({ ...annotation, url: e.target.value }, true)}
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
                onChange={(e) => onChange({ ...annotation, name: e.target.value }, true)}
              />
            </Field>
            {annotation.field === "text" && (
              <Field label="Default value">
                <Input
                  value={annotation.value}
                  onChange={(e) => onChange({ ...annotation, value: e.target.value }, true)}
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
            {annotation.field === "radio" && (
              <>
                <Field label="Value when chosen">
                  <Input
                    value={annotation.value}
                    placeholder="e.g. Yes"
                    onChange={(e) => onChange({ ...annotation, value: e.target.value }, true)}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Radio buttons with the same field name are one group.
                </p>
              </>
            )}
            {annotation.field === "dropdown" && (
              <Field label="Options (one per line)">
                <OptionsField
                  options={annotation.options}
                  onChange={(options) => onChange({ ...annotation, options }, true)}
                />
              </Field>
            )}
            <p className="rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">
              Stays fillable in the exported PDF.
            </p>
          </>
        )}

        {annotation.type === "edit" ? (
          // Taking the words away is a change; putting the old ones back drops the edit.
          <div className="grid gap-2 border-t border-border pt-4">
            <Button
              variant="destructive"
              size="sm"
              className="w-full pointer-coarse:h-11"
              onClick={() => onChange({ ...annotation, text: "" })}
              aria-disabled={!annotation.text}
            >
              Remove text
            </Button>
            <Button variant="outline" size="sm" className="w-full pointer-coarse:h-11" onClick={onDelete}>
              Restore original
            </Button>
          </div>
        ) : (
          <div className="border-t border-border pt-4">
            <Button variant="destructive" size="sm" className="w-full" onClick={onDelete}>
              Delete
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

/** Size, style and colour of changed text, the font it will be in, and whether the old words go. */
function EditFields({
  annotation,
  onChange,
  onDone,
  onCancel,
}: {
  annotation: TextEditAnnotation;
  onChange: (next: Annotation, continuous?: boolean) => void;
  onDone?: () => void;
  onCancel?: (reverted: TextEditAnnotation) => void;
}) {
  const run = annotation.run;
  const start = useRef(annotation.text);
  const own = Math.round(run.size * 2) / 2;
  const sizes = [...new Set([...SIZES, own, annotation.fontSize])].sort((a, b) => a - b);
  const guess = guessFont(run.font, annotation.text, annotation.bold, annotation.italic);
  const original = fontLabel(run.font.name);
  const lost = undrawable(annotation.text);
  return (
    <>
      {/* The words at a size to read and type, whatever the page's zoom: on a phone, they are typed here. */}
      <Field label="Text">
        <input
          data-edit-field
          value={annotation.text}
          placeholder="Removed"
          spellCheck={false}
          autoComplete="off"
          onFocus={() => (start.current = annotation.text)}
          onChange={(e) => onChange({ ...annotation, text: e.target.value }, true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onDone?.();
            } else if (e.key === "Escape" && onCancel) {
              e.preventDefault();
              e.stopPropagation();
              onCancel({ ...annotation, text: start.current });
            }
          }}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-base placeholder:italic md:h-9 md:text-sm"
        />
      </Field>
      <Field label="Font size">
        <select
          value={annotation.fontSize}
          onChange={(e) => onChange({ ...annotation, fontSize: Number(e.target.value) })}
          className="h-9 w-full rounded-md border border-input bg-background px-2 pointer-coarse:h-11"
        >
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}pt{s === own ? " (as it was)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-4">
        <label className="flex items-center gap-2 pointer-coarse:py-2">
          <input type="checkbox" checked={annotation.bold} onChange={(e) => onChange({ ...annotation, bold: e.target.checked })} />
          Bold
        </label>
        <label className="flex items-center gap-2 pointer-coarse:py-2">
          <input type="checkbox" checked={annotation.italic} onChange={(e) => onChange({ ...annotation, italic: e.target.checked })} />
          Italic
        </label>
      </div>
      <Field label="Colour">
        <input
          type="color"
          value={annotation.color}
          onChange={(e) => onChange({ ...annotation, color: e.target.value }, true)}
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-1 pointer-coarse:h-11"
        />
      </Field>
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Font: <span className="font-medium text-foreground">{guess.name}</span>
          {guess.own
            ? " (the file's own, if it has every letter you type)"
            : guess.name.split(" ")[0] !== original.split(" ")[0]
              ? `, the closest standard font to ${original}`
              : ""}
          {guess.noto ? ", with Noto Sans for letters it lacks" : ""}.
        </p>
        {lost.length > 0 && <p className="text-amber-700">These letters can&apos;t be drawn here and will be left out: {lost.slice(0, 8).join(" ")}</p>}
        {run.cover && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
            The old words will be covered, not removed: {COVERED[run.cover]}. To remove them for good, use{" "}
            <Link href="/tools/redact-pdf" className="font-medium underline underline-offset-2">
              Redact PDF
            </Link>
            .
          </p>
        )}
      </div>
    </>
  );
}

const optionLines = (text: string) => text.split("\n").filter(Boolean);

/**
 * One option per line. The text is kept as typed, so Enter can start a new
 * option; blank lines are left out of the options.
 */
function OptionsField({
  id,
  options,
  onChange,
}: {
  id?: string;
  options: string[];
  onChange: (options: string[]) => void;
}) {
  const [text, setText] = useState(options.join("\n"));
  // Show options changed elsewhere (undo, another field selected).
  useEffect(() => {
    setText((current) =>
      optionLines(current).join("\n") === options.join("\n") ? current : options.join("\n")
    );
  }, [options]);
  return (
    <textarea
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = optionLines(e.target.value);
        if (next.join("\n") !== options.join("\n")) onChange(next);
      }}
      rows={4}
      className="w-full rounded-md border border-input bg-background p-2 text-sm"
    />
  );
}

/** The percentage is shown, and read out as the slider's value instead. */
function OpacityLabel({ opacity }: { opacity: number }) {
  return (
    <>
      Opacity <span aria-hidden>{Math.round(opacity * 100)}%</span>
    </>
  );
}

/**
 * A labelled control: the label names the control it holds. A set of
 * controls (`group`) is named as a group instead.
 */
function Field({
  label,
  group = false,
  children,
}: {
  label: React.ReactNode;
  group?: boolean;
  children: React.ReactElement<{ id?: string }>;
}) {
  const id = useId();
  const className = "mb-1.5 block text-xs font-medium text-muted-foreground";
  if (group) {
    return (
      <div role="group" aria-labelledby={id}>
        <span id={id} className={className}>
          {label}
        </span>
        {children}
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={id} className={className}>
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}
