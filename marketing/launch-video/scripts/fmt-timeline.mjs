// Rewrites film/timeline.json with one line per section (easy to retime by hand).
import { readFileSync, writeFileSync } from "node:fs";
const p = new URL("../film/timeline.json", import.meta.url);
const tl = JSON.parse(readFileSync(p, "utf8"));
const lines = Object.entries(tl).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, "{ ").replace(/\}$/, " }")}`);
writeFileSync(p, `{\n${lines.join(",\n")}\n}\n`);
