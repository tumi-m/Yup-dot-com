# Market research: features competitors offer that PDF Wizard lacks

Date of observation: 14 November 2026. Branch: `market-research`. No app code was changed.

## 1. How the research was done

### Tooling

- **REA ("Reverse Engineer Anything")**, npm package `rea-agents`, **version 6.9.0**, installed with `npm install -g rea-agents`. The docs read were `docs/guides/web/browser-observation.md` and `docs/guides/web/browser-scenario-contract.md` from a shallow clone of `morluto/rea`.
- `rea doctor` reported the binary-analysis engines as missing (Hopper, Ghidra, IDA). The web observation features don't need them, and they worked.
- The browser was the preinstalled Chromium at `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` (Chromium 153).

REA commands used:

| Command | Used for |
|---|---|
| `rea capture-browser-scenario <scenario.json> --format json` (launch mode, run with `REA_BROWSER_NO_SANDBOX=true`) | Loading every competitor's tools index page, PDF Wizard's live `/tools`, the iLovePDF and Smallpdf pricing pages, iLovePDF scan, and PDF24 Word to PDF. Each run saved an end-of-scenario screenshot, the accessibility snapshot (the tool lists were read from this), the final URL and `network` events (every request with its status or failure). |
| `rea list-browser-targets http://127.0.0.1:9222` | Finding the page target in a Chromium started with `--remote-debugging-port=9222`. |
| `rea inspect-web-page <cdp> <target> --observation-ms N --include-script-sources --allowed-origins <origin>` | 27 runs on individual tool pages, 26 of which returned Evidence. Each records the script inventory with full source text (library fingerprints were read from this), the resources, and same-origin network requests during the observation window, including while a test file was being handled. |

Three things REA could not do here, and the fallbacks used:

1. **No file upload.** REA's scenario actions are `goto`, `click`, `fill`, `press`, `select_option`, `wait_for`, `wait_for_timeout` and `request`. None of them uploads a file. For the upload flows, plain Playwright (`connectOverCDP` to the same Chromium) navigated the page and attached the test file. It also kept a request log, which covers cross-origin hosts that REA's origin filter leaves out. REA's `inspect-web-page` observed the page at the same time.
2. **`--allowed-origins` takes one origin per flag.** A JSON array is rejected; the flag has to be repeated.
3. **One run failed.** iLovePDF Scan to PDF swaps its document during load, and `inspect-web-page` returned `target_unavailable`. That page was captured again with `capture-browser-scenario`, which worked.

The upload test file was a 2-page synthetic PDF made with pdf-lib, containing one line of text per page ("Synthetic test page N - research sample"). It was offered to four competitors, one each:

| Competitor | Tool | Did the file reach their server? |
|---|---|---|
| iLovePDF | Crop | No. Processed in the browser. |
| PDF24 | Compare | No. Selected for both sides; processed in the browser. |
| Sejda | Editor | Yes. Uploaded, one text edit made, result rendered on their server. |
| PDFgear | Flatten | No. Loaded in the browser. |
| PDF2Go | Repair | No. Their API host is blocked here, so the job never started. |

No accounts were created. Paywalls, captchas and rate limits were left alone, and every load was at least 2 seconds after the previous one. Screenshots and REA Evidence JSON were kept outside the repository and are not committed.

### What loaded and what was blocked

| Site | Index page loaded | Notes |
|---|---|---|
| www.ilovepdf.com | Yes | Full. Analytics host `evt.ilovepdf.com` was blocked; it doesn't affect the tools. |
| smallpdf.com | Partly | The HTML and tool links loaded. The asset CDN `s.smallpdf.com` was blocked, so the app scripts and pricing page didn't render. |
| www.sejda.com | Yes | Full, including the editor and a server task. |
| tools.pdf24.org | Yes | Browser-side tools work fully. Server tools post to `filetoolsNN.pdf24.org` hosts, which were blocked. |
| www.pdfescape.com | Yes | Marketing page only. The editor app host `cloud.pdfescape.com` was blocked. |
| www.adobe.com | **No** | HTTP 403 "Access Denied" from the edge network for this headless browser. No Adobe data is included. |
| www.pdf2go.com | Partly | Pages and scripts loaded. The API host `dragon.pdf2go.com` was blocked, so no job could run. |
| www.sodapdf.com | Yes | Marketing and tool pages. Processing hosts were not reached. |
| www.xodo.com | **No** | Redirects to `xodo.com` (no `www`), which isn't allowed here (`ERR_NAME_NOT_RESOLVED`). No Xodo data is included. |
| pdfcandy.com | Partly | HTML and links loaded. `static.pdfcandy.com` was blocked. The Edit PDF text page showed a sign-in wall. |
| www.pdfgear.com | Yes | Full. |
| www.dochub.com | Partly | Links loaded; the `cdn.mrkhub.com` assets were blocked. |
| www.foxit.com | Yes | Online tools catalogue loaded. Tool pages render as a generic shell here. |

The counts below therefore cover the **11 competitors with data**. Adobe and Xodo are excluded because they could not be observed.

### PDF Wizard baseline (code and live site checked)

- **The code** (`lib/tools.tsx`) has **38 tools**. The live `https://www.pdfwizard.xyz/tools`, observed with REA, lists **33**: the 5 YouTube tools are hidden because `YOUTUBE_ENABLED` is off. The brief's figure of 40 is slightly high.
- **Split** (`lib/pdf/toolkit.ts` `splitTool`) has two modes: by page ranges, which makes one file per range, or every page separately.
- **Merge** reorders whole *files* by dragging (`ToolWorkbench.tsx`). It can't reorder pages.
- **PDF to JPG** has a **PNG** output option (`processors.ts`). There is no separate "PDF to PNG" page.
- **JPG to PDF** accepts `image/jpeg,image/png` only.
- **Page operations exist only inside the editor.** `ThumbnailSidebar.tsx` and `PdfEditor.tsx` let you reorder pages (drag or Alt+↑/↓), delete, rotate, insert a blank page and append another PDF, using `lib/pdf/operations.ts` and `lib/pdf/bake.ts`. There is no standalone Organize or Delete pages tool.
- **Form flattening exists in code but has no UI.** `lib/pdf/forms.ts` `fillFormFields(…, { flatten })` can flatten, but no caller turns it on.
- **Watermark** is text only (`watermarkTool`). **Page numbers** offer 3 bottom positions and 2 formats.
- **Chat with PDF** (`app/api/ai/chat`, `lib/ai/ollama.ts`) summarises and answers questions through Ollama.
- **Server pieces:** Vercel routes and the media worker (`media-worker/`, Docker, Python). The worker currently serves only YouTube.

## 2. Full inventory

Competitor letters: **I** iLovePDF, **S** Smallpdf, **J** Sejda, **P** PDF24, **E** PDFescape, **G** PDF2Go, **D** Soda PDF, **C** PDF Candy, **R** PDFgear, **H** DocHub, **F** Foxit.

Each entry is listed if it appears as a tool or feature on that competitor's tools index or catalogue as captured. For PDFescape, "premium" features are the ones its homepage lists under Premium.

| Feature | # | Competitors | PDF Wizard |
|---|---|---|---|
| Edit / annotate PDF | 11 | I S J P E G D C R H F | Have |
| Sign / fill forms | 11 | I S J P E G D C R H F | Have |
| Merge | 11 | I S J P E(premium) G D C R H F | Have |
| Split | 10 | I S J P G D C R H F | Have |
| Compress | 10 | I S J P E(premium) G D C R F | Have |
| Rotate | 10 | I S J P G D C R H F | Have |
| JPG to PDF | 10 | I S J P G D C R H F | Have |
| PDF to Word | 10 | I S J P E(premium) G D C R F | Have |
| Protect (password) | 10 | I S J P E G D C H F | Have |
| **Word to PDF** | 10 | I S J P G D C R H F | **Missing** |
| PDF to JPG | 9 | I S J P G D C R F | Have |
| PDF to Excel | 9 | I S J P G D C R F | Have |
| PDF to PowerPoint | 9 | I S J P G D C R F | Have |
| PowerPoint to PDF | 9 | I S P G D C R H F | Have |
| Unlock | 9 | I S J P G D C R F | Have |
| OCR | 9 | I S J P G D C R F | Have |
| **Delete pages (own tool)** | 9 | S J P G D C R H F | **Partly** (editor only) |
| **HTML / URL to PDF** | 9 | I S J P G D C H F | **Missing** |
| Watermark | 8 | I S J P E(premium) G D C | Have (text only; J also does image) |
| **Organize / rearrange pages (own tool)** | 8 | I S J P G C H F | **Partly** (editor only) |
| **Crop** | 8 | I S J P G C R F | **Missing** |
| **Excel to PDF** | 8 | I S P G D C R F | **Missing** |
| Chat with PDF (AI Q&A) | 8 | I S G D C R H F | Have |
| Page numbers | 7 | I S J P E(premium) C F | Have (basic) |
| AI summarise | 7 | I S G D C H F | Have (inside Chat with PDF) |
| **TXT to PDF** | 7 | S P D C R H F | **Missing** |
| PNG to PDF | 7 | P D C R H F (+S converter) | Have (inside JPG to PDF) |
| PDF to PNG | 6 | S J P C R F | Have (option in PDF to JPG; no own page) |
| **Extract pages into one PDF** | 6 | S J P C R F | **Partly** (split makes one file per range) |
| **Translate PDF** | 6 | I S G D C F | **Missing** |
| **Flatten** | 6 | S J P C R H | **Partly** (code exists, no UI) |
| RTF / ODT and other office formats to PDF | 6 | S P C R H F | Missing |
| **Redact** | 5 | I S P G F (Foxit: paid "Smart Redact") | **Missing** |
| **PDF to PDF/A** | 5 | I S P G C | **Missing** |
| **Repair** | 5 | I J P G C | **Missing** (compress has a raster fallback only) |
| **Resize / change page size** | 5 | J P G D C | **Missing** |
| Create fillable form | 5 | I P E R H | Have (editor form fields) |
| **Edit existing text in place** | 4+ | J ("Change PDF text"), C ("Edit PDF text"), E (premium "Edit Text and Images"), F (desktop/web editor) | **Partly** (whiteout + new text) |
| **Scan to PDF (phone camera)** | 4 | I S("PDF Scanner") P F (+R mobile app) | **Missing** |
| HEIC / WebP / TIFF / GIF / BMP to PDF | 4–6 | P C R D F H (varies by format) | Missing |
| Extract images | 4 | J P G C | Missing |
| PDF to TIFF | 4 | J P C F | Missing |
| EPUB to PDF | 4 | S P G C | Missing |
| Add blank / extra pages | 4 | R F J(editor) P(assemble) | Have (editor) |
| Create blank PDF | 4 | P G C H | Missing |
| **Compare PDFs** | 3 | I P G | **Missing** |
| Grayscale / black & white | 3 | J P C | Missing |
| N-up / pages per sheet | 3 | J P G | Missing |
| Edit / remove metadata | 3 | J P C | Missing |
| PDF to EPUB | 3 | P G C | Missing |
| e-sign request (send for signature) | 3 on-site (D H F); 6 with sister products (iLoveSign, Sign.com, esigngear) | | Missing |
| Share by link | 3 | E G H | Missing |
| Header & footer | 2 | J C | Missing |
| Booklet | 2 | P G | Missing |
| Print as poster / tile | 2 | P G | Missing |
| Bookmarks (create) | 2 | J P | Missing |
| Deskew | 2 | J P | Missing |
| Linearize (web optimise) | 2 | P G | Missing |
| Validate PDF/A | 2 | P G | Missing |
| Halve / split double pages | 2 | J ("split in half") P | Missing |
| PDF to HTML | 2 | P F | Missing |
| PDF to SVG | 2 | P C | Missing |
| Workflows / batch chains | 2 | I ("Create a workflow", premium) G ("workspace") | Missing |
| PDF to Markdown | 2 | I P | Have |
| PDF to text | 5 | J P G C F | Have |
| Bates numbering | 1 | J | Missing |
| Alternate & mix | 1 | J | Missing |
| Flip pages | 1 | J | Missing |
| Delete annotations | 1 | J | Missing |
| Split by bookmarks / size / text | 1 | J | Missing |
| Invert / dark mode PDF | 1 | P | Missing |
| Rasterize | 1 | P | Missing |
| Verify signatures | 1 | P | Missing |
| Search text across several PDFs | 1 | P | Missing |
| Overlay PDF | 1 | P | Missing |
| Spellcheck, extract facts, text-to-speech, speech-to-text | 1 | G | Missing |
| AI question generator | 1 | S | Missing |
| Accessible PDF | 1? | S (footer link only; not confirmed as a tool) | Missing |
| Fax, bulk send, kiosk / in-person signing, audit trail, certify, templates | 1 | H | Missing |
| Invoices / e-invoice (EN 16931), QR code, cards, job applications | 1 | P | Missing |
| Niche inputs: DjVu, DWG, DXF, XPS, PUB, MOBI, CHM, FB2, CBZ/CBR, HWP, Pages, ZIP, EML, PS/EPS | 1–3 | C P S G | Missing |
| PDF to PSD, PSD to PDF | 1 | R | Missing |

PDF Wizard features no competitor index showed:

- PDF to RAG chunks
- Edit PPTX
- Google Slides to PDF and to PPTX
- Social video and audio downloads
- Sample Finder
- Video compression

PDF to Markdown is shared with only iLovePDF and PDF24, and table-to-CSV extraction with only PDF Candy ("PDF to CSV").

## 3. Top 15 features to build

**How they were ranked.** Three factors:

1. How many of the 11 competitors offer the feature.
2. Real-world demand, judged from search experience. This is general knowledge, not measured: for example, "word to pdf", "edit pdf text", "crop pdf", "html to pdf" and "delete pages from pdf" are perennial high-volume queries.
3. Fit with PDF Wizard: browser-first processing, a small server only where unavoidable, Vercel + Supabase, and no paid PDF SDK.

**What sizes mean.** S is about 1–3 days, M about 1–2 weeks, L longer.

**What the observations showed overall.**

- **Many competitors buy a commercial SDK** for these features. Apryse WebViewer / PDFNet shows up in iLovePDF's crop, redact and compare bundles, and in Smallpdf identifiers.
- **Others do it with the same open-source stack PDF Wizard already ships.** PDFgear and PDF24 use pdf.js and pdf-lib in the browser. Every feature below can be built on PDF Wizard's existing pdf-lib (`@cantoo/pdf-lib`), `pdfjs-dist` 4.8 and the media worker.

### 1. Word to PDF

**What it does for the user:** turns a `.docx` (or `.doc`/`.odt`) into a PDF that keeps the layout. It's one of the highest-volume PDF searches, and 10 of 11 competitors have it.

**Who offers it and how (observed):**

- **Soda PDF:** the page says the file is uploaded and "deleted from our servers within 24 hours". The flow is choose file (or Dropbox / Google Drive pickers, seen as `filePickers/dropbox`, `googleDrive` scripts), then automatic conversion, preview, download. Free use is marked "free*".
- **PDF24:** the Word to PDF page sends work to `filetoolsNN.pdf24.org` hosts. Four different numbered hosts were contacted on load (blocked here), so it's server-side.
- **Foxit:** the tool page ships a Next.js app with a `(online-pdf)/[id]` route. It didn't render a tool here.
- **Server-side everywhere it could be seen.** No competitor converts Word in the browser.

**Build plan for PDF Wizard:**

- **Server (needed for fidelity).** Add a `/convert/office` endpoint to the media worker that runs headless **LibreOffice** (`soffice --headless --convert-to pdf`) in the existing Docker image.
- **Reuse the media worker's security model:** a short-lived signed token from a new Next.js route `/api/convert/link` that checks plan and quota (as `/api/media/link` does), a size cap, conversion in a temp dir, and deletion right after streaming the result back.
- **Page:** a new tool `word-to-pdf` in `lib/tools.tsx` (category `convert`) with a small `custom: "office-to-pdf"` component modelled on `PptxToPdf.tsx`, which already has the upload, progress, upsell and success card.
- **Optional browser-only "quick" mode:** `docx` is already a dependency for *writing*. For reading, a docx→HTML renderer (e.g. `docx-preview` or `mammoth`, both open source) could render to the page and print to PDF. Fidelity is lower, so keep LibreOffice as the default.
- **Owner setup:** add LibreOffice and core fonts (Carlito, Caladea, Liberation, Noto) to the worker image, raise its memory, and set the new route's env vars.

**Size:** M (worker endpoint and route), +S per extra format.

**Risks:**

- Files leave the browser. Say so plainly on the page, as the media tools already do.
- LibreOffice is heavy (~500 MB image) and must be sandboxed: no macros, a timeout, a non-root user.
- Missing fonts cause layout drift.

### 2. Organize pages: delete, reorder, extract and insert as standalone tools

**What it does:** a page-grid tool to drag pages into a new order, delete pages, pull selected pages into one new PDF, rotate single pages and insert blanks. Users search for each action by name ("delete pages from PDF", "rearrange PDF", "extract pages"). 9 competitors have delete pages, 8 have organize and 6 have extract.

**Who offers it and how:**

- **PDF24 "Rearrange PDF pages":** drag thumbnails or reverse all pages, with a "Select sorting method" control. It promises "without quality loss". It is a browser tool built on PDF24's `pdfEditor` modules (`organizeLayer.mjs`, `thumbnailLayer.mjs`, `pointerDnd.mjs`) on pdf.js.
- **iLovePDF "Organize PDF"** and **Sejda "Visual Combine & Reorder"** also have dedicated pages.
- **PDF24 also ships** separate "remove pages" and "extract pages" pages.
- PDF Wizard already has all of this, but only inside the editor.

**Build plan:**

- **Browser only.** New tools `organize-pdf`, `delete-pages`, `extract-pages`, each `custom: "pages"`. They share one component that reuses:
  - `ThumbnailSidebar.tsx`'s drag/keyboard reorder and per-page actions, laid out as a grid;
  - `lib/editor/thumbnails.ts` for rendering;
  - `lib/pdf/operations.ts` (`reorderPages`, `deletePages`, `extractFrom`, `rotatePages`) and `lib/pdf/bake.ts` (`insertBlankPage`).
- **Extract mode** selects pages (click or shift-click) and saves them as *one* PDF via `extractFrom`, filling the gap left by `splitTool`.
- **Extra actions:** "reverse order" and "sort by" (PDF24's options), and "merge another PDF in" (`mergePdfs` is already used by the editor).

**Size:** S–M.

**Risks:** large documents need virtualised thumbnails; the editor's current sidebar renders every page. Keep bookmark and link handling the same as `extractorFor`.

### 3. HTML / URL to PDF

**What it does:** saves a web page (by URL), an uploaded `.html` file or pasted HTML as a PDF. 9 competitors have it.

**Who offers it and how:**

- **Sejda:** three tabs ("Convert URL to PDF", "Convert HTML files", "HTML code"). Multiple URLs can be entered, one per line, with "More options". The free limit is shown as **20 links per task and 3 tasks per hour**; PRO allows 100 links per task. Sejda also offers a "Save as PDF" bookmarklet, an embeddable "save to PDF" snippet and an HTML to PDF API. It's server-side: the page only loads `libs-and-partials.min.js` and does the work through their task API.
- **PDF24 "Webpage to PDF":** one URL field and a page size select (Automatic (Letter) / A4 / Letter). Server-side.
- **Soda PDF:** one URL box, "Get PDF", and a note that files are deleted from their servers within 24 hours.

**Build plan:**

- **Server (unavoidable):** a remote page has to be rendered by a real browser.
- **Recommended:** a `/render/url` endpoint on the media worker using Playwright Chromium (`page.pdf()`), with options for page size (A4/Letter/auto), orientation, margins, print background, and screen versus print CSS.
- **Alternative:** a Vercel function with a slim Chromium build, but function size and time limits make the worker the better home.
- **Security (critical):** block private and loopback IP ranges after DNS resolution (SSRF), cap page count, time and output size, disable downloads, and allow only http(s).
- **HTML upload and pasted-code modes** can render in a sandboxed iframe and use the same endpoint with `setContent`.
- **Page:** `html-to-pdf` tool with a URL field plus file / code tabs.
- **Owner setup:** worker redeploy, and a daily quota in `lib/limits.ts` like `linkImportsPerDay`.

**Size:** M.

**Risks:** SSRF and abuse (printing arbitrary sites); pages behind logins or cookie walls; legal takedown requests. Rate-limit per user, as the media tools do.

### 4. Crop PDF

**What it does:** trims page margins or keeps a chosen area, on all pages or the current page. 8 competitors have it.

**Who offers it and how:**

- **iLovePDF, observed end to end:**
  1. The file is chosen.
  2. Pages render in an iframe that loads Apryse WebViewer (`webviewer-core.min.js`, `webviewer-ui.min.js`, `PDFNet.js`, `PDFNetCWasm.br.wasm`).
  3. You drag a rectangle ("Click and drag to select the area you want to keep"), then choose Pages: All pages / Current page, with a "Reset all" link.
  4. "Crop PDF" finishes with "Your PDF has been cropped successfully" and a download.
  5. **No file upload happened.** The only request after clicking was a download template call with `taskId=-1&workerId=-1`. Fully client-side.
- **Sejda** describes crop as "Trim PDF margins, change PDF page size".
- **PDF24** offers "Trim white margins, per edge or visually on a page preview" (auto white-margin detection).

**Build plan:**

- **Browser only.** Render with the existing pdf.js path (`lib/pdf/render.ts`) and draw a resizable rectangle (reuse the editor's selection handles in `AnnotationView.tsx`/`lib/editor/canvas.ts`).
- **Apply** with pdf-lib `page.setCropBox` (and optionally `setMediaBox` for a "real" crop), mapping coordinates through `lib/pdf/page-frame.ts`, which already handles rotation.
- **Options:**
  - all pages / this page / odd / even;
  - numeric margins;
  - "auto-trim white margins": render each page to canvas, find the content bounding box, then crop.
- **Page:** `crop-pdf`, a custom component. It could also be a mode inside the editor.

**Size:** S–M.

**Risks:** a CropBox crop leaves the hidden content in the file. Say so, and offer "remove hidden content" by rasterizing or redrawing pages if users expect true removal (this ties to Redact). Pages that are already rotated need correct coordinate maths (`page-frame.ts` covers this).

### 5. Excel to PDF

**What it does:** converts `.xlsx`/`.xls`/`.ods`/`.csv` to PDF with sensible page breaks. 8 competitors have it.

**Who offers it and how:** listed by iLovePDF, Smallpdf, PDF24, PDF2Go, Soda, PDF Candy, PDFgear and Foxit, plus DocHub's CSV to PDF. Server-side wherever a request was visible (PDF24 posts to `filetoolsNN` hosts; Soda keeps files up to 24 hours).

**Build plan:**

- **Same worker endpoint as #1** (LibreOffice calc_pdf_Export), with options for fit to page width, orientation and "all sheets / active sheet".
- **Separate tool pages** `excel-to-pdf` (and later `ppt`, `odt`, `rtf`) for search, sharing the #1 component.
- **CSV could be done in the browser** with pdf-lib table drawing, reusing `lib/pdf/convert.ts` table types.

**Size:** S once #1 exists.

**Risks:** very wide sheets; locale and number formats; formula recalculation differences.

### 6. Edit existing PDF text

**What it does:** click any existing line of text, change words, font size, bold or italic, and colour, so the original text is replaced rather than covered. It's the most-asked-for "edit PDF" behaviour. PDF Wizard's editor today only adds new text, plus whiteout.

**Who offers it and how (observed on Sejda, with the test file uploaded):**

1. The file is **uploaded** (`POST /api/files/upload-check`, then `POST /api/files/upload`).
2. Pages render with pdf.js in the browser (`pdfjs/pdf.min.js`, `pdf.worker.min.js`, `standard_fonts/LiberationSans-Regular.ttf`).
3. With the "Text" tool on, clicking existing text opens an inline editor with Bold, Italic, size, font, colour, link, move, duplicate and delete.
4. Typed changes show immediately.
5. "Apply changes" sends a **~1.4 KB JSON edit list** (`POST /api/tasks`). Their server rewrites the PDF and returns a result page with a download (`/api/tasks/<id>/download/…`).

The free tier showed "2 free saves left for the next 59 minutes". The page states the free limit as **200 pages or 50 MB and 3 tasks per hour**, with files deleted after 2 hours.

- **PDF Candy "Edit PDF text"** sat behind a sign-in wall here.
- **PDFescape** lists "Edit Text and Images" as premium.

**Build plan:**

- **Browser only**, in `components/editor`:
  1. On load, read `page.getTextContent()` from pdf.js for each page, which `lib/pdf/parse.ts` already does for conversions. Group the items into lines/runs with bounding boxes and font info (`fontName`, size, transform).
  2. A new "Edit text" mode hit-tests those runs. Clicking one creates an editable text annotation pre-filled with the run's text, position, size and a best-match font (Standard 14 fonts, or the embedded font when it is a full font).
  3. On save, `bakeAnnotations` (in `lib/pdf/bake.ts`) draws a whiteout rectangle exactly over the original glyph boxes and then draws the new text. The editor already has both primitives.
- **Better second phase:** remove the original glyphs from the content stream instead of covering them. `lib/pdf/page-content.ts` and the compress lexer (`lib/pdf/compress/lexer.ts`) already tokenise content streams, so whole `Tj`/`TJ` operators inside the run's box could be dropped. Hidden original text then doesn't survive (better for privacy and for copy-paste).

**Size:** L, as two phases: an M cover-and-replace, then the stream-removal phase.

**Risks:**

- Font matching. Subset fonts lack glyphs for new characters, so fall back to a similar standard font and say so.
- RTL and rotated text; the repo already has tests for `rotated-text` and `rtl-text`.
- Phase 1 leaves the original text under the whiteout.

### 7. Translate PDF

**What it does:** translates a document into another language and returns a PDF (or DOCX) in that language. 6 competitors have it, and several sell it as a headline AI feature.

**Who offers it and how:**

- **iLovePDF:** "Convert PDF documents with AI into other languages while preserving original formatting". A language select (the list starts at Afrikaans) and the `translate.<hash>.js` bundle using pdf.js. Upload is via plupload, so it's server-side. AI credits appear on the pricing page: Premium has "2,000 AI Credits" and Free has none, which suggests translation draws on paid credits. That is inferred from the pricing page, not tested.
- **Smallpdf:** "Summary" or "Entire Document", then Translate, then change the target language; "20+ languages", with a built-in AI chat.
- Also listed by PDF2Go, Soda, PDF Candy and Foxit.

**Build plan:**

- **Server (AI)** using the existing Ollama path (`lib/ai/ollama.ts`, `/api/ai/chat` patterns, usage metering in `lib/usage.ts`).
- **Pipeline:**
  1. Extract structure in the browser with `lib/pdf/parse.ts` (headings, paragraphs, tables, reading order; already used for PDF to Word).
  2. Send paragraph batches to a new `/api/ai/translate` route with the target language, streaming the results back.
  3. Rebuild as DOCX with `lib/pdf/convert.ts` `buildDocx`, and as PDF.
- **Output options:**
  - "Translated document (DOCX/PDF, reflowed)";
  - "Side by side" (original page image + translated text);
  - "Summary in language X", reusing Chat with PDF.
- **Layout-preserving overlay is a later phase:** whiteout each text run and draw the translated text in its box, as in #6, shrinking the font to fit.
- **Owner setup:** choose a model good at translation on Ollama Cloud, and set per-plan page or character limits in `lib/limits.ts` (`aiDocumentChars` already exists).

**Size:** M (reflowed), L (layout-preserving).

**Risks:** cost per page; text leaves the browser (state it); long documents need chunking; quality on tables and RTL scripts.

### 8. Flatten PDF

**What it does:** turns form fields, annotations and layers into plain page content so nothing can be edited further. 6 competitors have it. It is common before submitting forms.

**Who offers it and how:**

- **PDFgear, observed end to end with the test file:** a "Flatten Option" with two choices, then a Flatten button. The page says "processed locally in your browser". Its script `converter-flatten.js` uses `pdf-lib-2.4.2.js` and `pdf-2.10.377.min.js` (pdf.js). The only network request after the file was chosen was the pdf.js worker script.
  - **"Flatten only form fields":** pdf-lib's form flatten.
  - **"Flatten all content":** each page is drawn to a canvas with pdf.js, encoded as JPEG and placed on a new pdf-lib page. The whole page becomes an image.
- **Smallpdf** describes flattening "text, images, annotations, and form fields" and working "in your browser".
- **DocHub** offers "Flatten fields on a PDF" inside its editor (upload up to 31 MB, account required).

**Build plan:**

- **Browser only.** New tool `flatten-pdf` in `processors.ts` with a field "What to flatten":
  1. **Form fields:** call the existing `fillFormFields(bytes, {}, { flatten: true })` or `form.flatten()`.
  2. **Annotations and forms (keep text):** for each annotation, draw its appearance stream into the page content with pdf-lib, then remove the `/Annots` entry. `lib/pdf/bake.ts` already draws annotation types.
  3. **Everything, as images (most secure):** reuse the `rasterCompress` loop in `toolkit.ts` with a DPI option. Offer an "OCR after" checkbox using the existing OCR layer.
- Also add a "Flatten on save" checkbox to the editor's Fill & Sign save.

**Size:** S.

**Risks:** option 3 removes selectable text and grows file size. Explain the trade-off and default to option 2.

### 9. Redact PDF

**What it does:** permanently removes sensitive text or areas, which a black box drawn on top does not do. 5 competitors have it; legal, HR and finance users need it.

**Who offers it and how:**

- **iLovePDF:** the page shows controls "Smart redact", "text", "Credit Card", "Phone Number", "Email", "Clear all", "Accept", plus a reminder to review before sending. The `redact.<hash>.js` bundle mounts an Apryse WebViewer web component (`isApryseWebViewerWebComponent`), so the redaction UI runs in the browser on Apryse.
- **PDF24 "Redact PDF":**
  - The page says pages "are rasterized on saving so hidden content is removed for good".
  - You draw black boxes over areas, and the sidebar lists them for removal.
  - The editor modules are `redactLayer.mjs`, `searchLayer.mjs` (search and redact every occurrence) and `outputLayer.mjs`.
  - Its `pdfEditor/core/api.mjs` uploads the PDF (`FormData` "file", `POST …upload`) and its save step shows uploading / processing / downloading states. **Rasterising is done on their server.**
- **Foxit** sells "Smart Redact" (AI) as a paid product.

**Build plan:**

- **Browser only**, as an editor mode plus a `redact-pdf` tool page that opens it.
- **Marking:** draw boxes; search text (pdf.js text content, as in #6) with "redact all matches"; pattern presets (email, phone, card number, ID numbers) via regex on the extracted text; review list.
- **Applying, per page, two modes:**
  - **(a) Secure (default):** rasterise only pages that contain redactions (pdf.js render at 200–300 DPI, black rectangles painted on the canvas, embedded as JPEG/PNG with pdf-lib). Other pages stay vector. Optionally run the existing OCR (`lib/pdf/ocr-layer.ts`) on rasterised pages to keep them searchable, without the redacted words.
  - **(b) Keep text (advanced):** remove the `Tj`/`TJ` operators and image XObjects inside the boxes from the content stream (lexer in `lib/pdf/compress/lexer.ts`), then draw the boxes.
- **Always:** strip metadata, annotations and form values in redacted areas, and the document's `/Info` and XMP. Then verify by re-extracting the text and checking that no redacted string remains. Block saving if any does.

**Size:** M (raster mode), L (true content removal).

**Risks:** a false sense of security is the main one, so the verification step is essential. Raster pages are bigger and lose text without OCR.

### 10. Resize PDF / change page size

**What it does:** converts all pages to A4, Letter or a custom size, optionally adding margins, without cropping. 5 competitors have it.

**Who offers it and how:**

- **PDF2Go "Change PDF page size":** "in your browser"; presets (A4 default) or custom width and height in the unit you choose; "the pages are re-laid out, not cropped"; text stays selectable. A pdf-lib chunk is loaded on the page.
- **PDF24:** "To A4, A3, Letter or a custom size, mixed sizes made uniform".
- **Sejda "Resize":** "Add page margins and padding, Change PDF page size".

**Build plan:**

- **Browser only.** New tool `resize-pdf` with:
  - a preset size (A4/A3/A5/Letter/Legal/custom with mm/in/pt);
  - orientation (auto per page / portrait / landscape);
  - fit mode (fit, keeping proportions and centring / stretch / no scaling + margins);
  - margins.
- **Implementation:** pdf-lib `embedPage(src)` and `drawPage` scaled into a new page of the target size. This keeps the pages vector. Links and annotations need transforming, or a note that they are dropped; `extractorFor` shows how the repo already carries document parts.
- **Related cheap tools on the same code:** N-up (2/4 per sheet) and booklet. Both come up in the rejected list; they become trivial once this exists.

**Size:** S.

**Risks:** annotation and link rects must be transformed; form fields on resized pages are best flattened first (#8).

### 11. PDF to PDF/A

**What it does:** converts a PDF into the archival PDF/A standard (embedded fonts, ICC colour, XMP metadata, no JavaScript or encryption), as courts, universities and public bodies often require. 5 competitors have it.

**Who offers it and how:**

- **iLovePDF:** marked **Premium** on the tool page here. A "Set the PDF/A conformance level" select offers PDF/A-1b, 1a, 2b, 2u, 2a, 3b, 3u and 3a, plus an "Allow Downgrade of PDF/A Compliance Level" option with an explanation. Server-side (plupload upload).
- **PDF2Go:** conformance levels described as "a setting, not a guess"; it also has a separate "Validate PDF/A" tool. Server workflow API.
- **PDF24:** "PDF to PDF/A" and a separate "Validate PDF/A".

**Build plan:**

- **Server is recommended**, as a worker endpoint `/convert/pdfa` running **Ghostscript** (`-dPDFA=2 -dPDFACompatibilityPolicy=1` with an sRGB ICC profile) or **LibreOffice** (re-export).
  - Validate the output with **veraPDF** (open source, Java) and show the report.
  - Levels: 1b, 2b, 3b first (most requested); "a" levels need tagged structure and should be offered only when the source is tagged.
- **Browser fallback (partial):** pdf-lib can add XMP metadata, an OutputIntent and remove forbidden features. Embedding missing fonts isn't practical in the browser, so don't claim conformance without validation.

**Size:** M (with the worker), L if validation UI and downgrade logic are included.

**Risks:**

- **Ghostscript is AGPL.** Running it as a network service may oblige releasing worker changes. The owner should get licence advice, or use LibreOffice + veraPDF (MPL/GPL with a classpath exception).
- Fonts that can't be embedded.
- Users assuming conformance without validation.

### 12. Repair PDF

**What it does:** recovers a damaged PDF (broken xref, truncated download) into one that opens. 5 competitors have it.

**Who offers it and how:**

- **PDF2Go, observed with the test file:** a "Start" button sends `POST dragon.pdf2go.com/api/workflows` (blocked here, so the file was never sent). So it's server-side. The page says it "rebuilds the file structure", "recovers what can be recovered" and "works on a copy".
- **PDF24** describes it as "Recover as much as possible from corrupt or broken PDF files".
- **Sejda:** "Recover data from a corrupted or damaged PDF document".

**Build plan:**

- **Browser first:**
  1. Try pdf-lib with `{ ignoreEncryption, throwOnInvalidObject: false }`, then rebuild by copying pages into a new document (`extractorFor` path).
  2. If that fails, open with pdf.js, which is very tolerant and rebuilds xref tables. Save each page as a vector copy where pdf-lib can read the objects, or rasterise it (reuse `rasterCompress`, then OCR).
  3. Report what was recovered: pages, text yes/no.
- **Optional server step:** `qpdf --recover` or `mutool clean` on the worker for files the browser can't open. Both are open source (qpdf Apache-2.0; MuPDF is AGPL, so the same licence caution as Ghostscript).

**Size:** S (browser), M (with the worker).

**Risks:** expectations, since some files are unrecoverable. Show a clear "nothing could be recovered" result instead of an empty PDF.

### 13. Compare PDFs

**What it does:** shows the differences between two versions of a document: text changes, plus visual overlay or slider. 3 competitors have it, and it's high-value for legal, contract and procurement users.

**Who offers it and how:**

- **PDF24, observed end to end with the test file in both slots:**
  - Two drop zones, "First file" and "Second file". After the second file, the comparison opens immediately.
  - View modes: **Side by side, Overlay, Swipe, Difference**, with ◀ ▶ change navigation, "Options" and "Export".
  - For identical files it reported "No differences found".
  - **Everything ran in the browser.** No POST was made; the page says files "are not uploaded to our servers".
  - Modules loaded: `pdfCompare.mjs`, `textIndex.mjs`, `normalize.mjs`, `diffCore.mjs`, `alignment.mjs`, `compareEngine.mjs`, `pixelDiff.mjs`, `ocrBridge.mjs` (OCR for scans), `report.mjs`, and pdf.js `pdf.mjs`/`pdf.worker.mjs`.
- **iLovePDF "Compare PDF":** two file inputs; the bundle `pdfcompare.<hash>.js` mounts an Apryse WebViewer web component (browser-side).
- **PDF2Go** lists Compare.

**Build plan:**

- **Browser only.** New `compare-pdf` tool with a two-file dropzone.
- **Text diff:** extract text per page with `lib/pdf/parse.ts`, normalise whitespace and hyphenation, then do a word-level diff with Myers/patience on the whole document so moved text still aligns. A small dependency such as `diff` (BSD) is enough.
- **Highlights:** map diff ranges back to pdf.js text item boxes, red for removed and green for added, drawn on the existing page renderer.
- **Visual modes:** overlay (two canvases with blend `difference`) and a swipe slider; pixel diff for image-only pages.
- **Scans:** fall back to the existing Tesseract OCR (`lib/pdf/ocr.ts`).
- **Export:** a summary report PDF listing the changes (pdf-lib), or the second PDF with highlight annotations.

**Size:** M.

**Risks:** documents whose pages have shifted need cross-page alignment; heavy documents need workers. `lib/pdf/worker.ts` exists.

### 14. Scan to PDF (phone camera)

**What it does:** uses a phone camera to photograph paper documents, with edge detection, cropping and perspective correction, and saves them as one PDF, optionally searchable. 4 competitors have it on the web, and every competitor's mobile app has it.

**Who offers it and how:**

- **iLovePDF "Scan to PDF":** desktop and phone pairing.
  1. Step 1 shows a QR code to scan with the smartphone.
  2. Step 2 shows connection status ("Disconnected" here) and "follow the instructions on your mobile screen, and tap Save".
  3. Options: page size Fit / A4 / US Letter, and "Merge all images in one PDF file".
  - The pairing relay host wasn't visible in the captured requests; only `scan.<hash>.js` and analytics loaded.
- **PDF24:** a "Scan PDF" tool. Its shared editor includes a `cameraScan.mjs` module that captures frames and encodes them to JPEG in the browser (`toBlob("image/jpeg")`), with a colour mode setting.
- **Smallpdf** lists "PDF Scanner"; **Foxit** lists "Scan to PDF & OCR".

**Build plan:**

- **Browser only** for the scan itself: a `scan-to-pdf` page using `getUserMedia` (rear camera).
  - Auto edge detection: a light approach is canvas edge detection plus a largest-quadrilateral search. OpenCV.js (Apache-2.0) is heavier but robust.
  - Manual corner adjustment, a perspective warp, and filters (colour / grey / B&W "document" threshold).
  - Multi-page capture tray with reorder.
- **Output:** feed the images into the existing `images-to-pdf` worker and offer the existing OCR to make it searchable.
- **Desktop to phone handoff (later):** a QR code linking to the scan page with a one-time Supabase Realtime channel (or a signed storage upload). The phone uploads the finished PDF and the desktop page downloads it.

**Size:** M (phone page), +M (QR handoff).

**Risks:** edge detection quality on low-end phones; iOS camera permissions in in-app browsers. The handoff passes the file through Supabase storage: keep it encrypted, short-lived and deleted after download.

### 15. More files to PDF: TXT / Markdown / RTF, and images beyond JPG/PNG

**What it does:** "TXT to PDF" (7 competitors) and image formats such as HEIC (iPhone photos), WebP, GIF, TIFF, BMP and SVG (4–6 competitors each) give many small high-intent search pages. PDF Wizard's JPG to PDF accepts only JPEG and PNG.

**Who offers it and how:** PDF24 has separate pages for webp, heic, svg, tiff, txt, rtf, epub, ps and markdown to PDF. PDF Candy and PDFgear also list HEIC, TXT and RTF to PDF. Processing method wasn't observed for these specific pages (no upload was made).

**Build plan:**

- **Browser only** for images and text:
  - Widen `jpg-to-pdf` `accept` and add search pages (`png-to-pdf`, `heic-to-pdf`, `webp-to-pdf`, …) that point to the same processor.
  - Decode WebP, GIF (first frame), BMP and SVG through `createImageBitmap` or canvas (SVG via `<img>`).
  - TIFF needs a decoder such as `utif` (MIT).
  - HEIC needs `libheif` wasm (LGPL) or `heic2any`, loaded only on demand.
- **TXT/Markdown to PDF:** lay out text with pdf-lib (wrap, page breaks, monospace option, embedded Unicode font for non-Latin text). The watermark tool's canvas fallback shows the font issue already met. Markdown can render to HTML and go through #3's renderer, or through a simple pdf-lib layout.
- **RTF/ODT** go through the LibreOffice endpoint from #1.

**Size:** S (images and TXT), +S each for HEIC/TIFF.

**Risks:** HEIC decoder size (~1 MB wasm); fonts for CJK text.

## 4. Considered and rejected (for now)

| Feature | Seen at | Why not in the top 15 |
|---|---|---|
| e-sign requests (send for signature, audit trail, reminders) | DocHub, Foxit, Soda on-site; iLoveSign, Sign.com, esigngear as sister products | High value but a product in itself: accounts for signers, email delivery, audit trail, legal compliance (ESIGN/eIDAS), storage of signed documents. That is a large build on Supabase and needs a deliberate decision on liability. Worth a separate study. |
| Header & footer, Bates numbering | Sejda, PDF Candy (Bates: Sejda only) | Low competitor count. Best done as an upgrade to the existing Page numbers tool (more positions, custom text, date, Bates prefix), which is an S task. |
| Grayscale / black & white | Sejda, PDF24, PDF Candy | Low demand. Vector grayscale needs content-stream colour rewriting; raster is easy but lossy. Could reuse `rasterCompress` later. |
| N-up, booklet, poster | Sejda, PDF24, PDF2Go | Niche. Falls out of #10's `embedPage` code cheaply afterwards. |
| Edit / remove metadata | Sejda, PDF24, PDF Candy | Low search demand. Trivial with pdf-lib; could be an "Advanced" panel in Protect, or part of Redact's clean-up. |
| Extract images | Sejda, PDF24, PDF2Go, PDF Candy | Medium-low demand. `lib/pdf/compress` already walks image XObjects, so it's a good S follow-up. |
| Watermark with image, more page-number options | Sejda (image watermark) | An enhancement of existing tools, not a new feature. Do alongside header/footer. |
| PDF to EPUB / EPUB to PDF | PDF24, PDF2Go, PDF Candy / Smallpdf, PDF24, PDF2Go, PDF Candy | Low demand. EPUB output from `parse.ts` structure is possible later. |
| PDF to TIFF / SVG / HTML / BMP / GIF | 2–4 each | Long tail. PNG and JPG cover most needs; TIFF could be an option in PDF to JPG. |
| Workflows / batch chains | iLovePDF (premium), PDF2Go workspace | Valuable for Pro users, but needs most of the above tools first. Revisit after. |
| Bookmarks, deskew, linearize, validate PDF/A, verify signatures, overlay, invert, halve pages, alternate & mix, flip, delete annotations, split by size, bookmarks or text | 1–2 each | Each has a single competitor or low demand. Deskew and validation fit later with OCR and PDF/A. |
| AI extras (question generator, extract facts, spellcheck, text-to-speech) | Smallpdf, PDF2Go | Single-competitor gimmicks. Chat with PDF already covers Q&A and summary. |
| Share by link, fax, kiosk signing | PDFescape, PDF2Go, DocHub | Off-model: they need stored documents and accounts. |
| Niche inputs (DjVu, DWG, XPS, MOBI, PUB, CBZ, …) | PDF Candy, PDF24 | Long tail. Several come free once the LibreOffice/Calibre-style server conversion exists. |
| Invoice and e-invoice tools | PDF24 | Region-specific (EN 16931) and outside the PDF-tools core. |

## 5. Notes on evidence quality

- **Observed directly** (screens, page text, scripts and network as captured by REA, plus the Playwright request log):
  - processing location for iLovePDF crop, PDF24 compare, PDFgear flatten and Sejda edit;
  - library fingerprints: Apryse WebViewer at iLovePDF, pdf.js and pdf-lib at PDFgear, pdf.js modules at PDF24;
  - option labels;
  - limits printed on pages (Sejda's free limits; iLovePDF's free versus premium table: limited tools, batch processing and file size on Free; Premium $5/month billed yearly with 2,000 AI credits; PDF/A marked Premium).
- **Inferred from page source, not from a run:**
  - PDF24 redact uploads and rasterises on the server (its `api.mjs` upload code and the save states);
  - iLovePDF redact and compare use Apryse (web component code in their bundles);
  - Smallpdf uses Apryse: only identifiers in the page source (an `internal-apryse-processing` route name and a blog slug about selling tools to Apryse). Its app scripts were blocked.
- **Not observed:**
  - Adobe Acrobat online and Xodo (blocked);
  - Smallpdf and PDF Candy tool behaviour (CDNs blocked);
  - PDFescape's editor (app host blocked).
- **From general knowledge, marked as such:**
  - search-demand judgements in the ranking;
  - licence notes: Ghostscript and MuPDF AGPL, qpdf Apache-2.0, veraPDF, libheif LGPL, OpenCV.js Apache-2.0, utif MIT, `diff` BSD;
  - the effort sizes.
