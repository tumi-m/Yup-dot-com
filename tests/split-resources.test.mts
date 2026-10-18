// Split gave every part every image and font of the whole document when its
// pages share one resource dictionary, as LibreOffice Impress writes them and
// as many generators do by putting it on the page tree: 17 slides with photos
// split into 17 files the size of the whole deck. Each page now takes along
// only the resources its content uses; what a form draws, an inline image's
// colour space and the text's font stay, and a page whose content can't be
// read, or that draws a form taking names from the page, keeps them all.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import zlib from "node:zlib";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, StandardFonts, type PDFRef } from "pdf-lib";
import { splitTool, type ToolFile } from "../lib/pdf/toolkit.ts";
import { deletePages, extractFrom, extractPages } from "../lib/pdf/operations.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const file = (bytes: Uint8Array) => new File([bytes.slice() as unknown as BlobPart], "deck.pdf", { type: "application/pdf" });
const split = async (bytes: Uint8Array, mode: string, ranges = "") => {
  const out = await splitTool([file(bytes)], { mode, ranges });
  return Promise.all((Array.isArray(out) ? out : [out]).map(async (f: ToolFile) => new Uint8Array(await f.blob.arrayBuffer())));
};

/** Bytes that don't compress, the same on every run. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const NAMES = ["PicOne", "PicTwo", "PicThree"];
const TEXTS = ["Page one", "Page two", "Page three"];

/**
 * Three pages sharing one resource dictionary: three photos, a form, a font
 * and a colour space. Page 1 draws the first photo, page 2 the second, page 3
 * the form (which draws the third photo from its own resources) and an
 * inline image in the shared colour space. Each page also writes its name.
 */
async function deck(options: { onPageTree?: boolean; borrowingForm?: boolean; damagedPage?: number; unclosedArray?: number; missingName?: number } = {}) {
  const d = await PDFDocument.create();
  const ctx = d.context;
  const font = await d.embedFont(StandardFonts.Helvetica);
  const photos = NAMES.map((name, i) =>
    ctx.register(
      PDFRawStream.of(
        ctx.obj({ Type: "XObject", Subtype: "Image", Name: name, Width: 160, Height: 120, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }),
        noise(160 * 120 * 3, i + 1)
      )
    )
  );
  // A form with resources of its own draws the photo it names there; one
  // without them looks the name up in the page's.
  const form = ctx.register(
    ctx.flateStream(options.borrowingForm ? "q 160 0 0 120 0 0 cm /Im3 Do Q" : "q 160 0 0 120 0 0 cm /Photo Do Q", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 160, 120],
      ...(options.borrowingForm ? {} : { Resources: { XObject: { Photo: photos[2] } } }),
    })
  );
  const shared = ctx.register(
    ctx.obj({
      ProcSet: ["PDF", "Text", "ImageC", "ImageI"],
      Font: { F1: font.ref },
      XObject: { Im1: photos[0], Im2: photos[1], Im3: photos[2], Fm1: form },
      ColorSpace: { CS0: ctx.obj(["Indexed", "DeviceRGB", 3, PDFHexString.of("FF000000FF000000FFFFFF00")]) },
    })
  );
  const text = (i: number) => `BT /F1 24 Tf 40 340 Td (${TEXTS[i]}) Tj ET`;
  const contents = [
    `q 160 0 0 120 40 100 cm /Im1 Do Q ${text(0)}`,
    `q 160 0 0 120 40 100 cm /Im2 Do Q ${text(1)}`,
    `q 1 0 0 1 40 100 cm /Fm1 Do Q q 40 0 0 40 260 100 cm BI /W 2 /H 2 /CS /CS0 /BPC 8 /F /AHx ID 00010203> EI Q ${text(2)}`,
  ];
  const tree = d.catalog.Pages();
  if (options.onPageTree) tree.set(PDFName.of("Resources"), shared);
  contents.forEach((content, i) => {
    const page = d.addPage([400, 400]);
    if (options.onPageTree) page.node.delete(PDFName.of("Resources"));
    else page.node.set(PDFName.of("Resources"), shared);
    // An array that never closes (readers disagree about what follows it), or
    // a picture the resources don't have.
    const edited = options.unclosedArray === i ? `[ ${content}` : options.missingName === i ? `/Im9 Do ${content}` : content;
    let stream = ctx.flateStream(edited);
    if (options.damagedPage === i) {
      // Flate data cut short: what a reader makes of it is a guess.
      stream = PDFRawStream.of(ctx.obj({ Filter: "FlateDecode" }), zlib.deflateSync(Buffer.from(content)).subarray(0, -12));
    }
    page.node.set(PDFName.of("Contents"), ctx.register(stream));
  });
  return d.save();
}

/** The photos a file holds, by name. */
async function photosIn(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    out.push((obj.dict.get(PDFName.of("Name")) as PDFName).decodeText());
  }
  return out.sort();
}

/** What a reader draws on page `n`: its text, and how many images, inline images and forms. */
async function drawn(bytes: Uint8Array, n: number) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(n);
  const ops = (await page.getOperatorList()).fnArray as number[];
  const count = (op: number) => ops.filter((f) => f === op).length;
  const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join("");
  await doc.destroy();
  return {
    text,
    images: count(pdfjs.OPS.paintImageXObject),
    inline: count(pdfjs.OPS.paintInlineImageXObject),
    forms: count(pdfjs.OPS.paintFormXObjectBegin),
  };
}

/** The names page `n` can look up in its resources, as "Category/Name". */
async function resourceNames(bytes: Uint8Array, n: number): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const resources = doc.context.lookup(doc.getPage(n - 1).node.getInheritableAttribute(PDFName.of("Resources")), PDFDict);
  const out: string[] = [];
  for (const [category, value] of resources.entries()) {
    const dict = doc.context.lookup(value);
    if (dict instanceof PDFDict) for (const name of dict.keys()) out.push(`${category.decodeText()}/${name.decodeText()}`);
  }
  return out.sort();
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- Every page separately ---------------------------------------------------
for (const onPageTree of [false, true]) {
  const where = onPageTree ? "resources on the page tree" : "one resource dictionary for every page";
  const source = await deck({ onPageTree });
  check(`${where}: the source holds all three photos`, same(await photosIn(source), [...NAMES].sort()));
  const parts = await split(source, "every");
  check(`${where}: one part per page`, parts.length === 3, parts.length);
  for (let i = 0; i < 3; i++) {
    const part = parts[i];
    check(`${where}, page ${i + 1}: only its own photo`, same(await photosIn(part), [NAMES[i]]), await photosIn(part));
    const now = await drawn(part, 1);
    const before = await drawn(source, i + 1);
    check(`${where}, page ${i + 1}: draws what it drew, text and all`, same(now, before) && now.text === TEXTS[i], { now, before });
    check(`${where}, page ${i + 1}: much smaller than the whole`, part.length < source.length / 2, { part: part.length, source: source.length });
  }
  const third = await drawn(parts[2], 1);
  check(`${where}, page 3: the form draws its photo, and the inline image shows`, third.forms === 1 && third.images === 1 && third.inline === 1, third);
  // A reader draws an inline image even without its colour space, in the wrong colours.
  const names = await Promise.all(parts.map((part) => resourceNames(part, 1)));
  check(`${where}, page 1: names only its photo and font`, same(names[0], ["Font/F1", "XObject/Im1"]), names[0]);
  check(`${where}, page 3: names the form, the font and the inline image's colour space`, same(names[2], ["ColorSpace/CS0", "Font/F1", "XObject/Fm1"]), names[2]);
}

// --- Page ranges, extract and delete ----------------------------------------
const source = await deck();
const [firstTwo] = await split(source, "ranges", "1-2");
check("range 1-2: the photos of pages 1 and 2 only", same(await photosIn(firstTwo), ["PicOne", "PicTwo"]), await photosIn(firstTwo));
check("range 1-2: both pages keep their text", (await drawn(firstTwo, 1)).text === TEXTS[0] && (await drawn(firstTwo, 2)).text === TEXTS[1]);
const extracted = await extractPages(source, [1]);
check("extract page 2: its photo only", same(await photosIn(extracted), ["PicTwo"]), await photosIn(extracted));
check("extract page 2: draws what it drew", same(await drawn(extracted, 1), await drawn(source, 2)));
const deleted = await deletePages(source, [0, 1]);
check("delete pages 1 and 2: page 3's photo only", same(await photosIn(deleted), ["PicThree"]), await photosIn(deleted));
check("delete pages 1 and 2: page 3 draws what it drew", same(await drawn(deleted, 1), await drawn(source, 3)));
const reordered = await extractPages(source, [2, 0, 1]);
check("reorder: every photo stays", same(await photosIn(reordered), [...NAMES].sort()));

// --- When in doubt, a page keeps every resource --------------------------------
const borrowing = await deck({ borrowingForm: true });
const borrowed = (await split(borrowing, "every"))[2];
check("a form without resources of its own: its page keeps them all", same(await photosIn(borrowed), [...NAMES].sort()), await photosIn(borrowed));
check("a form without resources of its own: it still draws its photo", same(await drawn(borrowed, 1), await drawn(borrowing, 3)) && (await drawn(borrowed, 1)).images === 1);
const damaged = await split(await deck({ damagedPage: 1 }), "every");
check("content that can't be read: its page keeps every resource", same(await photosIn(damaged[1]), [...NAMES].sort()), await photosIn(damaged[1]));
const unclosed = await split(await deck({ unclosedArray: 0 }), "every");
check("content with an array that never closes: its page keeps every resource", same(await photosIn(unclosed[0]), [...NAMES].sort()), await photosIn(unclosed[0]));
const missing = await split(await deck({ missingName: 0 }), "every");
check("content naming a picture the resources don't have: its page keeps every resource", same(await photosIn(missing[0]), [...NAMES].sort()), await photosIn(missing[0]));
check("content that can't be read: the other pages still leave them out", same(await photosIn(damaged[0]), ["PicOne"]), await photosIn(damaged[0]));

// Copying a part out leaves the document it comes from as it was.
const src = await PDFDocument.load(source);
const one = await extractFrom(src, [0]);
const refs = src.getPages().map((p) => p.node.get(PDFName.of("Resources")) as PDFRef);
check("extractFrom: the part has its own photo only", same(await photosIn(one), ["PicOne"]), await photosIn(one));
check("extractFrom: the source pages still share one resource dictionary", refs.every((r) => r === refs[0]));
check("extractFrom: the source keeps every photo", same(await photosIn(await src.save()), [...NAMES].sort()));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
