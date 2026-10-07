import { parseMediaUrl, parsePlaylistUrl, maxHeightFor } from "../lib/media.ts";

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
  // A link to one video of a post keeps which one.
  [`https://twitter.com/tester/status/33333/video/3`, `https://x.com/i/status/33333/video/3`],
  [`https://x.com/tester/status/1790866466429911046/photo/2`, `https://x.com/i/status/1790866466429911046/video/2`],
  [`https://x.com/tester/status/1790866466429911046/video/1?s=20`, `https://x.com/i/status/1790866466429911046/video/1`],
  [`https://x.com/tester/status/1790866466429911046/video/0`, `https://x.com/i/status/1790866466429911046`],
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
// Playlists: [input, canonical playlist URL or null, video id or null]
const PL = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
const LIST = `https://www.youtube.com/playlist?list=${PL}`;
const playlistCases: [string, string | null, string | null][] = [
  [`https://www.youtube.com/playlist?list=${PL}`, LIST, null],
  [`youtube.com/playlist?list=${PL}&si=xyz`, LIST, null],
  [`https://music.youtube.com/playlist?list=${PL}`, LIST, null],
  [`https://m.youtube.com/playlist?list=${PL}`, LIST, null],
  [`https://www.youtube.com/watch?v=${ID}&list=${PL}&index=3`, LIST, ID],
  [`https://youtu.be/${ID}?list=${PL}`, LIST, ID],
  [`https://www.youtube.com/watch?list=${PL}`, LIST, null],
  [`https://www.youtube.com/watch?v=${ID}&list=RD${ID}`, `https://www.youtube.com/playlist?list=RD${ID}`, ID],
  [`https://www.youtube.com/playlist?list=OLAK5uy_kE8w7Ga4wFJbM1W3xq_dZ8uLzXQYfz2Kg`, `https://www.youtube.com/playlist?list=OLAK5uy_kE8w7Ga4wFJbM1W3xq_dZ8uLzXQYfz2Kg`, null],
  // Must be rejected:
  [`https://www.youtube.com/watch?v=${ID}`, null, null],
  [`https://www.youtube.com/playlist?list=WL`, null, null],
  [`https://www.youtube.com/playlist?list=LL`, null, null],
  [`https://www.youtube.com/playlist?list=PL<script>alert(1)</script>`, null, null],
  [`https://www.youtube.com/playlist?list=PL%2F..%2F..%2Fetc`, null, null],
  [`https://www.youtube.com/playlist?list=${"A".repeat(65)}`, null, null],
  [`https://www.youtube.com/playlist`, null, null],
  [`https://www.youtube.com/@channel?list=${PL}`, null, null],
  [`https://youtube.com.evil.com/playlist?list=${PL}`, null, null],
  [`https://evil.com/playlist?list=${PL}`, null, null],
  [`https://x.com/NASA/status/1790866466429911046?list=${PL}`, null, null],
];
for (const [input, expected, video] of playlistCases) {
  const got = parsePlaylistUrl(input);
  if ((got?.canonical ?? null) === expected && (got?.video?.id ?? null) === video) pass++;
  else console.log(`FAIL  playlist ${input}  → ${JSON.stringify(got)}  (expected ${expected}, video ${video})`);
}
// A playlist-only link is not a single video.
const playlistOnlyRejected = parseMediaUrl(`https://www.youtube.com/playlist?list=${PL}`) === null;
if (!playlistOnlyRejected) console.log("FAIL  playlist-only link parsed as a video");
const total = cases.length + playlistCases.length;

const tiers = maxHeightFor("guest") === 720 && maxHeightFor("free") === 720 && maxHeightFor("pro") === 1080 && maxHeightFor("team") === 1080;
const ok = pass === total && tiers && playlistOnlyRejected;
console.log(ok ? `PASS: ${pass}/${total} link shapes parsed or rejected correctly; 1080p gated to Pro` : "FAIL");
process.exit(ok ? 0 : 1);
