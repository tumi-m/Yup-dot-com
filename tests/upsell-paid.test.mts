// A Pro or Team user who dropped a file over 500 MB (or too many files, or
// too many pages) got the upgrade dialog: "Free: 500 MB. Pro: 500 MB." and
// "Upgrade to Pro · R49/mo", for the plan they already pay for. Pro and Team
// have the same limits, so they are now told the limit, with nothing to buy,
// and other upgrade prompts don't open for them at all.
import { readFileSync } from "node:fs";
import { paidLimitNote, type UpsellReason } from "../components/upsell/Upsell.tsx";
import { LIMITS } from "../lib/limits.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

// The limits a tool checks in the browser, whatever the plan.
const LIMIT_REASONS: [UpsellReason, string][] = [
  ["file-size", "500 MB"],
  ["batch", String(LIMITS.pro.maxBatchFiles)],
  ["pages", LIMITS.pro.comparePages.toLocaleString("en-US")],
  ["redact-pages", LIMITS.pro.redactPages.toLocaleString("en-US")],
];
for (const tier of ["pro", "team"] as const) {
  const name = tier === "pro" ? "Pro" : "Team";
  for (const [reason, number] of LIMIT_REASONS) {
    const note = paidLimitNote(reason, tier);
    check(`${name}, ${reason}: told the limit on ${name}`, !!note && note.includes(number) && note.includes(`on ${name}.`), note);
    check(`${name}, ${reason}: no upgrade, no Free`, !!note && !/upgrade|free|R\d/i.test(note), note);
  }
  for (const reason of ["ai", "edits", "quality", "downloads", "samples", "save", "nudge"] as UpsellReason[]) {
    check(`${name}, ${reason}: nothing to show`, paidLimitNote(reason, tier) === null);
  }
  // Translate PDF opens these only for guests and Free; reaching Pro or Team
  // they say the day's allowance and when it comes back, never "Upgrade".
  for (const reason of ["translate", "translate-size"] as UpsellReason[]) {
    const note = paidLimitNote(reason, tier);
    check(`${name}, ${reason}: the day's characters on ${name}, and when more come`,
      note === `${LIMITS[tier].translateCharsPerDay.toLocaleString("en-US")} characters a day on ${name}. More after midnight UTC.`, note);
  }
}
for (const tier of ["guest", "free"] as const) {
  check(`${tier} still gets the upgrade at a file size limit`, paidLimitNote("file-size", tier) === null);
  check(`${tier} still gets the upgrade at the translation limit`, paidLimitNote("translate", tier) === null && paidLimitNote("translate-size", tier) === null);
}

const src = readFileSync(new URL("../components/upsell/Upsell.tsx", import.meta.url), "utf8");
check("the dialog renders nothing for Pro or Team without a note", /if \(paid && !paidNote\) return null;/.test(src));
check("and shows the note with one button instead of the plans", /paidNote \?\? copy\.body\(tier\)/.test(src) && /\{paidNote \? \(/.test(src));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll paid-plan upsell checks passed.");
