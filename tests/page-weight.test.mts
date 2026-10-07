/**
 * Guards for what a tool page downloads before anyone touches it, and for
 * keyboard traps the motion library can add. The checks read the source, so
 * a heavy library imported at the top of a panel fails here rather than in a
 * slow first load on a phone.
 */
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync, readdirSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { TOOLS } from "../lib/tools.tsx";
import { panelSpec, placeholderSize } from "../components/tools/panel-spec.tsx";
import { PROCESSORS } from "../components/tools/processors.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Value imports (not `import type`) of the given modules at the top of a file. */
function staticImports(code: string, modules: RegExp): string[] {
  return [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)]
    .map((m) => m[1])
    .filter((m) => modules.test(m));
}

// Every tool has a panel, and every workbench panel has a processor.
const kinds = TOOLS.map((t) => [t.slug, panelSpec(t)] as const);
check(
  "every workbench tool has a processor",
  kinds.every(([slug, s]) => s.kind !== "workbench" || !!PROCESSORS[slug]),
  kinds.filter(([slug, s]) => s.kind === "workbench" && !PROCESSORS[slug]).map(([slug]) => slug)
);
check(
  "media and slides panels carry their settings",
  kinds.every(([, s]) => (s.kind === "media" ? !!s.media.platform : s.kind === "slides-import" ? !!s.format : true))
);
check("edit-pdf opens the editor", panelSpec(TOOLS.find((t) => t.slug === "edit-pdf")!).kind === "editor");
check("x-to-mp4 is a media panel", panelSpec(TOOLS.find((t) => t.slug === "x-to-mp4")!).kind === "media");
check("each panel kind reserves its height", kinds.every(([, s]) => /^h-\[/.test(placeholderSize(s.kind))));
check("panel specs are plain data (server → client)", kinds.every(([, s]) => JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s)));

// The tool page itself never imports a panel; ToolPanel loads each on demand.
const page = src("app/tools/[slug]/page.tsx");
check(
  "tool page imports no panel component",
  staticImports(page, /components\/tools\/(ToolWorkbench|EditorLaunch|PdfAssistant|MediaDownloader|PlaylistDownloader|PptxToPdf|PptxEditor|SlidesImporter)$/).length === 0
);
const panel = src("components/tools/ToolPanel.tsx");
const lazy = [...panel.matchAll(/lazy\(\(\) => import\("\.\/(\w+)"\)/g)].map((m) => m[1]).sort();
check(
  "ToolPanel loads all eight panels lazily",
  lazy.join() === "EditorLaunch,MediaDownloader,PdfAssistant,PlaylistDownloader,PptxEditor,PptxToPdf,SlidesImporter,ToolWorkbench",
  lazy
);

// Heavy libraries load when used, not with the panel.
const HEAVY = /^(pdf-lib|@cantoo\/pdf-lib|pdfjs-dist|jszip|docx|pptxtojson|@supabase\/.*|@\/lib\/pdf\/(toolkit|operations|render|bake|convert|parse)|@\/lib\/pptx\/(package|parse|editor|to-pdf|from-pdf)|@\/lib\/supabase\/client|tesseract\.js|@ffmpeg\/.*)$/;
for (const file of [
  "components/tools/ToolWorkbench.tsx",
  "components/tools/processors.ts",
  "components/tools/EditorLaunch.tsx",
  "components/tools/PdfAssistant.tsx",
  "components/tools/MediaDownloader.tsx",
  "components/tools/PlaylistDownloader.tsx",
  "components/tools/PptxToPdf.tsx",
  "components/tools/PptxEditor.tsx",
  "components/tools/SlidesImporter.tsx",
]) {
  const heavy = staticImports(src(file), HEAVY);
  check(`${file.split("/").pop()} has no heavy top-level imports`, heavy.length === 0, heavy);
}
check(
  "PptxEditor does not load the parser on mount",
  !/useEffect\(\(\) => \{\s*getLibs\(\)/.test(src("components/tools/PptxEditor.tsx"))
);

// A processor still works once its library arrives on demand.
{
  const make = async (n: number) => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < n; i++) doc.addPage([200, 200]);
    return new File([(await doc.save()).slice() as unknown as BlobPart], `${n}.pdf`, { type: "application/pdf" });
  };
  const out = await PROCESSORS["merge-pdf"].run([await make(1), await make(2)], {}, { progress: () => {} });
  const merged = Array.isArray(out) ? out[0] : out;
  const pages = (await PDFDocument.load(new Uint8Array(await merged.blob.arrayBuffer()))).getPageCount();
  check("merge-pdf runs through the lazy toolkit", pages === 3, pages);
}

// motion adds tabindex=0 to elements with whileTap/whileHover. A wrapper div
// around a real button or link must opt out, or it becomes an unnamed tab stop.
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith(".tsx")) {
      for (const m of src(path).matchAll(/<motion\.(div|span|li)\b[^>]*?>/gs)) {
        const tag = m[0];
        if (/while(Tap|Hover)=/.test(tag) && !/tabIndex=\{-1\}/.test(tag)) offenders.push(`${path}: ${tag.slice(0, 60)}`);
      }
    }
  }
};
walk("components");
check("motion wrappers with whileTap/whileHover are not tab stops", offenders.length === 0, offenders);

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
