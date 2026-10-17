import {
  choiceForFiles,
  choiceFromHash,
  fileKind,
  isSlidesLink,
  mediaActions,
  slidesActions,
} from "../lib/journey.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Hash deep links
check("#pdf", choiceFromHash("#pdf") === "pdf");
check("#pptx", choiceFromHash("#pptx") === "pptx");
check("#slides", choiceFromHash("#SLIDES") === "slides");
check("#media", choiceFromHash("media") === "media");
check("unknown hash ignored", choiceFromHash("#start") === null && choiceFromHash("") === null);

// File classification
check("pdf by name", fileKind({ name: "a.PDF", type: "" }) === "pdf");
check("pdf by type", fileKind({ name: "download", type: "application/pdf" }) === "pdf");
check("jpeg", fileKind({ name: "x.jpeg", type: "image/jpeg" }) === "image");
check("pptx without type", fileKind({ name: "Deck.pptx", type: "" }) === "pptx");
check("ppt is legacy", fileKind({ name: "old.ppt", type: "application/vnd.ms-powerpoint" }) === "legacy-slides");
check("key is legacy", fileKind({ name: "talk.key" }) === "legacy-slides");
check("odp is legacy", fileKind({ name: "talk.odp" }) === "legacy-slides");
check("docx is other", fileKind({ name: "a.docx" }) === "other");
check("drop pptx → pptx", choiceForFiles([{ name: "d.pptx" }]) === "pptx");
check("drop pdf+img → pdf", choiceForFiles([{ name: "a.pdf" }, { name: "b.png" }]) === "pdf");
check("drop docx → none", choiceForFiles([{ name: "a.docx" }]) === null);

// Google Slides links
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
check("slides edit link", isSlidesLink(`https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`));
check("slides account link", isSlidesLink(`https://docs.google.com/presentation/u/1/d/${ID}/edit`));
check("slides bare", isSlidesLink(`docs.google.com/presentation/d/${ID}`));
check("rejects docs", !isSlidesLink(`https://docs.google.com/document/d/${ID}/edit`));
check("rejects other host", !isSlidesLink(`https://evil.com/docs.google.com/presentation/d/${ID}`));
check("rejects lookalike host", !isSlidesLink(`https://docs.google.com.evil.com/presentation/d/${ID}`));
check("rejects short id", !isSlidesLink(`https://docs.google.com/presentation/d/abc/edit`));
const link = `https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`;
const sa = slidesActions(link);
const enc = encodeURIComponent(link);
check(
  "slides routes",
  sa.length === 3 &&
    sa[0].href === `/tools/google-slides-to-pdf?url=${enc}` &&
    sa[1].href === `/tools/google-slides-to-pptx?url=${enc}` &&
    sa[2].href === `/tools/google-slides-to-pptx?url=${enc}&then=edit`,
  sa
);
check("slides invalid → none", slidesActions("hello").length === 0);

// Media links
const yt = mediaActions("https://youtu.be/dQw4w9WgXcQ", true);
check(
  "youtube → mp4 + mp3",
  yt.length === 2 && yt[0].href.startsWith("/tools/youtube-to-mp4?url=https%3A%2F%2Fyoutu.be") && yt[1].href.startsWith("/tools/youtube-to-mp3?url="),
  yt
);
const PL = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
const plOnly = mediaActions(`https://www.youtube.com/playlist?list=${PL}`, true);
check(
  "playlist → playlist tool",
  plOnly.length === 1 && plOnly[0].label === "Playlist" &&
    plOnly[0].href === `/tools/youtube-playlist?url=${encodeURIComponent(`https://www.youtube.com/playlist?list=${PL}`)}`,
  plOnly
);
const plVideo = mediaActions(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${PL}&index=2`, true);
check(
  "video in playlist → playlist, or this video alone",
  plVideo.length === 3 && plVideo[0].label === "Playlist" &&
    plVideo[1].href === `/tools/youtube-to-mp4?url=${encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")}` &&
    plVideo[2].href.startsWith("/tools/youtube-to-mp3?url="),
  plVideo
);
const x = mediaActions("https://x.com/NASA/status/1790866466429911046");
check(
  "x → mp4 + mp3",
  x.length === 2 && x[0].href.startsWith("/tools/x-to-mp4?url=") && x[1].href.startsWith("/tools/x-to-mp3?url="),
  x
);
check("media invalid → none", mediaActions("https://vimeo.com/123").length === 0);
check("YouTube paused → no actions", mediaActions("https://youtu.be/dQw4w9WgXcQ", false).length === 0 && mediaActions(`https://www.youtube.com/playlist?list=${PL}`, false).length === 0);
const tt = mediaActions("https://www.tiktok.com/@scout2015/video/6718335390845095173");
check("tiktok → tiktok mp4 + mp3", tt.length === 2 && tt[0].href.startsWith("/tools/tiktok-to-mp4?url=") && tt[1].href.startsWith("/tools/tiktok-to-mp3?url="), JSON.stringify(tt));
const ttShort = mediaActions("https://vm.tiktok.com/ZMabc123/");
check("tiktok short link → tiktok tools", ttShort[0]?.href.startsWith("/tools/tiktok-to-mp4?url="));
const ig = mediaActions("https://www.instagram.com/reel/C4Hm4z2oEVp/?igsh=abc");
check("instagram reel → instagram mp4 + mp3", ig.length === 2 && ig[0].href.startsWith("/tools/instagram-to-mp4?url=") && ig[1].href.startsWith("/tools/instagram-to-mp3?url="), JSON.stringify(ig));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
