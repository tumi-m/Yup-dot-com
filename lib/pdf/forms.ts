import {
  PDFBool,
  PDFCheckBox,
  PDFDocument,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFFont,
  type PDFForm,
  type PDFField,
  type PDFRef,
  type PDFWidgetAnnotation,
} from "pdf-lib";
import { openPdf } from "./open";
import { renderTextImage } from "./text-image";
import { pageFrame, type PageFrame } from "./page-frame";

/** Draws text as a picture, in points: `renderTextImage`'s shape. */
export type TextPainter = (
  text: string,
  fontSize: number,
  color: string,
  bold: boolean,
  maxWidth: number,
  maxHeight?: number
) => Promise<{ png: Uint8Array; width: number; height: number } | null>;

/**
 * Draws each field that needs it in `font`. A value the font can't draw
 * (Helvetica covers Latin-1 and ’ “ ” – — €, not Arabic, Greek or Cyrillic)
 * is drawn as a picture of the text in the field's picture, so every reader
 * shows it and flattening can paint it. Where that isn't possible (no canvas,
 * a list box) readers are asked to draw the field themselves
 * (NeedAppearances). Save with `updateFieldAppearances: false` afterwards,
 * or pdf-lib draws them again and fails on the same letters.
 */
export async function drawFields(
  form: PDFForm,
  font: PDFFont,
  paint: TextPainter | null = typeof document !== "undefined" ? renderTextImage : null
) {
  let undrawn = false;
  try {
    for (const field of form.getFields()) {
      try {
        if (field.needsAppearancesUpdate()) field.defaultUpdateAppearances(font);
      } catch {
        if (paint && (await drawAsPicture(form, field, paint))) continue;
        undrawn = true;
        // Its old picture would show the old value.
        for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of("AP"));
      }
    }
  } catch {
    // A malformed form: readers draw it as they can.
    undrawn = true;
  }
  if (undrawn) form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
}

/** The colour a /DA sets (`g` or `rg`), as #rrggbb. */
function daColor(da: string | undefined): string {
  const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  const rgbMatch = da && /(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s+rg/.exec(da);
  if (rgbMatch) return `#${hex2(+rgbMatch[1])}${hex2(+rgbMatch[2])}${hex2(+rgbMatch[3])}`;
  const grey = da && /(\d*\.?\d+)\s+g(?![a-z])/.exec(da);
  if (grey) return `#${hex2(+grey[1]).repeat(3)}`;
  return "#000000";
}

/**
 * Sets a text field's or dropdown's picture to an image of its value, turned
 * as the widget asks (/MK /R). False when the field isn't one of those.
 */
async function drawAsPicture(form: PDFForm, field: PDFField, paint: TextPainter): Promise<boolean> {
  let text: string;
  let multiline = false;
  if (field instanceof PDFTextField) {
    text = field.getText() ?? "";
    multiline = field.isMultiline();
  } else if (field instanceof PDFDropdown) {
    text = field.getSelected()[0] ?? "";
  } else {
    return false;
  }
  if (!multiline) text = text.replace(/\s*\n\s*/g, " ");
  const doc = form.doc;
  const pad = 2;
  for (const widget of field.acroField.getWidgets()) {
    const rect = widget.getRectangle();
    let turn = 0;
    let background: number[] | undefined;
    let border: number[] | undefined;
    let borderWidth = 1;
    try {
      const mk = widget.getAppearanceCharacteristics();
      turn = mk?.getRotation() ?? 0;
      background = mk?.getBackgroundColor();
      border = mk?.getBorderColor();
      borderWidth = widget.getBorderStyle()?.getWidth() ?? 1;
    } catch {
      // Upright, with no box drawn round it.
    }
    turn = (((Math.round(turn / 90) * 90) % 360) + 360) % 360;
    const sideways = turn === 90 || turn === 270;
    // The field's own box, before it is turned.
    const w = sideways ? rect.height : rect.width;
    const h = sideways ? rect.width : rect.height;
    const da = defaultAppearance(form, field, widget);
    const size = fieldFontSize(da, h);
    const image = text && w > 0 && h > 0
      ? await paint(text, size, daColor(da), false, multiline ? Math.max(1, w - 2 * pad) : 1e5, multiline ? h - 2 * pad : undefined)
      : null;
    if (text && w > 0 && h > 0 && !image) return false;
    const ops: string[] = [];
    // Own box -> the widget's rectangle, turned counter-clockwise by /MK /R.
    const turnMatrix =
      turn === 90 ? [0, 1, -1, 0, rect.width, 0]
      : turn === 180 ? [-1, 0, 0, -1, rect.width, rect.height]
      : turn === 270 ? [0, -1, 1, 0, 0, rect.height]
      : null;
    let picture: PDFRef | undefined;
    // The field's own background and border, as other readers draw them.
    const fillOp = colorOp(background, false);
    const strokeOp = colorOp(border, true);
    if (fillOp) ops.push("q", fillOp, `0 0 ${n(rect.width)} ${n(rect.height)} re f`, "Q");
    if (strokeOp && borderWidth > 0) {
      const b = borderWidth / 2;
      ops.push("q", strokeOp, `${n(borderWidth)} w`, `${n(b)} ${n(b)} ${n(rect.width - borderWidth)} ${n(rect.height - borderWidth)} re S`, "Q");
    }
    if (image) {
      picture = (await doc.embedPng(image.png)).ref;
      // One line sits in the middle, several start at the top.
      const y = multiline ? h - pad - image.height : (h - image.height) / 2;
      ops.push("/Tx BMC", "q");
      if (turnMatrix) ops.push(`${turnMatrix.join(" ")} cm`);
      ops.push(`${n(image.width)} 0 0 ${n(image.height)} ${pad} ${n(y)} cm`, "/Im Do", "Q", "EMC");
    }
    const appearance = doc.context.register(
      doc.context.stream(ops.join("\n"), {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, rect.width, rect.height],
        Resources: picture ? { XObject: { Im: picture } } : {},
      })
    );
    widget.dict.set(PDFName.of("AP"), doc.context.obj({ N: appearance }));
  }
  form.markFieldAsClean(field.ref);
  return true;
}

/** A /MK colour (grey, RGB or CMYK) as a fill or stroke operator. */
function colorOp(c: number[] | undefined, stroke: boolean): string | undefined {
  const v = c?.map(n).join(" ");
  if (c?.length === 1) return `${v} ${stroke ? "G" : "g"}`;
  if (c?.length === 3) return `${v} ${stroke ? "RG" : "rg"}`;
  if (c?.length === 4) return `${v} ${stroke ? "K" : "k"}`;
  return undefined;
}

/** A number for a content stream: short, never in exponent form. */
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** A user-space rectangle as a top-left-origin box on the displayed page. */
function displayRect(frame: PageFrame, r: { x: number; y: number; width: number; height: number }) {
  const a = frame.toDisplay(r.x, r.y);
  const b = frame.toDisplay(r.x + r.width, r.y + r.height);
  return {
    x: Math.min(a.u, b.u),
    y: frame.height - Math.max(a.v, b.v), // bottom-left -> top-left origin
    width: Math.abs(b.u - a.u),
    height: Math.abs(b.v - a.v),
  };
}

export type DetectedFieldKind =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "unsupported";

/** An interactive form field already present in an uploaded PDF. */
export interface DetectedField {
  /** Unique per widget — a radio group contributes one entry per option. */
  id: string;
  name: string;
  /** What the PDF says the field is for (its /TU tooltip), for screen readers. */
  label?: string;
  kind: DetectedFieldKind;
  page: number;
  /** Top-left origin, PDF points. */
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
  options: string[];
  /** For radio widgets: which option this particular button selects. */
  exportValue?: string;
  /** Text fields: the most characters the field takes. */
  maxLength?: number;
  /** Text fields that take several lines. */
  multiline?: boolean;
  /** Password fields: what is typed is never stored in the file, nor shown. */
  password?: boolean;
  /** The text size the field asks for (its /DA), or one that fits its height, in points. */
  fontSize: number;
  /**
   * How far its contents are turned on screen, clockwise: 0, 90, 180 or 270.
   * A field on a turned page turns with it, unless the field turns back (/MK /R).
   */
  rotation: number;
  readOnly: boolean;
}

/** The last `/Font size Tf` in a /DA string; 0 means "fit the box". */
export function daFontSize(da: string | undefined): number | undefined {
  const m = da && /\/[^\s/]+\s+(-?\d*\.?\d+)\s+Tf(?![\s\S]*Tf)/.exec(da);
  if (!m) return undefined;
  const size = Number(m[1]);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/** A widget's /DA: its own, its field's, a parent's, or the form's. */
function defaultAppearance(form: PDFForm, field: PDFField, widget: PDFWidgetAnnotation): string | undefined {
  try {
    const own = form.acroForm.dict.lookup(PDFName.of("DA"));
    return (
      widget.getDefaultAppearance() ??
      field.acroField.getDefaultAppearance() ??
      field.acroField.getParent()?.getDefaultAppearance() ??
      (own instanceof PDFString || own instanceof PDFHexString ? own.decodeText() : undefined)
    );
  } catch {
    return undefined;
  }
}

/** The size to show a field's text at: what its /DA asks for, or what fits its height. */
export function fieldFontSize(da: string | undefined, height: number): number {
  const size = daFontSize(da);
  return size ? size : Math.max(1, Math.min(height * 0.6, 12));
}

function kindOf(field: unknown): DetectedFieldKind {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    return "dropdown";
  return "unsupported";
}

/** A field's /TU text, or its parent's: the name forms give people, not code. */
function alternateName(field: PDFField): string | undefined {
  const read = (dict: PDFDict | undefined) => {
    const tu = dict?.lookup(PDFName.of("TU"));
    if (!(tu instanceof PDFString || tu instanceof PDFHexString)) return undefined;
    return tu.decodeText().replace(/\s+/g, " ").trim() || undefined;
  };
  try {
    return read(field.acroField.dict) ?? read(field.acroField.getParent()?.dict);
  } catch {
    return undefined;
  }
}

/**
 * Finds the fillable fields in a PDF and where their widgets sit on the page,
 * so the editor can overlay real inputs on top of them.
 */
export async function detectFormFields(
  bytes: ArrayBuffer | Uint8Array
): Promise<DetectedField[]> {
  let doc: PDFDocument;
  try {
    doc = await openPdf(bytes);
  } catch {
    return [];
  }

  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    return [];
  }
  if (!fields.length) return [];

  const pages = doc.getPages();
  // Map each annotation dictionary to the page it belongs to.
  const pageOfDict = new Map<PDFDict, number>();
  pages.forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const resolved = doc.context.lookup(annots.get(i));
      if (resolved instanceof PDFDict) pageOfDict.set(resolved, index);
    }
  });

  const detected: DetectedField[] = [];
  const form = doc.getForm();

  for (const field of fields) {
    const kind = kindOf(field);
    if (kind === "unsupported") continue;

    const name = field.getName();
    const label = alternateName(field);
    let value = "";
    let options: string[] = [];
    let maxLength: number | undefined;
    let multiline = false;
    let password = false;

    try {
      if (field instanceof PDFTextField) {
        password = field.isPassword();
        value = password ? "" : field.getText() ?? "";
        maxLength = field.getMaxLength();
        multiline = field.isMultiline();
      } else if (field instanceof PDFCheckBox) value = field.isChecked() ? "true" : "";
      else if (field instanceof PDFRadioGroup) {
        value = field.getSelected() ?? "";
        options = field.getOptions();
      } else if (field instanceof PDFDropdown) {
        value = field.getSelected()[0] ?? "";
        options = field.getOptions();
      } else if (field instanceof PDFOptionList) {
        value = field.getSelected()[0] ?? "";
        options = field.getOptions();
      }
    } catch {
      // Unreadable value — present the field empty rather than dropping it.
    }

    const readOnly = (() => {
      try {
        return field.isReadOnly();
      } catch {
        return false;
      }
    })();

    const widgets = field.acroField.getWidgets();
    widgets.forEach((widget, i) => {
      const pageIndex = pageOfDict.get(widget.dict);
      if (pageIndex === undefined) return;
      // Positions are reported on the page as displayed (crop box, /Rotate).
      const frame = pageFrame(pages[pageIndex]);

      let rect;
      try {
        rect = widget.getRectangle();
      } catch {
        return;
      }

      // A radio widget's own on-state is its export value.
      let exportValue: string | undefined;
      if (kind === "radio") exportValue = options[i];
      const shown = displayRect(frame, rect);
      let own = 0;
      try {
        own = widget.getAppearanceCharacteristics()?.getRotation() ?? 0;
      } catch {
        // No /MK: the contents are upright in the field.
      }
      own = (((Math.round(own / 90) * 90) % 360) + 360) % 360;
      // Turned a quarter, the field's own height runs across the rectangle.
      const height = own === 90 || own === 270 ? rect.width : rect.height;

      detected.push({
        id: `${name}::${i}`,
        name,
        label,
        kind,
        page: pageIndex,
        ...shown,
        value,
        options,
        exportValue,
        maxLength,
        multiline,
        password,
        fontSize: fieldFontSize(defaultAppearance(form, field, widget), height),
        rotation: (frame.rotation - own + 360) % 360,
        readOnly,
      });
    });
  }

  return detected;
}

/**
 * Writes values back into an existing AcroForm.
 * `values` is keyed by field name (not widget id).
 */
export async function fillFormFields(
  bytes: ArrayBuffer | Uint8Array,
  values: Record<string, string>,
  opts: { flatten?: boolean } = {}
): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const [name, value] of Object.entries(values)) {
    let field;
    try {
      field = form.getField(name);
    } catch {
      continue;
    }
    try {
      if (field instanceof PDFTextField) {
        // A password is for this session only: PDF forms don't store one.
        if (field.isPassword()) continue;
        // The value as typed, in any script. Keep what fits: a value over the
        // field's limit would be dropped whole. Never half an emoji.
        const max = field.getMaxLength();
        field.setText(max === undefined ? value : value.slice(0, max).replace(/[\uD800-\uDBFF]$/, ""));
      } else if (field instanceof PDFCheckBox) {
        if (value === "true") field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(value);
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        // "—" in the editor: nothing chosen.
        if (value) field.select(value);
        else field.clear();
      }
    } catch {
      // Skip values the field rejects (e.g. an option that no longer exists).
    }
  }

  await drawFields(form, font);

  if (opts.flatten) {
    try {
      form.flatten();
    } catch {
      // Leave the form interactive if flattening is not possible.
    }
  }

  return doc.save({ updateFieldAppearances: false });
}
