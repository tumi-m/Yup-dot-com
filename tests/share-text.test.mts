// "Share via… / Copy" on a phone copies text around the link ("Check out
// @chef.anna's video! #recipe https://vm.tiktok.com/…"). The link boxes used
// to reject it.
import { linkIn, parseMediaUrl } from "../lib/media.ts";
import { mediaActions, slidesActions } from "../lib/journey.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const tiktok = "https://vm.tiktok.com/ZMh4abc12/";
check("TikTok share text", linkIn(`Check out @chef.anna's video! #recipe ${tiktok}`) === tiktok);
check("text before and after", linkIn(`Watch this ${tiktok} so good`) === tiktok);
check("on its own line", linkIn(`Look at this\n${tiktok}\n`) === tiktok);
check("full stop after the link", linkIn("See https://x.com/user/status/1790000000000000000.") === "https://x.com/user/status/1790000000000000000");
check("in brackets", linkIn("(https://www.instagram.com/reel/C1abcDEFgh/)") === "https://www.instagram.com/reel/C1abcDEFgh/");
check("query kept", linkIn("https://www.instagram.com/reel/C1abcDEFgh/?igsh=MWQ1ZGUxMzBkMA==") === "https://www.instagram.com/reel/C1abcDEFgh/?igsh=MWQ1ZGUxMzBkMA==");
check("the first link wins", linkIn(`${tiktok} https://example.com/`) === tiktok);
check("a bare link is left as it is", linkIn("  vm.tiktok.com/ZMh4abc12/ ") === "vm.tiktok.com/ZMh4abc12/");
check("no link at all", linkIn("hello there") === "hello there");

const share = `Check out @chef.anna's video! #recipe ${tiktok}`;
const actions = mediaActions(share, false);
check("homepage offers MP4 and MP3 for share text", actions.map((a) => a.label).join() === "MP4,MP3", actions);
check(
  "and passes on only the link",
  actions[0]?.href === `/tools/tiktok-to-mp4?url=${encodeURIComponent(tiktok)}`,
  actions[0]?.href
);
check("the tool page reads the same link", parseMediaUrl(linkIn(share))?.platform === "tiktok");

const deck = "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing";
const slides = slidesActions(`Here are the slides: ${deck}`);
check("Google Slides link in a message", slides.length === 3 && slides[0].href === `/tools/google-slides-to-pdf?url=${encodeURIComponent(deck)}`, slides);

// The server still takes nothing but a link.
check("parseMediaUrl itself stays strict", parseMediaUrl(share) === null);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
