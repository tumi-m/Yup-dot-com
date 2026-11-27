/**
 * The copy under Word to PDF and Excel to PDF: how it works, and questions
 * people ask. Plain data, so tests can check what the pages promise.
 */
import { LIMITS, formatLimitBytes } from "@/lib/limits";
import type { OfficeTool } from "@/lib/office";

export interface OfficeCopy {
  heading: string;
  steps: [string, string][];
  faq: { q: string; a: string }[];
}

const UPLOAD = {
  q: "Is my file uploaded?",
  a: "Yes. Unlike most of our tools, which work in your browser, this one sends your file to our conversion server, because laying out a Word or Excel file faithfully needs a full office suite (LibreOffice). It is converted straight away, and the file and the PDF are deleted as soon as the PDF is sent back to you, or at once if converting fails or you cancel. We don't keep them, read them or use them for anything else. Don't upload documents you aren't allowed to share with a service provider.",
};

const ALLOWANCE = {
  q: "How many files can I convert?",
  a: `As a guest, ${LIMITS.guest.officeConversionsPerDay} a day, up to ${formatLimitBytes(LIMITS.guest.officeMaxBytes)} each. With a free account, ${LIMITS.free.officeConversionsPerDay} a day. With Pro or Team, ${LIMITS.pro.officeConversionsPerDay} a day, up to ${formatLimitBytes(LIMITS.pro.officeMaxBytes)} each. A file we turn away, or one that fails to convert, isn't counted.`,
};

const REFUSED = {
  q: "Which files are turned away?",
  a: "Password-protected files (remove the password and save first), files with macros (.docm, .xlsm: save as .docx or .xlsx without them), files whose name doesn't match what they are, and damaged files. Each says why. Macros never run, and links to other files or websites aren't followed.",
};

export const OFFICE_COPY: Record<OfficeTool, OfficeCopy> = {
  "word-to-pdf": {
    heading: "Turn a Word document into a PDF",
    steps: [
      ["Choose a Word file", ".docx, .doc, .odt or .rtf."],
      ["Convert", "It's uploaded, laid out by LibreOffice on our server, and deleted straight after."],
      ["Download", "A PDF with its fonts embedded, headings as bookmarks and tagged for screen readers."],
    ],
    faq: [
      UPLOAD,
      {
        q: "Will it look the same as in Word?",
        a: "Very close. We use fonts made to the same widths as Microsoft's (Calibri, Cambria, Arial, Times New Roman and Courier New), so lines and pages break in the same places. Other fonts are swapped for a near match. Complex layouts, such as text wrapped around pictures or SmartArt, can shift a little.",
      },
      {
        q: "What about comments and tracked changes?",
        a: "Comments aren't printed. Tracked changes come out as the document shows them.",
      },
      REFUSED,
      ALLOWANCE,
    ],
  },
  "excel-to-pdf": {
    heading: "Turn a spreadsheet into a PDF",
    steps: [
      ["Choose a spreadsheet", ".xlsx, .xls, .ods or .csv."],
      ["Pick the page setup", "Fit each sheet to the page's width, the orientation, and all sheets or the first."],
      ["Download", "It's converted on our server and deleted straight after. Fonts are embedded."],
    ],
    faq: [
      UPLOAD,
      {
        q: "What do the options do?",
        a: "Fit width shrinks a wide sheet so its columns fit across one page, with as many pages down as it needs; a narrow sheet is never enlarged. Automatic orientation turns a sheet wider than a portrait page sideways, and keeps a sheet set to landscape in the file. A print area set in the file is kept. Hidden sheets are left out.",
      },
      {
        q: "Are formulas recalculated?",
        a: "No. The values the spreadsheet was last saved with are printed, as in the file.",
      },
      {
        q: "What about CSV files?",
        a: "Every value prints exactly as written, so leading zeros and dates stay as they are. Columns are sized to their values, long ones wrap, and cells have lines. Commas, semicolons, tabs and UTF-8 or Windows text all work.",
      },
      {
        q: "Is there a size limit for sheets?",
        a: "A sheet with more than a million filled cells (about 2,000 pages) is turned away. Set a print area or split it first.",
      },
      REFUSED,
      ALLOWANCE,
    ],
  },
};
