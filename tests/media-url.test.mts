import { parseMediaUrl, maxHeightFor } from "../lib/media.ts";

const ID = "dQw4w9WgXcQ";
const cases: [string, string | null][] = [
  [`https://www.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://youtube.com/watch?v=${ID}&t=42s&list=PL123`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://m.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://music.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://youtu.be/${ID}?si=abc`, `https://www.youtube.com/watch?v=${ID}`],
  [`youtu.be/${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://www.youtube.com/live/${ID}`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://x.com/NASA/status/1790866466429911046`, `https://x.com/i/status/1790866466429911046`],
  [`https://twitter.com/NASA/status/1790866466429911046?s=20`, `https://x.com/i/status/1790866466429911046`],
  [`https://mobile.twitter.com/NASA/status/1790866466429911046`, `https://x.com/i/status/1790866466429911046`],
  [`https://x.com/i/web/status/1790866466429911046`, `https://x.com/i/status/1790866466429911046`],
  // Must be rejected:
  [`https://www.youtube.com/watch?v=short`, null],
  [`https://www.youtube.com/@channel`, null],
  [`https://youtube.com.evil.com/watch?v=${ID}`, null],
  [`https://evil.com/?u=https://youtu.be/${ID}`, null],
  [`https://x.com/NASA`, null],
  [`http://169.254.169.254/latest/meta-data`, null],
  [`javascript:alert(1)`, null],
  [`not a url`, null],
];
let pass = 0;
for (const [input, expected] of cases) {
  const got = parseMediaUrl(input)?.canonical ?? null;
  if (got === expected) pass++;
  else console.log(`FAIL  ${input}  → ${got}  (expected ${expected})`);
}
const tiers = maxHeightFor("guest") === 720 && maxHeightFor("free") === 720 && maxHeightFor("pro") === 1080 && maxHeightFor("team") === 1080;
const ok = pass === cases.length && tiers;
console.log(ok ? `PASS: ${pass}/${cases.length} link shapes parsed or rejected correctly; 1080p gated to Pro` : "FAIL");
process.exit(ok ? 0 : 1);
