/**
 * Puts pictures of pages (drawn by pdf.js on the page, pictures.ts) in
 * those pages' places. The page object stays, so bookmarks and the page's
 * place in the structure still point at it; its content becomes the
 * picture, upright and cut to what showed. Links stay clickable, moved to
 * where they showed; other comments and fields are in the picture now, so
 * they go.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFDocument, type PDFObject } from "pdf-lib";
import { pageFrame } from "../page-frame";

const N = PDFName.of;

export async function splicePictures(doc: PDFDocument, pictures: PDFDocument, pages: number[]) {
  const copied = await doc.copyPages(pictures, pages.map((_, k) => k));
  pages.forEach((index, k) => {
    const page = doc.getPage(index);
    const frame = pageFrame(page);
    const target = page.node;
    const from = copied[k].node;
    const annots = target.lookup(N("Annots"));
    const links: PDFObject[] = [];
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        if (!(a instanceof PDFDict) || a.lookup(N("Subtype")) !== N("Link")) continue;
        moveRect(a, "Rect", frame);
        moveQuads(a, frame);
        links.push(annots.get(i));
      }
    }
    for (const key of ["CropBox", "TrimBox", "BleedBox", "ArtBox", "Rotate", "UserUnit", "Group", "Annots"]) target.delete(N(key));
    for (const key of ["MediaBox", "Contents", "Resources"]) {
      const value = from.get(N(key));
      if (value) target.set(N(key), value);
    }
    if (links.length) target.set(N("Annots"), doc.context.obj(links));
  });
}

function nums(arr: unknown): number[] | null {
  if (!(arr instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out;
}

function moveRect(dict: PDFDict, key: string, frame: ReturnType<typeof pageFrame>) {
  const r = nums(dict.lookup(N(key)));
  if (!r || r.length < 4) return;
  const a = frame.toDisplay(r[0], r[1]);
  const b = frame.toDisplay(r[2], r[3]);
  dict.set(N(key), dict.context.obj([Math.min(a.u, b.u), Math.min(a.v, b.v), Math.max(a.u, b.u), Math.max(a.v, b.v)]));
}

function moveQuads(dict: PDFDict, frame: ReturnType<typeof pageFrame>) {
  const q = nums(dict.lookup(N("QuadPoints")));
  if (!q) return;
  const out: number[] = [];
  for (let i = 0; i + 1 < q.length; i += 2) {
    const p = frame.toDisplay(q[i], q[i + 1]);
    out.push(p.u, p.v);
  }
  dict.set(N("QuadPoints"), dict.context.obj(out));
}
