// Offline, or on a flaky connection, the code behind a tool can fail to load.
// That used to show the bundler's own message ("Failed to load chunk
// /_next/static/chunks/… from module …"), or blame the file. It must say to
// check the connection and try again.
import { readFileSync } from "node:fs";
import { friendlyPdfError, ENCRYPTED_MESSAGE, UNREADABLE_MESSAGE } from "../lib/pdf/errors.ts";
import { isLoadError, loadErrorMessage } from "../lib/load-error.ts";
import { PptxError, PPTX_MESSAGES, pptxErrorMessage } from "../lib/pptx/errors.ts";
import * as parse from "../lib/pptx/parse.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const LOAD = "Couldn't load the tool. Check your connection and try again.";
check("the message", loadErrorMessage() === LOAD, loadErrorMessage());
check("the message names what didn't load", loadErrorMessage("the editor") === "Couldn't load the editor. Check your connection and try again.");

const chunkErrors: [string, unknown][] = [
  [
    "Turbopack chunk",
    new Error(
      "Failed to load chunk /_next/static/chunks/node_modules_%40jsquash_jpeg_1a2b3c._.js from module [project]/lib/pdf/toolkit.ts [app-client] (ecmascript, async loader)"
    ),
  ],
  ["webpack ChunkLoadError", Object.assign(new Error("Loading chunk 123 failed."), { name: "ChunkLoadError" })],
  ["webpack CSS chunk", new Error("Loading CSS chunk 45 failed.")],
  ["Chrome dynamic import", new TypeError("Failed to fetch dynamically imported module: https://example.test/_next/static/chunks/a.js")],
  ["Firefox dynamic import", new TypeError("error loading dynamically imported module: https://example.test/a.js")],
  ["Safari dynamic import", new TypeError("Importing a module script failed.")],
  ["fetch, Chrome", new TypeError("Failed to fetch")],
  ["fetch, Firefox", new TypeError("NetworkError when attempting to fetch resource.")],
  ["fetch, Safari", new TypeError("Load failed")],
  ["pdf.js worker", new Error('Setting up fake worker failed: "Failed to fetch dynamically imported module: https://example.test/pdf.worker.mjs".')],
];

for (const [label, err] of chunkErrors) {
  check(`${label}: recognised`, isLoadError(err));
  const pdf = friendlyPdfError(err).message;
  check(`${label}: PDF tools say to check the connection`, pdf === LOAD, pdf);
  const named = friendlyPdfError(err, "doc.pdf").message;
  check(`${label}: no file name, the file is fine`, named === LOAD, named);
  check(`${label}: slide tools say to check the connection`, pptxErrorMessage(err) === LOAD, pptxErrorMessage(err));
}

// What the file is to blame for still says so.
check("encrypted PDF", friendlyPdfError(new Error("Input document to `PDFDocument.load` is encrypted")).message === ENCRYPTED_MESSAGE);
check("broken PDF", friendlyPdfError(new Error("Failed to parse PDF document (line:0 col:0 offset=0)")).message === UNREADABLE_MESSAGE);
check(
  "a library TypeError is still a broken PDF",
  friendlyPdfError(new TypeError("Cannot read properties of undefined (reading 'Pages')")).message === UNREADABLE_MESSAGE
);
check("our own messages pass through", friendlyPdfError(new Error("Pick pages between 1 and 5.")).message === "Pick pages between 1 and 5.");
check("not a load error", !isLoadError(new Error("This PDF has only 1 page.")) && !isLoadError(undefined) && !isLoadError("x"));
check("a broken deck", pptxErrorMessage(new PptxError(PPTX_MESSAGES.legacy, "legacy")) === PPTX_MESSAGES.legacy);
check("anything else from the parser", pptxErrorMessage(new Error("zip end of central directory not found")) === PPTX_MESSAGES.invalid);

// The pages import the messages up front, so they can't fail with the parser.
check(
  "parse.ts still hands out the messages",
  parse.pptxErrorMessage(chunkErrors[0][1]) === LOAD && parse.PPTX_MESSAGES.invalid === PPTX_MESSAGES.invalid
);
const imports = [...readFileSync(new URL("../lib/pptx/errors.ts", import.meta.url), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
check("lib/pptx/errors.ts imports nothing heavy", imports.every((p) => p === "../load-error"), imports);
for (const page of ["../components/tools/PptxToPdf.tsx", "../components/tools/PptxEditor.tsx"]) {
  const src = readFileSync(new URL(page, import.meta.url), "utf8");
  check(`${page.split("/").pop()}: imports the messages up front`, /import \{[^}]*pptxErrorMessage[^}]*\} from "@\/lib\/pptx\/errors"/.test(src));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
