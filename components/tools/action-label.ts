/**
 * The workbench's main button: what pressing it does, in the tool's own
 * words, as the tools with their own panels say (Compare PDFs, Redact PDF,
 * Make PDF, Convert to PDF). A tool missing here says "Cast spell".
 */
const ACTION: Record<string, string> = {
  "merge-pdf": "Merge PDFs",
  "split-pdf": "Split PDF",
  "rotate-pdf": "Rotate pages",
  "resize-pdf": "Resize pages",
  "repair-pdf": "Repair PDF",
  "pdf-to-pdfa": "Convert to PDF/A",
  "compress-pdf": "Compress PDF",
  "compress-video": "Compress video",
  "pdf-to-jpg": "Convert to JPG",
  "jpg-to-pdf": "Convert to PDF",
  "png-to-pdf": "Convert to PDF",
  "webp-to-pdf": "Convert to PDF",
  "heic-to-pdf": "Convert to PDF",
  "tiff-to-pdf": "Convert to PDF",
  "svg-to-pdf": "Convert to PDF",
  "txt-to-pdf": "Convert to PDF",
  "markdown-to-pdf": "Convert to PDF",
  "pdf-to-text": "Convert to text",
  "pdf-to-markdown": "Convert to Markdown",
  "extract-tables": "Extract tables",
  "pdf-to-chunks": "Make chunks",
  "pdf-to-word": "Convert to Word",
  "pdf-to-pptx": "Convert to PPTX",
  "pdf-to-excel": "Convert to Excel",
  "ocr-pdf": "Make searchable",
  "protect-pdf": "Protect PDF",
  "unlock-pdf": "Unlock PDF",
  "flatten-pdf": "Flatten PDF",
  "page-numbers": "Add page numbers",
  "watermark-pdf": "Add watermark",
};

export function actionLabel(slug: string): string {
  return ACTION[slug] ?? "Cast spell";
}
