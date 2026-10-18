// The dashboard's "Updated" date was written in the server's time zone (UTC on
// most hosts) and again in the browser's: between 00:00 and 02:00 in South
// Africa the two disagreed, React threw a hydration error and the date flipped.
// It is now one fixed zone and the app's own style, "18 Oct 2026".
import { formatDate } from "../lib/utils.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

for (const zone of ["UTC", "Africa/Johannesburg", "America/Los_Angeles", "Asia/Tokyo"]) {
  process.env.TZ = zone;
  const late = formatDate("2026-10-17T23:30:00Z");
  check(`${zone}: 01:30 in Johannesburg is the 18th`, late === "18 Oct 2026", late);
  const evening = formatDate(new Date("2026-10-17T21:59:00Z"));
  check(`${zone}: 23:59 in Johannesburg is still the 17th`, evening === "17 Oct 2026", evening);
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
