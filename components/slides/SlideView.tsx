"use client";

import { memo, useId, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type {
  Chart,
  Diagram,
  Fill as PFill,
  Image as PImage,
  LineEnd,
  Math as PMath,
  Shape as PShape,
  Table as PTable,
  Text as PText,
} from "pptxtojson";
import type { DeckElement, DeckGroup, DeckSlide, ElementExtras, Fill } from "@/lib/pptx/parse";
import { fontStack } from "@/lib/pptx/fonts";
import { safeCssColor } from "@/lib/pptx/sanitize";
import { prepareCellHtml, prepareTextHtml, LINE } from "@/lib/pptx/text-html";
import { builtInTableLook } from "@/lib/pptx/table-style";
import { cn } from "@/lib/utils";
import { ChartPlaceholder, ChartView } from "./ChartView";

/**
 * Renders one slide from the deck model with absolutely positioned HTML/SVG.
 *
 * Layout happens in slide points (1pt drawn as 1 CSS px) inside a box that is
 * then scaled by `scale`, so the same markup serves thumbnails, the editor
 * canvas and PDF rasterisation. Every slide element's wrapper carries
 * data-element-id (the shape's p:cNvPr id, see lib/pptx/parse.ts);
 * layout/master decorations do not and are never interactive.
 */

export interface SlideViewProps {
  slide: DeckSlide;
  /** Slide size in points. */
  deckWidth: number;
  deckHeight: number;
  /** CSS pixels per point. */
  scale: number;
  className?: string;
  style?: CSSProperties;
  selectedId?: string | null;
  onElementClick?: (el: DeckElement) => void;
  /** Makes slide elements focusable and clickable (for the editor). */
  interactive?: boolean;
  /** Theme accent colours (deck.themeColors), used for built-in table styles. */
  themeColors?: string[];
}

interface Ctx {
  prefix: string;
  layer: "slide" | "layout";
  interactive: boolean;
  selectedId?: string | null;
  onElementClick?: (el: DeckElement) => void;
  accents: string[];
  scale: number;
  linkColor?: string;
}

type WithExtras<T> = T & ElementExtras;

const LINE_SHAPES = /^(line|straightConnector1|bentConnector\d|curvedConnector\d|arc|leftBracket|rightBracket|leftBrace|rightBrace|bracketPair|bracePair)$/;

const BASE_TEXT: CSSProperties = {
  color: "#000000",
  fontFamily: fontStack("Calibri"),
  fontSize: 18,
  lineHeight: LINE,
  textAlign: "left",
  letterSpacing: "normal",
  wordSpacing: "normal",
  fontWeight: 400,
  fontStyle: "normal",
};

/* ------------------------------------------------------------------ html cache */

const textCache = new WeakMap<object, string>();

function textHtml(el: WithExtras<PText | PShape>, linkColor?: string): string {
  if (typeof document === "undefined") return "";
  const hit = textCache.get(el);
  if (hit !== undefined) return hit;
  let html = "";
  try {
    html = prepareTextHtml(el.content ?? "", {
      paragraphs: el.paragraphs,
      fontScale: el.autoFit?.type === "text" ? el.autoFit.fontScale : undefined,
      phType: el.phType,
      linkColor,
    });
  } catch {
    html = "";
  }
  textCache.set(el, html);
  return html;
}

const cellCache = new WeakMap<object, string>();

function cellHtml(cell: { text: string }): string {
  if (typeof document === "undefined") return "";
  const hit = cellCache.get(cell);
  if (hit !== undefined) return hit;
  let html = "";
  try {
    html = prepareCellHtml(cell.text ?? "");
  } catch {
    html = "";
  }
  cellCache.set(cell, html);
  return html;
}

/* ------------------------------------------------------------------ fills */

function stops(colors: { pos: string; color: string }[]) {
  return colors.map((c, i) => {
    const pos = parseFloat(c.pos);
    return {
      offset: Number.isFinite(pos) ? pos : colors.length > 1 ? (i / (colors.length - 1)) * 100 : 0,
      color: safeCssColor(c.color),
    };
  });
}

/** CSS background for slide backgrounds and table cells. */
export function fillToCss(fill: Fill | undefined): CSSProperties {
  if (!fill) return {};
  switch (fill.type) {
    case "color":
      return fill.value ? { backgroundColor: fill.value } : {};
    case "gradient": {
      const list = stops(fill.value.colors)
        .map((s) => `${s.color} ${s.offset}%`)
        .join(", ");
      if (!list) return {};
      return fill.value.path === "line"
        ? { backgroundImage: `linear-gradient(${(fill.value.rot ?? 0) + 90}deg, ${list})` }
        : { backgroundImage: `radial-gradient(circle at center, ${list})` };
    }
    case "image": {
      const src = fill.value.base64 || fill.value.blob;
      return src && /^(data:image\/|blob:)/.test(src)
        ? { backgroundImage: `url("${src}")`, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" }
        : {};
    }
    case "pattern":
      return { backgroundColor: fill.value.backgroundColor || fill.value.foregroundColor };
    default:
      return {};
  }
}

/** SVG paint for a shape fill; emits a <defs> entry when one is needed. */
function svgPaint(fill: PFill | null | undefined, id: string): { paint: string; defs?: ReactNode; opacity?: number } {
  if (!fill) return { paint: "none" };
  switch (fill.type) {
    case "color":
      return { paint: fill.value || "none" };
    case "gradient": {
      const s = stops(fill.value.colors);
      if (!s.length) return { paint: "none" };
      const children = s.map((st, i) => <stop key={i} offset={`${st.offset}%`} stopColor={st.color} />);
      if (fill.value.path !== "line") {
        return { paint: `url(#${id})`, defs: <radialGradient id={id} cx="50%" cy="50%" r="50%">{children}</radialGradient> };
      }
      const a = ((fill.value.rot ?? 0) * Math.PI) / 180;
      const dx = Math.cos(a) / 2;
      const dy = Math.sin(a) / 2;
      return {
        paint: `url(#${id})`,
        defs: (
          <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
            {children}
          </linearGradient>
        ),
      };
    }
    case "image": {
      const src = fill.value.base64 || fill.value.blob;
      if (!src || !/^(data:image\/|blob:)/.test(src)) return { paint: "none" };
      return {
        paint: `url(#${id})`,
        opacity: fill.value.opacity,
        defs: (
          <pattern id={id} patternContentUnits="objectBoundingBox" width="1" height="1">
            <image href={src} width="1" height="1" preserveAspectRatio="none" />
          </pattern>
        ),
      };
    }
    case "pattern": {
      const { foregroundColor: fg, backgroundColor: bg } = fill.value;
      return {
        paint: `url(#${id})`,
        defs: (
          <pattern id={id} patternUnits="userSpaceOnUse" width="6" height="6">
            <rect width="6" height="6" fill={bg || "#FFFFFF"} />
            <rect width="3" height="3" fill={fg || "#000000"} />
          </pattern>
        ),
      };
    }
    default:
      return { paint: "none" };
  }
}

/* ------------------------------------------------------------------ lines */

function dashArray(el: { borderType?: string; borderStrokeDasharray?: string; borderWidth: number }) {
  const w = Math.max(el.borderWidth, 0.75);
  const raw = el.borderStrokeDasharray;
  if (!raw || raw === "0" || el.borderType === "solid") return undefined;
  // pptxtojson's dash patterns are for a 1px line; PowerPoint scales them with the width.
  const parts = raw.split(/[ ,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!parts.length) return undefined;
  const list = parts.length === 1 ? [parts[0], parts[0] * 0.6] : parts;
  return list.map((n) => +((n * w) / 1.5).toFixed(2)).join(" ");
}

const END_SIZE = { sm: 2, med: 3, lg: 5 } as const;

function marker(end: LineEnd | undefined, id: string, color: string, start: boolean): ReactNode {
  if (!end || end.type === "none") return null;
  const w = END_SIZE[end.width ?? "med"] ?? 3;
  const l = END_SIZE[end.length ?? "med"] ?? 3;
  let shape: ReactNode;
  switch (end.type) {
    case "arrow":
      shape = <path d="M0,0 L10,5 L0,10" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />;
      break;
    case "stealth":
      shape = <path d="M0,0 L10,5 L0,10 L3,5 Z" fill={color} />;
      break;
    case "diamond":
      shape = <path d="M0,5 L5,0 L10,5 L5,10 Z" fill={color} />;
      break;
    case "oval":
      shape = <ellipse cx={5} cy={5} rx={5} ry={5} fill={color} />;
      break;
    default:
      shape = <path d="M0,0 L10,5 L0,10 Z" fill={color} />;
  }
  const centred = end.type === "diamond" || end.type === "oval";
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={centred ? 5 : 8}
      refY={5}
      markerWidth={l}
      markerHeight={w}
      markerUnits="strokeWidth"
      orient={start ? "auto-start-reverse" : "auto"}
      overflow="visible"
    >
      {shape}
    </marker>
  );
}

/* ------------------------------------------------------------------ pieces */

function flipTransform(flipH?: boolean, flipV?: boolean) {
  if (!flipH && !flipV) return undefined;
  return `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`;
}

function shadowFilter(shadow: PShape["shadow"]) {
  if (!shadow) return undefined;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return `drop-shadow(${n(shadow.h)}px ${n(shadow.v)}px ${Math.max(0, n(shadow.blur) / 2)}px ${safeCssColor(shadow.color, "#00000080")})`;
}

/**
 * Offsets of the text rectangle inside common preset shapes, from
 * PowerPoint's preset definitions (e.g. text in an ellipse sits in the
 * inscribed rectangle, text in a triangle in its lower half).
 */
function textRect(el: PShape): { l: number; t: number; r: number; b: number } | null {
  const w = el.width;
  const h = el.height;
  switch (el.shapType) {
    case "ellipse":
    case "flowChartConnector": {
      const k = (1 - Math.SQRT1_2) / 2;
      return { l: w * k, t: h * k, r: w * k, b: h * k };
    }
    case "triangle": {
      const adj = el.keypoints?.adj !== undefined ? el.keypoints.adj / 2 : 0.5;
      return { l: (w * adj) / 2, t: h / 2, r: w - ((w * adj) / 2 + w / 2), b: 0 };
    }
    case "diamond":
    case "flowChartDecision":
      return { l: w / 4, t: h / 4, r: w / 4, b: h / 4 };
    case "roundRect": {
      const adj = el.keypoints?.adj !== undefined ? el.keypoints.adj / 2 : 0.16667;
      const d = Math.min(w, h) * adj * (1 - Math.SQRT1_2);
      return { l: d, t: d, r: d, b: d };
    }
    default:
      return null;
  }
}

function TextLayer({ el, flipV, linkColor }: { el: WithExtras<PText | PShape>; flipV?: boolean; linkColor?: string }) {
  const html = textHtml(el, linkColor);
  const vertical = "isVertical" in el && el.isVertical;
  if (!html) return null;
  const base = el.textInset ?? { l: 7.2, t: 3.6, r: 7.2, b: 3.6 };
  const geo = el.type === "shape" ? textRect(el as PShape) : null;
  const inset = geo
    ? { l: base.l + geo.l, t: base.t + geo.t, r: base.r + geo.r, b: base.b + geo.b }
    : base;
  const anchor = el.anchor ?? (el.vAlign === "mid" ? "ctr" : el.vAlign === "down" ? "b" : "t");
  const justify = anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start";
  return (
    <div
      data-rotated={flipV || vertical ? "" : undefined}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: justify,
        padding: `${inset.t}px ${inset.r}px ${inset.b}px ${inset.l}px`,
        transform: flipV ? "rotate(180deg)" : undefined,
        writingMode: vertical ? "vertical-rl" : undefined,
        pointerEvents: "none",
      }}
    >
      <div
        className="pptx-text"
        style={{
          ...BASE_TEXT,
          whiteSpace: el.wrap === false ? "pre" : "pre-wrap",
          overflowWrap: el.wrap === false ? "normal" : "break-word",
          flexShrink: 0,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function rectPath(w: number, h: number) {
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
}

function ShapeBody({ el, id, linkColor }: { el: WithExtras<PShape | PText>; id: string; linkColor?: string }) {
  const w = el.width;
  const h = el.height;
  const isShape = el.type === "shape";
  const lineLike = isShape && ((el as PShape).strokeOnly || LINE_SHAPES.test((el as PShape).shapType ?? ""));
  const d = isShape && (el as PShape).path ? (el as PShape).path! : rectPath(w, h);
  const vb = (isShape && (el as PShape).pathViewBox) || { x: 0, y: 0, width: w, height: h };
  const { paint, defs, opacity } = lineLike ? { paint: "none" } as ReturnType<typeof svgPaint> : svgPaint(el.fill, `${id}-f`);
  const stroke = el.borderWidth > 0 && el.borderColor ? el.borderColor : "none";
  const head = isShape ? marker((el as PShape).headEnd, `${id}-h`, stroke, true) : null;
  const tail = isShape ? marker((el as PShape).tailEnd, `${id}-t`, stroke, false) : null;
  const drawn = paint !== "none" || stroke !== "none";
  return (
    <>
      {drawn && (
        <svg
          width={Math.max(w, 1)}
          height={Math.max(h, 1)}
          viewBox={`${vb.x} ${vb.y} ${vb.width || 1} ${vb.height || 1}`}
          preserveAspectRatio="none"
          overflow="visible"
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            transform: flipTransform(el.isFlipH, el.isFlipV),
            filter: shadowFilter(el.shadow),
          }}
        >
          {(defs || head || tail) && (
            <defs>
              {defs}
              {head}
              {tail}
            </defs>
          )}
          <path
            d={d}
            fill={paint}
            fillOpacity={opacity}
            stroke={stroke}
            strokeWidth={stroke === "none" ? undefined : el.borderWidth}
            strokeDasharray={stroke === "none" ? undefined : dashArray(el)}
            strokeLinejoin="round"
            markerStart={head ? `url(#${id}-h)` : undefined}
            markerEnd={tail ? `url(#${id}-t)` : undefined}
          />
        </svg>
      )}
      {el.content ? <TextLayer el={el} flipV={el.isFlipV} linkColor={linkColor} /> : null}
    </>
  );
}

const GEOM_CLIP: Record<string, CSSProperties> = {
  ellipse: { clipPath: "ellipse(50% 50% at 50% 50%)" },
  roundRect: { borderRadius: "16%" },
  flowChartConnector: { clipPath: "ellipse(50% 50% at 50% 50%)" },
};

function ImageBody({ el }: { el: PImage }) {
  const src = el.base64 || el.blob;
  const ok = !!src && /^(data:image\/|blob:)/.test(src);
  const c = el.rect ?? {};
  const l = (c.l ?? 0) / 100, r = (c.r ?? 0) / 100, t = (c.t ?? 0) / 100, b = (c.b ?? 0) / 100;
  const fw = el.width / Math.max(0.01, 1 - l - r);
  const fh = el.height / Math.max(0.01, 1 - t - b);
  const f = el.filters;
  const filter = f
    ? [
        f.brightness ? `brightness(${1 + f.brightness / 100})` : "",
        f.contrast ? `contrast(${1 + f.contrast / 100})` : "",
        f.saturation !== undefined ? `saturate(${f.saturation / 100})` : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined
    : undefined;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", ...(GEOM_CLIP[el.geom] ?? {}) }}>
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="sync"
          style={{
            position: "absolute",
            left: -l * fw,
            top: -t * fh,
            width: fw,
            height: fh,
            maxWidth: "none",
            maxHeight: "none",
            transform: flipTransform(el.isFlipH, el.isFlipV),
            filter,
          }}
        />
      ) : (
        <div style={{ position: "absolute", inset: 0, background: "#F4F4F5" }} />
      )}
      {el.borderWidth > 0 && el.borderColor && (
        <div
          style={{
            position: "absolute",
            inset: -el.borderWidth / 2,
            border: `${el.borderWidth}px ${el.borderType === "solid" ? "solid" : el.borderType} ${el.borderColor}`,
            borderRadius: "inherit",
          }}
        />
      )}
    </div>
  );
}

function TableBody({ el, ctx }: { el: WithExtras<PTable>; ctx: Ctx }) {
  const rows = el.data ?? [];
  const cols = el.colWidths?.length ? el.colWidths : [el.width];
  const hasOwnFill = rows.some((r) => r.some((c) => c.fillColor));
  const look = hasOwnFill ? null : builtInTableLook(el.tableFlags, ctx.accents, rows.length, cols.length);
  const border = (b?: { borderColor: string; borderWidth: number; borderType: string }) =>
    b && b.borderWidth > 0 ? `${b.borderWidth}px ${b.borderType === "solid" ? "solid" : b.borderType} ${b.borderColor}` : undefined;
  return (
    <table
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: el.width,
        tableLayout: "fixed",
        borderCollapse: "collapse",
        ...BASE_TEXT,
      }}
    >
      <colgroup>
        {cols.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} style={{ height: el.rowHeights?.[ri] }}>
            {row.map((cell, ci) => {
              if (cell.hMerge || cell.vMerge) return null;
              const lk = look?.(ri, ci);
              const cb = cell.borders ?? {};
              const fallbackBorder = lk?.border ? `${lk.border.width}px solid ${lk.border.color}` : undefined;
              return (
                <td
                  key={ci}
                  rowSpan={cell.rowSpan}
                  colSpan={cell.colSpan}
                  style={{
                    padding: "3.6px 7.2px",
                    verticalAlign: cell.vAlign === "mid" ? "middle" : cell.vAlign === "down" ? "bottom" : "top",
                    backgroundColor: cell.fillColor || lk?.fill,
                    color: cell.fontColor || lk?.color,
                    fontWeight: cell.fontBold || lk?.bold ? 700 : undefined,
                    borderTop: border(cb.top) ?? fallbackBorder,
                    borderBottom: border(cb.bottom) ?? (lk?.bottom ? `${lk.bottom.width}px solid ${lk.bottom.color}` : fallbackBorder),
                    borderLeft: border(cb.left) ?? fallbackBorder,
                    borderRight: border(cb.right) ?? fallbackBorder,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    overflow: "hidden",
                  }}
                  // Cell colours from the table style win over inherited span colours only when the run has none.
                  dangerouslySetInnerHTML={{ __html: cellHtml(cell) }}
                />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MediaPlaceholder({ width, height }: { width: number; height: number }) {
  const s = Math.min(width, height) * 0.25;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ position: "absolute", inset: 0 }}>
      <rect width={width} height={height} fill="#18181B" />
      <path d={`M ${width / 2 - s / 2} ${height / 2 - s / 1.6} L ${width / 2 + s / 1.6} ${height / 2} L ${width / 2 - s / 2} ${height / 2 + s / 1.6} Z`} fill="#E4E4E7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ elements */

function label(el: DeckElement): string {
  const text = "content" in el && typeof el.content === "string" ? el.content.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : "";
  const name = "name" in el && el.name ? el.name : el.type;
  return text ? `${name}: ${text.slice(0, 60)}` : name;
}

function renderElement(el: DeckElement, ctx: Ctx, key: string): ReactNode {
  const id = `${ctx.prefix}-${key}`;
  let body: ReactNode;
  try {
    switch (el.type) {
      case "text":
      case "shape":
        body = <ShapeBody el={el} id={id} linkColor={ctx.linkColor} />;
        break;
      case "image":
        body = <ImageBody el={el} />;
        break;
      case "table":
        body = <TableBody el={el} ctx={ctx} />;
        break;
      case "chart":
        body = <ChartView chart={el as Chart} />;
        break;
      case "diagram": {
        const dg = el as Diagram;
        body = dg.elements?.length ? (
          dg.elements.map((child, i) => renderElement(child as DeckElement, { ...ctx, interactive: false }, `${key}.${i}`))
        ) : (
          <ChartPlaceholder width={el.width} height={el.height} />
        );
        break;
      }
      case "math": {
        const m = el as PMath;
        const src = m.picBase64 || m.picBlob;
        body =
          src && /^(data:image\/|blob:)/.test(src) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", maxWidth: "none" }} />
          ) : m.text ? (
            <TextLayer el={{ ...(m as unknown as PText), content: m.text, vAlign: "mid", wrap: true } as PText} />
          ) : null;
        break;
      }
      case "video":
      case "audio":
        body = <MediaPlaceholder width={el.width} height={el.height} />;
        break;
      case "group": {
        const g = el as DeckGroup;
        body = (g.elements as DeckElement[]).map((child, i) => renderElement(child, ctx, `${key}.${i}`));
        break;
      }
      default:
        body = null;
    }
  } catch {
    body = <ChartPlaceholder width={el.width} height={el.height} />;
  }

  const rotate = "rotate" in el && el.rotate ? el.rotate : 0;
  const groupFlip = el.type === "group" ? flipTransform((el as DeckGroup).isFlipH, (el as DeckGroup).isFlipV) : undefined;
  const transform = [rotate ? `rotate(${rotate}deg)` : "", groupFlip ?? ""].filter(Boolean).join(" ") || undefined;
  const selectable = ctx.interactive && ctx.layer === "slide" && el.type !== "group";
  const selected = selectable && ctx.selectedId === el.id;

  const onActivate = () => ctx.onElementClick?.(el);
  const style: CSSProperties = {
    position: "absolute",
    left: el.left,
    top: el.top,
    width: el.width,
    height: el.height,
    transform,
  };
  if (selectable) {
    style.cursor = "pointer";
    style.outline = selected ? `${2 / ctx.scale}px solid hsl(262 83% 58%)` : undefined;
    style.outlineOffset = 2 / ctx.scale;
  }

  return (
    <div
      key={key}
      data-element-id={ctx.layer === "slide" ? el.id : undefined}
      data-element-type={el.type}
      data-rotated={rotate % 360 ? "" : undefined}
      style={style}
      className={selectable ? "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" : undefined}
      {...(selectable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": label(el),
            "aria-pressed": selected,
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              onActivate();
            },
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onActivate();
              }
            },
          }
        : {})}
    >
      {body}
    </div>
  );
}

function backgroundStyle(fill: Fill): CSSProperties {
  const css = fillToCss(fill);
  return { backgroundColor: "#FFFFFF", ...css };
}

export const SlideView = memo(function SlideView({
  slide,
  deckWidth,
  deckHeight,
  scale,
  className,
  style,
  selectedId,
  onElementClick,
  interactive = false,
  themeColors,
}: SlideViewProps) {
  const prefix = `s${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const base = { prefix, interactive, selectedId, onElementClick, accents: themeColors ?? [], scale, linkColor: slide.linkColor };
  return (
    <div
      className={cn("relative overflow-hidden", className)}
      style={{ width: deckWidth * scale, height: deckHeight * scale, ...style }}
      data-slide-number={slide.number}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: deckWidth,
          height: deckHeight,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          overflow: "hidden",
          ...BASE_TEXT,
          ...backgroundStyle(slide.fill),
        }}
      >
        {slide.layoutElements.map((el, i) => renderElement(el, { ...base, layer: "layout", interactive: false }, `l${i}`))}
        {slide.elements.map((el, i) => renderElement(el, { ...base, layer: "slide" }, `e${i}`))}
      </div>
    </div>
  );
});
