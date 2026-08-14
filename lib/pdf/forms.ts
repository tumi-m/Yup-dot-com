import {
  PDFCheckBox,
  PDFDocument,
  PDFDict,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
} from "pdf-lib";

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
  readOnly: boolean;
}

function kindOf(field: unknown): DetectedFieldKind {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    return "dropdown";
  return "unsupported";
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
    doc = await PDFDocument.load(bytes);
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

  for (const field of fields) {
    const kind = kindOf(field);
    if (kind === "unsupported") continue;

    const name = field.getName();
    let value = "";
    let options: string[] = [];

    try {
      if (field instanceof PDFTextField) value = field.getText() ?? "";
      else if (field instanceof PDFCheckBox) value = field.isChecked() ? "true" : "";
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
      const page = pages[pageIndex];
      const ph = page.getSize().height;

      let rect;
      try {
        rect = widget.getRectangle();
      } catch {
        return;
      }

      // A radio widget's own on-state is its export value.
      let exportValue: string | undefined;
      if (kind === "radio") exportValue = options[i];

      detected.push({
        id: `${name}::${i}`,
        name,
        kind,
        page: pageIndex,
        x: rect.x,
        y: ph - rect.y - rect.height, // bottom-left -> top-left origin
        width: rect.width,
        height: rect.height,
        value,
        options,
        exportValue,
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
  const doc = await PDFDocument.load(bytes);
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
        field.setText(value.replace(/[^\x00-\xFF]/g, "?"));
      } else if (field instanceof PDFCheckBox) {
        if (value === "true") field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(value);
      } else if (field instanceof PDFDropdown) {
        if (value) field.select(value);
      } else if (field instanceof PDFOptionList) {
        if (value) field.select(value);
      }
    } catch {
      // Skip values the field rejects (e.g. an option that no longer exists).
    }
  }

  try {
    form.updateFieldAppearances(font);
  } catch {
    // Best effort — most viewers regenerate appearances themselves.
  }

  if (opts.flatten) {
    try {
      form.flatten();
    } catch {
      // Leave the form interactive if flattening is not possible.
    }
  }

  return doc.save();
}
