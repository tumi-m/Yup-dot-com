// Slide editor helpers (lib/pptx/editor.ts).
import { History, paragraphsToText, parseSlidePart, shareUnchanged, textToParagraphs } from "../lib/pptx/editor.ts";
import type { DeckSlide } from "../lib/pptx/parse.ts";
import { parsePptx } from "../lib/pptx/parse.ts";
import { getSlideTexts, listSlides, openDeck, saveDeck, setShapeText } from "../lib/pptx/package.ts";
import { buildPptx, para, slideXml, sp } from "./pptx-fixture.mts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

/* ---------------- text <-> paragraphs ---------------- */
{
  check("paragraphs to text", paragraphsToText(["a", "b\nc"]) === "a\nb\nc");
  check("same line count keeps line breaks", JSON.stringify(textToParagraphs(["a", "b\nc"], "A\nb\nC")) === JSON.stringify(["A", "b\nC"]));
  check("new line count: one paragraph per line", JSON.stringify(textToParagraphs(["a", "b\nc"], "a\nb")) === JSON.stringify(["a", "b"]));
  check("added line becomes a paragraph", JSON.stringify(textToParagraphs(["a", "b"], "a\nb\nc")) === JSON.stringify(["a", "b", "c"]));
  check("CRLF normalised", JSON.stringify(textToParagraphs(["a"], "x\r\ny")) === JSON.stringify(["x", "y"]));
  check("empty text is one empty paragraph", JSON.stringify(textToParagraphs(["a", "b"], "")) === JSON.stringify([""]));
}

/* ---------------- history ---------------- */
{
  const h = new History<number>(0, () => 1, 3);
  check("nothing to undo at start", !h.canUndo && h.undo() === null);
  h.push(1);
  h.push(2);
  check("undo returns previous", h.undo() === 1 && h.current === 1 && h.canRedo);
  check("redo returns next", h.redo() === 2 && !h.canRedo);
  h.undo();
  h.push(5);
  check("push clears redo", !h.canRedo && h.current === 5);
  for (let i = 10; i < 20; i++) h.push(i);
  check("bounded by step count", h.steps === 3);
  const big = new History<number>(0, (n) => n, 100, 10);
  big.push(4);
  big.push(4);
  big.push(4);
  check("bounded by size, oldest dropped", big.steps === 1, String(big.steps));
}

/* ---------------- one-slide render ---------------- */
{
  const slides = [1, 2, 3].map((n) =>
    slideXml(sp(2, "Title", { ph: '<p:ph type="title"/>', box: [36, 20, 648, 90], paras: para(`Title ${n}`) }), n === 2)
  );
  const bytes = await buildPptx(slides, [3, 1, 2]);
  const deck = await openDeck(bytes);
  const texts = getSlideTexts(deck, 1);
  setShapeText(deck, 1, texts[0].id, ["Changed"]);
  const saved = await saveDeck(deck);
  const parts = listSlides(deck).map((s) => s.part);
  const one = await parseSlidePart(saved, parts[1]);
  const full = await parsePptx(saved);
  const textOf = (s: { elements: { content?: string }[] }) => s.elements.map((e) => e.content ?? "").join(" ");
  check("one-slide parse shows the edit", textOf(one).includes("Changed"), textOf(one).slice(0, 80));
  // `order` is pptxtojson's running shape counter: only its order within a slide matters.
  const shape = (els: object[]) => JSON.stringify(els.map((e) => ({ ...e, order: 0 })));
  check("one-slide parse matches full parse", shape(one.elements) === shape(full.slides[1].elements));
  check("one-slide parse keeps part and hidden flag", one.part === parts[1] && one.hidden === full.slides[1].hidden);
  const other = await parseSlidePart(saved, parts[2]);
  check("other slides untouched", textOf(other).includes("Title\u00a02") || textOf(other).includes("Title&nbsp;2"), textOf(other).replace(/<[^>]+>/g, ""));
  check("hidden flag from the slide", other.hidden === true);
}

/* ---------------- sharing unchanged data after a re-parse ---------------- */
{
  const img = "data:image/png;base64," + "A".repeat(4000);
  const mk = (text: string): DeckSlide =>
    ({
      number: 1,
      hidden: false,
      fill: { type: "image", value: { base64: img.slice(0) + "" } },
      elements: [
        { type: "image", id: "3", base64: (img + " ").trim() },
        { type: "group", id: "4", elements: [{ type: "image", id: "5", base64: [img].join("") }] },
        { type: "text", id: "2", content: text },
      ],
      layoutElements: [{ type: "image", id: "9", base64: img }],
      note: "",
      part: "ppt/slides/slide1.xml",
    }) as unknown as DeckSlide;
  const prev = mk("old");
  const next = mk("new");
  const out = shareUnchanged(prev, next);
  const els = out.elements as unknown as { base64?: string; content?: string; elements?: { base64?: string }[] }[];
  const prevEls = prev.elements as unknown as typeof els;
  check("layout shapes reused", out.layoutElements === prev.layoutElements);
  check("image data unchanged", els[0].base64 === prevEls[0].base64 && els[1].elements![0].base64 === prevEls[1].elements![0].base64);
  check("edited text kept", els[2].content === "new" && out.part === prev.part);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
