import {
  PDFDocument,
  PDFField,
  PDFFont,
  PDFName,
  PDFPage,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib";
import type { Annotation } from "@/lib/editor/types";
import { pageFrame } from "./page-frame";
import { stampWatermark } from "./watermark";

/** Matrix mapping the displayed page (bottom-left origin) to user space. */
function displayToUser(page: PDFPage): [number, number, number, number, number, number] {
  const { x: bx, y: by, width: W, height: H } = page.getCropBox();
  switch (pageFrame(page).rotation) {
    case 90:
      return [0, 1, -1, 0, bx + W, by];
    case 180:
      return [-1, 0, 0, -1, bx + W, by + H];
    case 270:
      return [0, -1, 1, 0, bx, by + H];
    default:
      return [1, 0, 0, 1, bx, by];
  }
}

/** Convert #rrggbb to a pdf-lib colour. */
function hex(color: string) {
  const c = color.replace("#", "");
  const v = (i: number) => parseInt(c.slice(i, i + 2), 16) / 255;
  const [r, g, b] = [v(0), v(2), v(4)];
  return rgb(
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0
  );
}

/**
 * The standard fonts are WinAnsi-encoded and throw on characters they cannot
 * represent, so replace anything outside Latin-1 rather than failing an export.
 */
function safeText(text: string): string {
  return text.replace(/[^\x00-\xFF]/g, "?");
}

/**
 * Renders wrapped text (any script) to a transparent PNG, sized in points.
 * Browser only; returns null where canvas isn't available.
 */
async function renderTextImage(
  text: string,
  fontSize: number,
  color: string,
  bold: boolean,
  maxWidth: number
): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const k = 4; // pixels per point, for print-quality edges
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const font = `${bold ? "bold " : ""}${fontSize * k}px Helvetica, Arial, "Noto Sans", sans-serif`;
  ctx.font = font;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    // Split on spaces, or between characters for scripts written without them.
    for (const word of paragraph.match(/\S+\s*|\s+/g) ?? [""]) {
      const candidate = line + word;
      if (!line || ctx.measureText(candidate.trimEnd()).width <= maxWidth * k) line = candidate;
      else {
        lines.push(line.trimEnd());
        line = word;
      }
      while (ctx.measureText(line.trimEnd()).width > maxWidth * k && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth * k) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  const lineHeight = fontSize * 1.2;
  const width = Math.max(1, Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width / k))));
  const height = lines.length * lineHeight;
  canvas.width = Math.ceil(width * k);
  canvas.height = Math.ceil(height * k);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => ctx.fillText(line, 0, (i * lineHeight + fontSize) * k));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width / k, height: canvas.height / k };
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  for (const paragraph of safeText(text).split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Append a raw annotation dictionary to a page's /Annots array. */
function addRawAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  dict: Record<string, unknown>
) {
  const ref = doc.context.register(doc.context.obj(dict as never));
  const annots = page.node.Annots();
  if (annots) {
    annots.push(ref);
  } else {
    page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  }
}

export interface BakeOptions {
  /** Adds the "Made with PDF Wizard" mark (Free edits; lib/pdf/watermark.ts). */
  watermark?: boolean;
}

/**
 * Flattens editor annotations into the PDF and returns the new bytes.
 *
 * Annotations use a top-left origin in PDF points; pdf-lib uses bottom-left,
 * so the y-axis is flipped here — the single place that conversion happens.
 *
 * Links become real clickable link annotations and form fields become real
 * AcroForm fields, so both stay interactive in the exported document.
 */
export async function bakeAnnotations(
  bytes: ArrayBuffer | Uint8Array,
  annotations: Annotation[],
  options: BakeOptions = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  const form = doc.getForm();
  const usedNames = new Set(form.getFields().map((f) => f.getName()));
  const radioGroups = new Map<string, ReturnType<typeof form.createRadioGroup>>();
  let createdFields = false;

  const uniqueName = (base: string) => {
    const clean = base.trim().replace(/[^\w.-]/g, "_") || "field";
    let name = clean;
    let n = 2;
    while (usedNames.has(name)) name = `${clean}_${n++}`;
    usedNames.add(name);
    return name;
  };

  // Annotations are placed on the page as the reader sees it (pdf.js
  // viewport: crop box with /Rotate applied). Draw each page's annotations in
  // that frame by prefixing a matrix that maps it back to user space;
  // otherwise they land shifted on offset boxes and sideways on rotated pages.
  const byPage = new Map<number, Annotation[]>();
  for (const ann of annotations) {
    if (!pages[ann.page]) continue;
    byPage.set(ann.page, [...(byPage.get(ann.page) ?? []), ann]);
  }

  for (const [pageIndex, pageAnnotations] of byPage) {
    const page = pages[pageIndex];
    const frame = pageFrame(page);
    const ph = frame.height;
    const matrix = displayToUser(page);
    const transformed = matrix.join() !== "1,0,0,1,0,0";
    if (transformed) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
    /** A display-space rectangle (bottom-left origin) in user space, for annotation dictionaries. */
    const userRect = (x: number, y: number, w: number, h: number) => {
      const a = frame.toPdf(x, y);
      const b = frame.toPdf(x + w, y + h);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    };

    for (const ann of pageAnnotations) {
      // Top-left origin -> bottom-left origin.
      const bottom = ph - ann.y - ann.height;

      switch (ann.type) {
        case "text": {
          // The standard fonts are Latin-1 only; in the browser, draw other
          // scripts as a crisp image instead of turning them into "?".
          if (/[^\x00-\xFF]/.test(ann.text) && typeof document !== "undefined") {
            const img = await renderTextImage(ann.text, ann.fontSize, ann.color, ann.bold, ann.width);
            if (img) {
              const embedded = await doc.embedPng(img.png);
              page.drawImage(embedded, { x: ann.x, y: ph - ann.y - img.height, width: img.width, height: img.height });
              break;
            }
          }
          const font = ann.bold ? helveticaBold : helvetica;
          const lines = wrapText(ann.text, font, ann.fontSize, ann.width);
          const lineHeight = ann.fontSize * 1.2;
          lines.forEach((line, i) => {
            page.drawText(line, {
              x: ann.x,
              y: ph - ann.y - ann.fontSize - i * lineHeight,
              size: ann.fontSize,
              font,
              color: hex(ann.color),
            });
          });
          break;
        }

        case "draw": {
          if (ann.points.length < 2) break;
          for (let i = 1; i < ann.points.length; i++) {
            const a = ann.points[i - 1];
            const b = ann.points[i];
            page.drawLine({
              start: { x: ann.x + a.x, y: ph - (ann.y + a.y) },
              end: { x: ann.x + b.x, y: ph - (ann.y + b.y) },
              thickness: ann.strokeWidth,
              color: hex(ann.color),
            });
          }
          break;
        }

        case "image": {
          try {
            const embed = ann.dataUrl.startsWith("data:image/jpeg")
              ? await doc.embedJpg(ann.dataUrl)
              : await doc.embedPng(ann.dataUrl);
            page.drawImage(embed, {
              x: ann.x,
              y: bottom,
              width: ann.width,
              height: ann.height,
            });
          } catch {
            // Skip an unreadable image rather than failing the whole export.
          }
          break;
        }

        case "note": {
          // Flattened sticky note: coloured panel, header strip, wrapped body.
          const headerHeight = 14;
          page.drawRectangle({
            x: ann.x,
            y: bottom,
            width: ann.width,
            height: ann.height,
            color: hex(ann.color),
            opacity: 0.22,
            borderColor: hex(ann.color),
            borderWidth: 1,
          });
          page.drawRectangle({
            x: ann.x,
            y: bottom + ann.height - headerHeight,
            width: ann.width,
            height: headerHeight,
            color: hex(ann.color),
            opacity: 0.85,
          });
          page.drawText("Note", {
            x: ann.x + 5,
            y: bottom + ann.height - headerHeight + 4,
            size: 8,
            font: helveticaBold,
            color: rgb(0.15, 0.12, 0.05),
          });
          const lines = wrapText(ann.text, helvetica, 9, ann.width - 10);
          lines.forEach((line, i) => {
            const y = bottom + ann.height - headerHeight - 12 - i * 11;
            if (y > bottom + 2) {
              page.drawText(line, {
                x: ann.x + 5,
                y,
                size: 9,
                font: helvetica,
                color: rgb(0.1, 0.1, 0.1),
              });
            }
          });
          break;
        }

        case "shape": {
          const stroke = hex(ann.stroke);
          const fill = ann.fill ? hex(ann.fill) : undefined;

          if (ann.shape === "whiteout") {
            page.drawRectangle({
              x: ann.x,
              y: bottom,
              width: ann.width,
              height: ann.height,
              color: rgb(1, 1, 1),
            });
            break;
          }

          if (ann.shape === "rect") {
            page.drawRectangle({
              x: ann.x,
              y: bottom,
              width: ann.width,
              height: ann.height,
              borderColor: stroke,
              borderWidth: ann.strokeWidth,
              color: fill,
              opacity: fill ? ann.opacity : undefined,
              borderOpacity: ann.opacity,
            });
            break;
          }

          if (ann.shape === "ellipse") {
            page.drawEllipse({
              x: ann.x + ann.width / 2,
              y: bottom + ann.height / 2,
              xScale: Math.max(1, ann.width / 2),
              yScale: Math.max(1, ann.height / 2),
              borderColor: stroke,
              borderWidth: ann.strokeWidth,
              color: fill,
              opacity: fill ? ann.opacity : undefined,
              borderOpacity: ann.opacity,
            });
            break;
          }

          // line + arrow
          const x1 = ann.x1 ?? ann.x;
          const y1 = ann.y1 ?? ann.y;
          const x2 = ann.x2 ?? ann.x + ann.width;
          const y2 = ann.y2 ?? ann.y + ann.height;
          const start = { x: x1, y: ph - y1 };
          const end = { x: x2, y: ph - y2 };
          page.drawLine({
            start,
            end,
            thickness: ann.strokeWidth,
            color: stroke,
            opacity: ann.opacity,
          });

          if (ann.shape === "arrow") {
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const head = Math.max(8, ann.strokeWidth * 4);
            for (const spread of [Math.PI * 0.82, -Math.PI * 0.82]) {
              page.drawLine({
                start: end,
                end: {
                  x: end.x + head * Math.cos(angle + spread),
                  y: end.y + head * Math.sin(angle + spread),
                },
                thickness: ann.strokeWidth,
                color: stroke,
                opacity: ann.opacity,
              });
            }
          }
          break;
        }

        case "markup": {
          const color = hex(ann.color);
          if (ann.markup === "highlight") {
            page.drawRectangle({
              x: ann.x,
              y: bottom,
              width: ann.width,
              height: ann.height,
              color,
              opacity: ann.opacity,
            });
          } else {
            // Underline sits at the baseline, strikeout through the middle.
            const y =
              ann.markup === "underline" ? bottom + 1 : bottom + ann.height / 2;
            page.drawLine({
              start: { x: ann.x, y },
              end: { x: ann.x + ann.width, y },
              thickness: Math.max(1, ann.height * 0.08),
              color,
              opacity: ann.opacity,
            });
          }
          break;
        }

        case "link": {
          const r = userRect(ann.x, bottom, ann.width, ann.height);
          const rect = [r.x, r.y, r.x + r.width, r.y + r.height];
          const action =
            ann.targetPage !== null && pages[ann.targetPage]
              ? {
                  Type: "Action",
                  S: "GoTo",
                  D: [pages[ann.targetPage].ref, PDFName.of("Fit")],
                }
              : {
                  Type: "Action",
                  S: "URI",
                  URI: PDFString.of(ann.url || "https://example.com"),
                };
          addRawAnnotation(doc, page, {
            Type: "Annot",
            Subtype: "Link",
            Rect: rect,
            Border: [0, 0, 0],
            A: action,
          });
          // A faint underline so the link is discoverable in print too.
          page.drawLine({
            start: { x: ann.x, y: bottom },
            end: { x: ann.x + ann.width, y: bottom },
            thickness: 0.75,
            color: rgb(0.23, 0.35, 0.9),
            opacity: 0.7,
          });
          break;
        }

        case "field": {
          const opts = userRect(ann.x, bottom, ann.width, ann.height);
          // On rotated pages the widget's contents must turn with the page
          // (/MK /R). pdf-lib's own `rotate` option also turns the rectangle,
          // which would move the field, so set it on the widget instead.
          const upright = (f: PDFField) => {
            if (!frame.rotation) return;
            for (const w of f.acroField.getWidgets()) {
              if (w.P() === page.ref || !w.P()) w.getOrCreateAppearanceCharacteristics().setRotation(frame.rotation);
            }
            form.markFieldAsDirty(f.ref);
          };
          try {
            if (ann.field === "text") {
              const f = form.createTextField(uniqueName(ann.name));
              if (ann.value) f.setText(safeText(ann.value));
              // The widget must exist before the font size is applied — setting
              // it first makes pdf-lib throw and leaves a field with no widget.
              f.addToPage(page, { ...opts, font: helvetica });
              try {
                f.setFontSize(ann.fontSize);
              } catch {
                // Keep the default size rather than losing the field.
              }
              upright(f);
            } else if (ann.field === "checkbox") {
              const f = form.createCheckBox(uniqueName(ann.name));
              f.addToPage(page, opts);
              if (ann.value === "true") f.check();
              upright(f);
            } else if (ann.field === "dropdown") {
              const f = form.createDropdown(uniqueName(ann.name));
              f.setOptions(ann.options.length ? ann.options : ["Option 1"]);
              if (ann.value) f.select(ann.value);
              f.addToPage(page, { ...opts, font: helvetica });
              upright(f);
            } else {
              // Radio buttons sharing a name belong to one group.
              let group = radioGroups.get(ann.name);
              if (!group) {
                group = form.createRadioGroup(uniqueName(ann.name));
                radioGroups.set(ann.name, group);
              }
              const option = ann.value || `Option ${group.getOptions().length + 1}`;
              group.addOptionToPage(option, page, opts);
              upright(group);
            }
            createdFields = true;
          } catch {
            // A field name collision or malformed form should not kill the export.
          }
          break;
        }
      }
    }

    if (transformed) page.pushOperators(popGraphicsState());
  }

  if (createdFields) {
    try {
      form.updateFieldAppearances(helvetica);
    } catch {
      // Appearance generation is best-effort; viewers regenerate on open.
    }
  }

  if (options.watermark) await stampWatermark(doc, helvetica);

  return doc.save();
}

/** Rotate a set of pages by a relative angle. */
export async function rotatePagesBy(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[],
  delta: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const targets = new Set(pageIndices);
  doc.getPages().forEach((page, i) => {
    if (targets.has(i)) {
      page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360));
    }
  });
  return doc.save();
}

/** Insert a blank page of the same size after the given index. */
export async function insertBlankPage(
  bytes: ArrayBuffer | Uint8Array,
  afterIndex: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const reference = doc.getPages()[afterIndex] ?? doc.getPages()[0];
  // Match the page as displayed: a portrait page shown landscape via /Rotate
  // gets a landscape blank.
  const { width, height } = reference
    ? pageFrame(reference)
    : { width: 595.28, height: 841.89 };
  doc.insertPage(afterIndex + 1, [width, height]);
  return doc.save();
}
