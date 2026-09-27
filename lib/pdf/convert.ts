import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import JSZip from "jszip";
import type { ParsedDocument, TableBlock } from "./parse";

/**
 * Structured conversions built on the layout-aware parser.
 *
 * Unlike a text dump, headings become real Word heading styles (so the
 * navigation pane and table of contents work), lists become real lists, and
 * tables become real tables. This targets editable *content*, not a
 * pixel-perfect replica of the page layout.
 */

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };

function wordTable(table: TableBlock): Table {
  const columns = Math.max(1, ...table.rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: table.rows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          children: Array.from({ length: columns }, (_, c) =>
            new TableCell({
              borders: {
                top: CELL_BORDER,
                bottom: CELL_BORDER,
                left: CELL_BORDER,
                right: CELL_BORDER,
              },
              shading: rowIndex === 0 ? { fill: "EDE9FE" } : undefined,
              children: [
                new Paragraph({
                  children: [new TextRun({ text: row[c] ?? "", bold: rowIndex === 0 })],
                }),
              ],
            })
          ),
        })
    ),
  });
}

export function buildDocx(doc: ParsedDocument, title?: string): Document {
  const children: (Paragraph | Table)[] = [];
  let listInstance = 0;

  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        children.push(
          new Paragraph({
            heading: HEADINGS[Math.min(5, block.level - 1)],
            children: [new TextRun(block.text)],
          })
        );
        break;
      case "paragraph":
        children.push(
          new Paragraph({
            style: "Normal",
            spacing: { after: 160 },
            children: [new TextRun(block.text)],
          })
        );
        break;
      case "list":
        // Each ordered list gets its own instance so numbering restarts at 1.
        listInstance++;
        for (const item of block.items) {
          children.push(
            new Paragraph({
              children: [new TextRun(item)],
              ...(block.ordered
                ? { numbering: { reference: "ordered", level: 0, instance: listInstance } }
                : { bullet: { level: 0 } }),
            })
          );
        }
        break;
      case "table":
        children.push(wordTable(block));
        children.push(new Paragraph({ style: "Normal", children: [] }));
        break;
    }
  }

  if (!children.length) {
    children.push(new Paragraph({ style: "Normal", children: [new TextRun("")] }));
  }

  return new Document({
    title: title ?? "Converted document",
    creator: "PDF Wizard",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      // Declared explicitly: some readers treat an undefined default style as
      // "no style", which strips formatting from every body paragraph.
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
}

export async function toDocxBlob(doc: ParsedDocument, title?: string): Promise<Blob> {
  return Packer.toBlob(buildDocx(doc, title));
}

export async function toDocxBytes(doc: ParsedDocument, title?: string): Promise<Uint8Array> {
  return new Uint8Array(await Packer.toArrayBuffer(buildDocx(doc, title)));
}

// ---------------------------------------------------------------------------
// Excel (.xlsx), one worksheet per detected table.
// Written directly as SpreadsheetML over JSZip to avoid a ~1 MB dependency.
// ---------------------------------------------------------------------------

function xmlEscape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Strip control characters that are illegal in XML 1.0.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function columnName(index: number) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * Returns a number for cells that are unambiguously numeric ("1,900,000",
 * "-3.5", "(120)" accounting negatives) so spreadsheets can sum them.
 * Percentages and currency stay as text to avoid silently changing meaning.
 */
export function parseNumeric(cell: string): number | null {
  const s = cell.trim();
  if (!/^\(?-?\d{1,3}(,\d{3})*(\.\d+)?\)?$|^\(?-?\d+(\.\d+)?\)?$/.test(s)) return null;
  const negative = s.startsWith("(") && s.endsWith(")");
  const n = Number(s.replace(/[(),]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function sheetXml(table: TableBlock) {
  const rows = table.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          const num = r === 0 ? null : parseNumeric(cell);
          if (num !== null) return `<c r="${ref}"><v>${num}</v></c>`;
          const style = r === 0 ? ' s="1"' : "";
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

export async function tablesToXlsx(tables: TableBlock[]): Promise<Uint8Array> {
  if (!tables.length) throw new Error("No tables to export.");
  const zip = new JSZip();
  const names = tables.map((t, i) => `Table ${i + 1} (p${t.page})`.slice(0, 31));

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      tables
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("") +
      `</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      names
        .map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      `</sheets></workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      tables
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join("") +
      `<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`
  );
  // Style 1 = bold header row.
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
      // A named default style: strict readers warn (or repair) without it.
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
  );
  tables.forEach((t, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t)));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
