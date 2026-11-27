/**
 * The files Translate PDF hands back: the translated document as an
 * editable Word file (lib/pdf/convert.ts buildDocx, set right to left for
 * Arabic, Hebrew, Persian and Urdu) and, where the PDF font draws the
 * language's letters, as a PDF (pdf.ts). Runs in a Web Worker
 * (off-thread.ts) or here.
 */
import { Packer } from "docx";
import { stopIfAborted } from "../../abort";
import { buildDocx } from "../convert";
import type { ParsedDocument } from "../parse";
import type { FontFiles } from "../text-to-pdf/fonts";
import { translatedPdf } from "./pdf";

export interface OutputRequest {
  doc: ParsedDocument;
  /** Shown as the files' title. */
  title: string;
  /** The translation's language (BCP 47). */
  lang: string;
  rtl: boolean;
  /** Make a PDF as well as the DOCX. */
  pdf: boolean;
  /** The file the translation came from, for messages. */
  name: string;
}

export interface Outputs {
  docx: Uint8Array;
  pdf?: Uint8Array;
  /** Letters the PDF left out, said with the result. */
  note?: string;
}

export async function buildOutputs(
  req: OutputRequest,
  fonts: FontFiles,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Outputs> {
  onProgress?.(0, "Writing the Word file");
  const docx = new Uint8Array(await Packer.toArrayBuffer(buildDocx(req.doc, req.title, { lang: req.lang, rtl: req.rtl })));
  stopIfAborted(signal);
  if (!req.pdf) return { docx };
  const pdf = await translatedPdf(
    req.doc,
    { title: req.title, lang: req.lang, name: req.name },
    fonts,
    (fraction, label) => onProgress?.(0.2 + fraction * 0.8, label === "Saving" ? label : `Laying out the PDF: ${label.toLowerCase()}`),
    signal
  );
  return { docx, pdf: pdf.bytes, note: pdf.note };
}
