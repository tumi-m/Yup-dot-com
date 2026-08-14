import {
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import type { Annotation } from "@/lib/editor/types";

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

  for (const ann of annotations) {
    const page = pages[ann.page];
    if (!page) continue;
    const ph = page.getSize().height;
    // Top-left origin -> bottom-left origin.
    const bottom = ph - ann.y - ann.height;

    switch (ann.type) {
      case "text": {
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
        const rect = [ann.x, bottom, ann.x + ann.width, bottom + ann.height];
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
        const opts = {
          x: ann.x,
          y: bottom,
          width: ann.width,
          height: ann.height,
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
          } else if (ann.field === "checkbox") {
            const f = form.createCheckBox(uniqueName(ann.name));
            f.addToPage(page, opts);
            if (ann.value === "true") f.check();
          } else if (ann.field === "dropdown") {
            const f = form.createDropdown(uniqueName(ann.name));
            f.setOptions(ann.options.length ? ann.options : ["Option 1"]);
            if (ann.value) f.select(ann.value);
            f.addToPage(page, { ...opts, font: helvetica });
          } else {
            // Radio buttons sharing a name belong to one group.
            let group = radioGroups.get(ann.name);
            if (!group) {
              group = form.createRadioGroup(uniqueName(ann.name));
              radioGroups.set(ann.name, group);
            }
            const option = ann.value || `Option ${group.getOptions().length + 1}`;
            group.addOptionToPage(option, page, opts);
          }
          createdFields = true;
        } catch {
          // A field name collision or malformed form should not kill the export.
        }
        break;
      }
    }
  }

  if (createdFields) {
    try {
      form.updateFieldAppearances(helvetica);
    } catch {
      // Appearance generation is best-effort; viewers regenerate on open.
    }
  }

  if (options.watermark) {
    for (const page of pages) {
      const { width } = page.getSize();
      const label = "Made with PDF Wizard";
      const size = 9;
      page.drawText(label, {
        x: width / 2 - helvetica.widthOfTextAtSize(label, size) / 2,
        y: 16,
        size,
        font: helvetica,
        color: rgb(0.6, 0.6, 0.6),
        opacity: 0.6,
      });
    }
  }

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
  const { width, height } = reference
    ? reference.getSize()
    : { width: 595.28, height: 841.89 };
  doc.insertPage(afterIndex + 1, [width, height]);
  return doc.save();
}
