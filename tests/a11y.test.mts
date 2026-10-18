import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { detectFormFields } from "../lib/pdf/forms.ts";
import { createCentred } from "../lib/editor/factory.ts";
import { annotationName, nudgeAnnotation, pageActionFocus, toolShortcut } from "../lib/editor/keyboard.ts";
import { DEFAULT_SETTINGS, type Annotation } from "../lib/editor/types.ts";
import { focusAfterRemove, movedMessage } from "../components/list-focus.ts";
import { slideProgressNote } from "../components/tools/progress-note.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Form fields are named by their /TU tooltip, as tax and government forms are built.
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const first = form.createTextField("topmostSubform[0].Page1[0].f1_01[0]");
  first.addToPage(page, { x: 50, y: 680, width: 250, height: 22 });
  first.acroField.dict.set(PDFName.of("TU"), PDFString.of("Your first name and middle initial"));
  const agree = form.createCheckBox("c1_1[0]");
  agree.addToPage(page, { x: 50, y: 640, width: 16, height: 16 });
  agree.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText("I agree to the terms"));
  const child = form.createTextField("address.street");
  child.addToPage(page, { x: 50, y: 600, width: 250, height: 22 });
  child.acroField.getParent()!.dict.set(PDFName.of("TU"), PDFString.of("Home address"));
  const plain = form.createTextField("zip");
  plain.addToPage(page, { x: 50, y: 560, width: 80, height: 22 });
  const blank = form.createTextField("blank");
  blank.addToPage(page, { x: 50, y: 520, width: 80, height: 22 });
  blank.acroField.dict.set(PDFName.of("TU"), PDFString.of("   "));
  const fields = await detectFormFields(await doc.save());
  const by = (name: string) => fields.find((f) => f.name === name);
  check("a text field takes its /TU as its label", by("topmostSubform[0].Page1[0].f1_01[0]")?.label === "Your first name and middle initial", by("topmostSubform[0].Page1[0].f1_01[0]"));
  check("a hex-string /TU is decoded", by("c1_1[0]")?.label === "I agree to the terms", by("c1_1[0]"));
  check("a field without /TU uses its parent's", by("address.street")?.label === "Home address", by("address.street"));
  check("no /TU leaves the label empty (the name is used)", by("zip")?.label === undefined, by("zip"));
  check("a blank /TU is ignored", by("blank")?.label === undefined, by("blank"));
}

// The editor works without a pointer: tools place their item in the middle of
// the view, and the arrow keys move and resize it.
{
  const page = { width: 612, height: 792 };
  const key = (k: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}) => ({ key: k, shiftKey: false, altKey: false, ...mods });
  const sig = createCentred("signature", DEFAULT_SETTINGS, 306, 396, page, { dataUrl: "data:image/png;base64,x" })!;
  check("a signature is placed centred on the point", sig?.x === 306 - sig.width / 2 && sig.y === 396 - sig.height / 2, sig);
  check("an image tool without an image places nothing", createCentred("signature", DEFAULT_SETTINGS, 306, 396, page) === null);
  check("freehand needs a pointer", createCentred("draw", DEFAULT_SETTINGS, 306, 396, page) === null);
  const rect = createCentred("rect", DEFAULT_SETTINGS, 306, 396, page)!;
  check("a drag tool gets a box to work with", rect.width >= 40 && rect.height >= 40, rect);
  const corner = createCentred("rect", DEFAULT_SETTINGS, 600, 5, page)!;
  check("a box placed near the edge stays on the page", corner.x + corner.width <= 612 && corner.y >= 0, corner);
  const line = createCentred("arrow", DEFAULT_SETTINGS, 306, 396, page)! as Extract<Annotation, { type: "shape" }>;
  check("a line placed from the keyboard has its end points", line.x1 === line.x && line.x2 === line.x + line.width && line.y1 === line.y2, line);
  check("every placeable tool gets a usable size", (["text", "note", "rect", "ellipse", "whiteout", "highlight", "underline", "strikeout", "link", "field-text", "field-checkbox", "field-radio", "field-dropdown"] as const).every((t) => {
    const a = createCentred(t, DEFAULT_SETTINGS, 306, 396, page);
    return !!a && a.width >= 4 && a.height >= 4;
  }));

  const right = nudgeAnnotation(sig, key("ArrowRight"), page)!;
  check("ArrowRight moves 1pt", right.x === sig.x + 1 && right.y === sig.y && right.width === sig.width, right);
  const down = nudgeAnnotation(sig, key("ArrowDown", { shiftKey: true }), page)!;
  check("Shift+ArrowDown moves 10pt", down.y === sig.y + 10 && down.x === sig.x, down);
  const wider = nudgeAnnotation(sig, key("ArrowRight", { altKey: true }), page)!;
  check("Alt+ArrowRight makes it wider and keeps it in place", wider.width === sig.width + 1 && wider.x === sig.x, wider);
  const shorter = nudgeAnnotation(sig, key("ArrowUp", { altKey: true, shiftKey: true }), page)!;
  check("Alt+Shift+ArrowUp makes it 10pt shorter", shorter.height === sig.height - 10, shorter);
  check("other keys are left alone", nudgeAnnotation(sig, key("a"), page) === null && nudgeAnnotation(sig, key("Enter"), page) === null);
  const atLeft = nudgeAnnotation({ ...sig, x: 0 }, key("ArrowLeft", { shiftKey: true }), page)!;
  check("it stops at the page edge", atLeft.x === 0, atLeft);
  const off = nudgeAnnotation({ ...sig, x: -30 }, key("ArrowLeft"), page)!;
  check("one already over the edge doesn't jump back", off.x === -30, off);
  let tiny = sig;
  for (let i = 0; i < 40; i++) tiny = nudgeAnnotation(tiny, key("ArrowLeft", { altKey: true, shiftKey: true }), page)!;
  check("resizing stops at the smallest size", tiny.width === 6, tiny.width);
  const moved = nudgeAnnotation(line, key("ArrowDown"), page)! as typeof line;
  check("a line moves with its end points", moved.y === line.y + 1 && moved.y1 === line.y1! + 1 && moved.y2 === line.y2! + 1, moved);
  const longer = nudgeAnnotation(line, key("ArrowRight", { altKey: true }), page)! as typeof line;
  check("Alt+arrow moves a line's end point", longer.x2 === line.x2! + 1 && longer.x1 === line.x1 && longer.width === line.width + 1, longer);

  check("annotations are named by kind and page", annotationName({ ...sig, page: 0 }) === "Signature, page 1", annotationName(sig));
  check("a rectangle reads as one", annotationName({ ...rect, page: 2 }) === "Rectangle, page 3", annotationName(rect));
  const text = createCentred("text", DEFAULT_SETTINGS, 306, 396, page)!;
  check("a text box is named by its text", annotationName({ ...text, text: "Hello  world" } as Annotation) === "Text: Hello world, page 1");
}

// Page panel actions hand focus back instead of dropping it to the page.
{
  check("after Rotate, focus is on Rotate again", JSON.stringify(pageActionFocus("rotate", 1, true, 12)) === JSON.stringify({ index: 1, action: "rotate", pages: 12 }));
  check("after an insert, focus is on the new page once it shows", JSON.stringify(pageActionFocus("insert", 1, true, 12)) === JSON.stringify({ index: 2, pages: 13 }));
  check("after a delete, focus is on the page now in its place", JSON.stringify(pageActionFocus("delete", 1, true, 12)) === JSON.stringify({ index: 1, pages: 11 }));
  check("after deleting the last page, focus is on the new last page", pageActionFocus("delete", 11, true, 12).index === 10);
  check("a failed action leaves focus on its button", JSON.stringify(pageActionFocus("delete", 3, false, 12)) === JSON.stringify({ index: 3, action: "delete", pages: 12 }));
}

// Single-key tool shortcuts can be turned off (WCAG 2.1.4).
{
  const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  check("T switches to Add text when shortcuts are on", toolShortcut(press("t"), true) === "text");
  check("Shift+T does too", toolShortcut(press("T"), true) === "text");
  check("nothing happens when they are off", toolShortcut(press("t"), false) === null && toolShortcut(press("s"), false) === null);
  check("a modifier key leaves the letter alone", toolShortcut(press("t", { ctrlKey: true }), true) === null && toolShortcut(press("t", { altKey: true }), true) === null && toolShortcut(press("t", { metaKey: true }), true) === null);
  check("unmapped keys do nothing", toolShortcut(press("q"), true) === null && toolShortcut(press("Enter"), true) === null);
}

// Chosen files: removing one keeps focus in the list; moving one says where it went.
{
  check("removing a file focuses the next row", focusAfterRemove(["a", "b", "c"], "a") === "b");
  check("removing the last row focuses the one before", focusAfterRemove(["a", "b", "c"], "c") === "b");
  check("removing the only file leaves no row (focus goes to Choose)", focusAfterRemove(["a"], "a") === null);
  check("moving a file says its new place", movedMessage("deck-text.pdf", 1, 3) === "deck-text.pdf moved to position 2 of 3");
}

// Converting a deck is announced at the start and each quarter, not per slide.
{
  const said: string[] = [];
  for (let done = 0; done <= 40; done++) {
    const note = slideProgressNote(done, 40, "Converting slides…");
    if (note !== said[said.length - 1]) said.push(note);
  }
  check("40 slides make at most 4 announcements", said.length <= 4, said);
  check("it starts by saying what is happening", said[0] === "Converting slides…", said);
  check("then counts quarters", said.slice(1).join(",") === "25% done,50% done,75% done", said);
  check("a one-slide deck says only the start", slideProgressNote(0, 1, "Exporting PDF…") === "Exporting PDF…" && slideProgressNote(1, 1, "Exporting PDF…") === "Exporting PDF…");
  check("finishing adds no announcement of its own", slideProgressNote(40, 40, "x") === slideProgressNote(39, 40, "x") && slideProgressNote(2, 2, "x") === slideProgressNote(1, 2, "x"));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
