// Any site could link to /tools/google-slides-to-pdf?url=… and the importer
// started on its own: it spent one of the visitor's imports and saved the
// linked deck without a click. Now only the homepage's own hand-off starts it;
// a link from anywhere else just fills in the box.
import { readFileSync } from "node:fs";
import { markSent, slidesActions, takeSent } from "../lib/journey.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

/** One tab's sessionStorage. */
function tab() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

/** What the tool page sees in the address bar after following `href`. */
const arrived = (href: string) => {
  const u = new URL(href, "http://localhost:3501");
  return u.pathname + u.search;
};

const deck = "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit";
const [pdf, pptx, edit] = slidesActions(deck);

// A foreign page sets location.href: nothing was left by the homepage.
const foreign = tab();
check("link from another site: doesn't start", takeSent(arrived(pdf.href), foreign) === false);
check("link from another site to Edit: doesn't start", takeSent(arrived(edit.href), foreign) === false);

// The homepage marks the action right before it navigates.
for (const a of [pdf, pptx, edit]) {
  const t = tab();
  markSent(a.href, t);
  check(`homepage ${a.label}: starts`, takeSent(arrived(a.href), t) === true);
  check(`homepage ${a.label}: only once (Back, reload or a later link)`, takeSent(arrived(a.href), t) === false);
  check(`homepage ${a.label}: the note is gone`, t.size() === 0);
}

// The note names one address; arriving anywhere else clears it.
const other = tab();
markSent(pdf.href, other);
const theirs = slidesActions("https://docs.google.com/presentation/d/ZZZZZZZZZZZZZZZZZZZZ999/edit")[0];
check("another deck than the one sent: doesn't start", takeSent(arrived(theirs.href), other) === false);
check("and the note is cleared", other.size() === 0 && takeSent(arrived(pdf.href), other) === false);

const swap = tab();
markSent(pptx.href, swap);
check("PPTX sent, Edit arrived: doesn't start", takeSent(arrived(edit.href), swap) === false);

// Storage the browser won't give: fills in the box, never throws.
const blocked = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  removeItem: () => {},
};
let threw = false;
try {
  markSent(pdf.href, blocked);
  check("site data blocked: doesn't start", takeSent(arrived(pdf.href), blocked) === false);
} catch {
  threw = true;
}
check("site data blocked: no throw", !threw);
check("no tab storage at all: doesn't start", takeSent(arrived(pdf.href)) === false);

// The pages are wired to it.
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const importer = src("components/tools/SlidesImporter.tsx");
check("importer starts from ?url= only when sent", /const sent = takeSent\(/.test(importer) && /if \(sent\) void run\(/.test(importer));
check("importer has no other start from ?url=", (importer.match(/, link, true\)/g) ?? []).length === 1);
const hero = src("components/landing/HeroJourney.tsx");
check("homepage marks both the chips and Enter", (hero.match(/markSent\(/g) ?? []).length === 2);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
