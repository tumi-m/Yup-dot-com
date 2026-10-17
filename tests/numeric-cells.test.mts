// PDF to Excel: only cells a number can hold unchanged become numbers.
// IDs and codes (leading zeros, long digit strings) must stay as text.
import JSZip from "jszip";
import { parseNumeric, tablesToXlsx } from "../lib/pdf/convert.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const cases: [string, number | null][] = [
  // Numbers
  ["0", 0],
  ["0.10", 0.1],
  ["-0.5", -0.5],
  ["1,900,000", 1900000],
  ["-3.5", -3.5],
  ["(120)", -120],
  ["(1,200.50)", -1200.5],
  ["123456789012345", 123456789012345],
  // Text
  ["007012", null],
  ["0123", null],
  ["0,123", null],
  ["12345678901234567890", null],
  ["1234567890123456", null],
  ["(5", null],
  ["5)", null],
  ["18%", null],
  ["12abc", null],
];
for (const [cell, want] of cases) {
  const got = parseNumeric(cell);
  check(`parseNumeric(${JSON.stringify(cell)})`, Object.is(got, want), String(got));
}

const xlsx = await tablesToXlsx([
  {
    type: "table",
    page: 1,
    rows: [
      ["Name", "Account", "Reference", "Amount"],
      ["Ann", "007012", "12345678901234567890", "(5"],
      ["Bob", "4410", "8", "(1,200.50)"],
    ],
  },
]);
const sheet = await (await JSZip.loadAsync(xlsx)).file("xl/worksheets/sheet1.xml")!.async("string");
const text = (ref: string, value: string) =>
  sheet.includes(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`);
check("account with leading zeros stays text", text("B2", "007012"));
check("20-digit reference stays text", text("C2", "12345678901234567890"));
check("unbalanced bracket stays text", text("D2", "(5"));
check("plain numbers are still numbers", sheet.includes('<c r="B3"><v>4410</v></c>') && sheet.includes('<c r="D3"><v>-1200.5</v></c>'));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll numeric cell checks passed.");
