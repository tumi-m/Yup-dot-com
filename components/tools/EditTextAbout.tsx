import Link from "next/link";
import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Edit PDF Text: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "It opens in the editor with Edit text on."],
  ["Click a line", "Type the new words. Change the size, bold, italic or colour, or remove the line."],
  ["Save or download", "The old words are taken out where they can be, and the new ones put in their place."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Are the old words really gone?",
    a: "Usually, yes. Where the page draws a line on its own, its old words are taken out of the file and the new ones drawn in their place, so the old ones can't be copied or found by a search. Where the page draws the line together with other text, or in a way that can't safely be changed, the old words are covered with a box in the page's colour instead, and the editor says so when you save. To take covered words out for good, use Redact PDF.",
  },
  {
    q: "Which font are the new words in?",
    a: "The line's own font when the file holds all of it and it has every letter you type. Most PDFs hold only the letters they use, so new words are usually in the closest standard font (Helvetica, Times or Courier, bold or italic to match), with Noto Sans for letters those lack, such as Polish, Czech, Greek or Cyrillic ones. The editor shows which font it will use.",
  },
  {
    q: "Can I change a whole paragraph?",
    a: "A line at a time: each line, or each part of a line in one font, size and colour, is changed on its own. Longer words don't flow on to the next line.",
  },
  {
    q: "What can't it change?",
    a: "Right-to-left text (Arabic, Hebrew) and text written top to bottom: the editor says so when you choose them. A scanned page is a picture with no text to change; run OCR PDF on it first. Chinese, Japanese and Korean letters and emoji can't be added yet.",
  },
  {
    q: "Does it work on turned pages?",
    a: "Yes. Text on turned pages, on pages cut from a larger sheet, and text set sideways is found where it shows, and the new words follow the same line.",
  },
  {
    q: "Can I do it without a mouse?",
    a: "Yes. Choose Edit text (or press E), and focus goes to the page's text: the arrow keys go from line to line, Enter opens one, Enter again is done and Escape puts back the words it had. Delete removes the line. Undo and Redo work as everywhere in the editor.",
  },
];

export async function EditTextAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is read and changed in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro. Saving or downloading the changed file counts as one edit: ${LIMITS.free.editsPerDay} a day free${LIMITS.free.watermark ? ", with a small \"Made with PDF Wizard\" mark in a corner of each page" : ""}; unlimited with Pro${LIMITS.pro.watermark ? "" : ", without the mark"}.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="edit-text-about">
      <div>
        <h2 id="edit-text-about" className="text-2xl font-bold tracking-tight text-foreground">
          Change the words in a PDF
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="rounded-2xl border border-border bg-card p-4">
              <span className="text-xs font-semibold text-primary">{i + 1}</span>
              <p className="mt-1 font-semibold text-foreground">{title}</p>
              <p className="mt-1">{body}</p>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground">Questions</h2>
        <dl className="mt-3 space-y-4">
          {all.map((f) => (
            <div key={f.q}>
              <dt className="font-semibold text-foreground">{f.q}</dt>
              <dd className="mt-1">{f.a}</dd>
            </div>
          ))}
        </dl>
      </div>
      <script
        type="application/ld+json"
        nonce={nonce}
        // Fixed copy from this file; "<" is escaped so it can't close the tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
    </section>
  );
}

/** Under Edit PDF: the editor changes existing text too. */
export function EditPdfAbout() {
  return (
    <section className="mx-auto mt-16 max-w-2xl text-sm leading-relaxed text-muted-foreground" aria-labelledby="edit-pdf-about">
      <h2 id="edit-pdf-about" className="text-lg font-semibold text-foreground">
        Change the text that&apos;s already there
      </h2>
      <p className="mt-2">
        The editor changes a PDF&apos;s own words as well as adding new ones. Choose Edit text (or press E), click a line and
        type; size, bold, italic and colour can be changed too, or the line removed. Where the old words can&apos;t safely be
        taken out of the file they are covered instead, and the editor says so when you save.{" "}
        <Link href="/tools/edit-pdf-text" className="font-medium text-foreground underline underline-offset-2">
          Edit PDF Text
        </Link>{" "}
        opens the editor ready for this.
      </p>
    </section>
  );
}
