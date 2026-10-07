import { exportName, formatDuration, playlistCsv, playlistTxt, type PlaylistEntry } from "../lib/playlist.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const e = (id: string, title: string, duration: number | null): PlaylistEntry => ({
  id,
  title,
  duration,
  thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  url: `https://www.youtube.com/watch?v=${id}`,
});
const entries = [
  e("aaaaaaaaaaa", 'Say "hello", world', 187),
  e("bbbbbbbbbbb", "=HYPERLINK(\"http://evil\")", 3723),
  e("ccccccccccc", "日本語のタイトル", null),
];

const csv = playlistCsv(entries);
const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
check("csv starts with a BOM", csv.startsWith("﻿"));
check("csv header", lines[0] === "title,url,duration", lines[0]);
check("csv quotes and escapes", lines[1] === `"Say ""hello"", world","https://www.youtube.com/watch?v=aaaaaaaaaaa","0:03:07"`, lines[1]);
check("csv defuses formulas", lines[2].startsWith(`"'=HYPERLINK(`) && lines[2].endsWith(`"1:02:03"`), lines[2]);
check("csv keeps unicode, blank unknown duration", lines[3] === `"日本語のタイトル","https://www.youtube.com/watch?v=ccccccccccc",""`, lines[3]);
check("csv row count", lines.length === 4);

const txt = playlistTxt(entries);
check("txt is one link per line", txt === entries.map((x) => x.url).join("\n") + "\n", txt);

check("duration m:ss", formatDuration(187) === "3:07");
check("duration h:mm:ss", formatDuration(3723) === "1:02:03");
check("duration unknown", formatDuration(null) === "");

check("file name strips unsafe characters", exportName('Mix: "best" / 2024?', "csv") === "Mix best 2024.csv", exportName('Mix: "best" / 2024?', "csv"));
check("file name never empty or hidden", exportName("...", "txt") === "playlist.txt" && exportName("  ", "csv") === "playlist.csv");

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
