/**
 * Word and Excel to PDF, shared by their page and /api/convert/link. The
 * conversion runs on the media worker with LibreOffice
 * (media-worker/office.py), so these two tools upload the file, unlike the
 * rest of the site. No imports: the page loads this with itself.
 *
 * Hidden until the worker converts: set NEXT_PUBLIC_ENABLE_OFFICE_CONVERT=1
 * (with MEDIA_WORKER_URL and MEDIA_WORKER_SECRET) and redeploy.
 */
export const OFFICE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_OFFICE_CONVERT === "1";

export type OfficeTool = "word-to-pdf" | "excel-to-pdf";
export const OFFICE_TOOLS: readonly OfficeTool[] = ["word-to-pdf", "excel-to-pdf"];

/** What each tool takes, in the order the page names them. */
export const OFFICE_FORMATS: Record<OfficeTool, readonly string[]> = {
  "word-to-pdf": ["docx", "doc", "odt", "rtf"],
  "excel-to-pdf": ["xlsx", "xls", "ods", "csv"],
};

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
};

/** The file input's accept list: extensions, and types for pickers that go by type. */
export function officeAccept(tool: OfficeTool): string {
  return OFFICE_FORMATS[tool].flatMap((ext) => [`.${ext}`, MIME[ext]]).join(",");
}

/** "Report.Final.DOCX" → "docx". */
export function officeExtension(name: string): string | null {
  return /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1].toLowerCase() ?? null;
}

/** The tool that takes this file, by its name. */
export function officeToolFor(name: string): OfficeTool | null {
  const ext = officeExtension(name);
  return OFFICE_TOOLS.find((t) => ext !== null && OFFICE_FORMATS[t].includes(ext)) ?? null;
}

/** ".docx, .doc, .odt or .rtf" */
export function officeFormatList(tool: OfficeTool): string {
  const list = OFFICE_FORMATS[tool].map((e) => `.${e}`);
  return `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
}

/**
 * Why this tool can't take a file by its name, or null if it can. Said
 * before anything is uploaded; the worker checks what the file really is.
 */
export function officeTypeProblem(tool: OfficeTool, name: string): string | null {
  const ext = officeExtension(name) ?? "";
  if (OFFICE_FORMATS[tool].includes(ext)) return null;
  const other = officeToolFor(name);
  if (other) return other === "excel-to-pdf" ? "That's a spreadsheet. Use Excel to PDF." : "That's a Word file. Use Word to PDF.";
  if (ext === "docm" || ext === "dotm" || ext === "xlsm" || ext === "xltm" || ext === "xlsb") {
    const plain = ext.startsWith("d") ? ".docx" : ".xlsx";
    return `Files with macros can't be converted. Save it as ${plain} first.`;
  }
  if (ext === "pdf") return "That's already a PDF.";
  if (ext === "pptx" || ext === "ppsx" || ext === "potx") return "That's a PowerPoint file. Use PPTX to PDF.";
  if (ext === "ppt" || ext === "pps" || ext === "odp" || ext === "key") return "Save it as .pptx first, then use PPTX to PDF.";
  if (ext === "pages") return "Export it from Pages as a Word file (.docx) first.";
  if (ext === "numbers") return "Export it from Numbers as an Excel file (.xlsx) first.";
  if (ext === "txt" || ext === "md") return "That's a text file. Use TXT to PDF.";
  return `Choose a ${officeFormatList(tool)} file.`;
}

/** "Report.docx" → "Report.pdf" */
export function officePdfName(name: string): string {
  const base = name.trim().replace(/\.[a-z0-9]{1,5}$/i, "");
  return `${base || "document"}.pdf`;
}

export type SheetOrientation = "auto" | "portrait" | "landscape";

/** Excel to PDF's page setup (media-worker/office.py applies it). */
export interface SheetOptions {
  /** Shrink each sheet to the page's width (never enlarges). */
  fit: boolean;
  /** "auto": sideways when a sheet is wider than a portrait page, or set so in the file. */
  orientation: SheetOrientation;
  sheets: "all" | "first";
}

export const DEFAULT_SHEET_OPTIONS: SheetOptions = { fit: true, orientation: "auto", sheets: "all" };

/** The header the browser sends its upload grant in (CORS allows it at the worker). */
export const OFFICE_TOKEN_HEADER = "X-Convert-Token";

/**
 * What the worker's answer means for the page. Its messages are written for
 * visitors; these cover what can fail before it answers.
 */
export function workerFailure(status: number, body: { error?: unknown; code?: unknown } | null): { message: string; retry: boolean; code?: string } {
  const code = typeof body?.code === "string" ? body.code : undefined;
  const given = typeof body?.error === "string" && body.error.length <= 300 ? body.error : null;
  if (status === 0) return { message: "Lost contact with the conversion server. Check your connection and try again.", retry: false };
  // A grant that went stale before the upload started (a laptop asleep): a fresh one works.
  if (status === 401 && code === "expired") return { message: given ?? "The upload link expired. Try again.", retry: true, code };
  if (status === 401) return { message: "The conversion server rejected this site. Try again later.", retry: false, code };
  if (status === 413) return { message: given ?? "This file is too big to convert.", retry: false, code };
  // A host's own error page (a proxy, a sleeping or restarting worker) has no message.
  if (status >= 502 && status <= 504) return { message: given ?? "The conversion server is busy. Try again in a minute.", retry: false, code };
  return { message: given ?? "Couldn't convert this file.", retry: false, code };
}
