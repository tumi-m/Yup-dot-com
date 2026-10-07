"use client";

import {
  MousePointer2,
  Type,
  StickyNote,
  Highlighter,
  Underline,
  Strikethrough,
  Pen,
  Eraser,
  Square,
  Circle,
  Minus,
  ArrowUpRight,
  ImageIcon,
  Signature,
  Link2,
  TextCursorInput,
  CheckSquare,
  CircleDot,
  ChevronDownSquare,
} from "lucide-react";
import type { ToolId, ToolSettings } from "@/lib/editor/types";
import { cn } from "@/lib/utils";

interface ToolDef {
  id: ToolId;
  icon: typeof Type;
  label: string;
  key?: string;
}

const GROUPS: { name: string; tools: ToolDef[] }[] = [
  {
    name: "Select",
    tools: [{ id: "select", icon: MousePointer2, label: "Select", key: "V" }],
  },
  {
    name: "Text",
    tools: [
      { id: "text", icon: Type, label: "Add text", key: "T" },
      { id: "note", icon: StickyNote, label: "Sticky note", key: "N" },
    ],
  },
  {
    name: "Markup",
    tools: [
      { id: "highlight", icon: Highlighter, label: "Highlight", key: "H" },
      { id: "underline", icon: Underline, label: "Underline", key: "U" },
      { id: "strikeout", icon: Strikethrough, label: "Strikeout", key: "K" },
    ],
  },
  {
    name: "Draw",
    tools: [
      { id: "draw", icon: Pen, label: "Freehand", key: "D" },
      { id: "whiteout", icon: Eraser, label: "Whiteout", key: "W" },
    ],
  },
  {
    name: "Shapes",
    tools: [
      { id: "rect", icon: Square, label: "Rectangle", key: "R" },
      { id: "ellipse", icon: Circle, label: "Ellipse", key: "O" },
      { id: "line", icon: Minus, label: "Line", key: "L" },
      { id: "arrow", icon: ArrowUpRight, label: "Arrow", key: "A" },
    ],
  },
  {
    name: "Insert",
    tools: [
      { id: "image", icon: ImageIcon, label: "Image" },
      { id: "signature", icon: Signature, label: "Signature", key: "S" },
      { id: "link", icon: Link2, label: "Link" },
    ],
  },
  {
    name: "Form fields",
    tools: [
      { id: "field-text", icon: TextCursorInput, label: "Text field" },
      { id: "field-checkbox", icon: CheckSquare, label: "Checkbox" },
      { id: "field-radio", icon: CircleDot, label: "Radio button" },
      { id: "field-dropdown", icon: ChevronDownSquare, label: "Dropdown" },
    ],
  },
];

const COLORS = [
  { value: "#1e1b4b", name: "Navy" },
  { value: "#dc2626", name: "Red" },
  { value: "#ea580c", name: "Orange" },
  { value: "#16a34a", name: "Green" },
  { value: "#2563eb", name: "Blue" },
  { value: "#7c3aed", name: "Violet" },
];
const HIGHLIGHTS = [
  { value: "#fde047", name: "Yellow" },
  { value: "#86efac", name: "Green" },
  { value: "#93c5fd", name: "Blue" },
  { value: "#fca5a5", name: "Red" },
  { value: "#f0abfc", name: "Pink" },
];

const NEEDS_COLOR: ToolId[] = [
  "text",
  "draw",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "underline",
  "strikeout",
];
const NEEDS_STROKE: ToolId[] = ["draw", "rect", "ellipse", "line", "arrow"];

export function Toolbar({
  tool,
  onToolChange,
  settings,
  onSettingsChange,
}: {
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
}) {
  const showColor = NEEDS_COLOR.includes(tool);
  const showHighlight = tool === "highlight";
  const showStroke = NEEDS_STROKE.includes(tool);
  const showFont = tool === "text";
  const showFill = tool === "rect" || tool === "ellipse";

  const hasOptions = showColor || showHighlight || showStroke || showFont || showFill;
  const control = "h-8 rounded-md border border-border bg-background px-2 text-sm pointer-coarse:h-11";

  return (
    // Phones: a sideways-scrolling row of tools, and a second row for the
    // current tool's options. Landscape phones: both in one scrolling row.
    // Tablets and up: one wrapping bar.
    <div className="scrollbar-none flex flex-col border-b border-border bg-background short:flex-row short:items-center short:gap-1.5 short:overflow-x-auto short:px-2 short:py-1 tall:flex-row tall:flex-wrap tall:items-center tall:gap-1.5 tall:px-3 tall:py-2">
      <div className="scrollbar-none flex items-center gap-1.5 overflow-x-auto px-2 py-1 short:contents tall:contents">
        {GROUPS.map((group, gi) => (
          <div key={group.name} className="flex shrink-0 items-center">
            {gi > 0 && <div className="mx-1.5 h-6 w-px bg-border" />}
            <div className="flex items-center gap-0.5">
              {group.tools.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onToolChange(t.id)}
                  title={t.key ? `${t.label} (${t.key})` : t.label}
                  aria-label={t.label}
                  aria-pressed={tool === t.id}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md transition-colors pointer-coarse:h-11 pointer-coarse:w-11",
                    tool === t.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <t.icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {hasOptions && (
        <div className="scrollbar-none flex items-center gap-1.5 overflow-x-auto border-t border-border px-2 py-1 short:contents tall:contents">
          <div className="mx-1.5 hidden h-6 w-px shrink-0 bg-border short:block tall:block" />

          {(showColor || showHighlight) && (
            <div role="group" aria-label="Colour" className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-1.5 py-1">
              {(showHighlight ? HIGHLIGHTS : COLORS).map((c) => {
                const active = showHighlight
                  ? settings.highlightColor === c.value
                  : settings.color === c.value;
                return (
                  <button
                    key={c.value}
                    onClick={() =>
                      onSettingsChange(
                        showHighlight
                          ? { ...settings, highlightColor: c.value }
                          : { ...settings, color: c.value }
                      )
                    }
                    aria-label={c.name}
                    aria-pressed={active}
                    title={c.name}
                    className={cn(
                      "h-6 w-6 shrink-0 rounded-full border border-black/10 pointer-coarse:h-8 pointer-coarse:w-8",
                      active && "ring-2 ring-ring ring-offset-1"
                    )}
                    style={{ background: c.value }}
                  />
                );
              })}
            </div>
          )}

          {showFont && (
            <>
              <select
                value={settings.fontSize}
                onChange={(e) =>
                  onSettingsChange({ ...settings, fontSize: Number(e.target.value) })
                }
                className={cn(control, "shrink-0")}
                aria-label="Font size"
              >
                {[9, 10, 12, 14, 16, 20, 24, 32, 48].map((s) => (
                  <option key={s} value={s}>
                    {s}pt
                  </option>
                ))}
              </select>
              <button
                onClick={() => onSettingsChange({ ...settings, bold: !settings.bold })}
                aria-pressed={settings.bold}
                aria-label="Bold"
                title="Bold"
                className={cn(
                  "h-8 w-8 shrink-0 rounded-md text-sm font-bold transition-colors pointer-coarse:h-11 pointer-coarse:w-11",
                  settings.bold
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                B
              </button>
            </>
          )}

          {showStroke && (
            <select
              value={settings.strokeWidth}
              onChange={(e) =>
                onSettingsChange({ ...settings, strokeWidth: Number(e.target.value) })
              }
              className={cn(control, "shrink-0")}
              aria-label="Stroke width"
            >
              {[1, 2, 3, 5, 8].map((s) => (
                <option key={s} value={s}>
                  {s}px
                </option>
              ))}
            </select>
          )}

          {showFill && (
            <label className={cn(control, "flex shrink-0 items-center gap-1.5")}>
              <input
                type="checkbox"
                checked={settings.fill !== null}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    fill: e.target.checked ? settings.color : null,
                  })
                }
              />
              Fill
            </label>
          )}
        </div>
      )}
    </div>
  );
}
