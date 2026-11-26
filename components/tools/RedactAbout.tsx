import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Redact PDF: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "Its pages show one at a time, as they print."],
  ["Mark what to hide", "Draw boxes, find words, or mark every email, phone, card or ID number. Check the list."],
  ["Download", "Marked pages are rebuilt with the marks black, and the file is checked before you get it."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Why not just draw a black box in a PDF editor?",
    a: "A box drawn in an ordinary editor sits on top of the page. The words under it are still in the file: they can be copied, searched, or read once the box is moved. Redact PDF takes them out.",
  },
  {
    q: "What does it remove?",
    a: "Each page with a mark is rebuilt as a picture of the page with the marks painted black, so text, pictures and drawings under a mark are gone. Pages without marks stay as they are. From the whole file it also removes the document's details (title, author, subject and keywords) and XMP metadata, scripts, attached files and page thumbnails. On rebuilt pages, comments and form fields become part of the picture and links over a mark go. Bookmark titles that name redacted text are renamed, and anything left that nothing uses is dropped.",
  },
  {
    q: "How do I know it worked?",
    a: "Before the download is offered, the new file is opened again and read the way a PDF reader would read it, and every part of it is searched, packed and compressed parts included, for each redacted word and for the words that were under each box. If anything is left, nothing is saved and it says what was found and where.",
  },
  {
    q: "What if the same name is on other pages?",
    a: "Redact asks first. It lists every copy of the marked text that has no mark, so you can mark them too or choose to leave them.",
  },
  {
    q: "Is the rest of the page still searchable?",
    a: "Yes, if Keep the other words searchable is on: the words of a rebuilt page that aren't under a mark, or right next to one, are kept as invisible text over the picture. Turn it off and the rebuilt pages are pictures only. Scanned pages have no words to keep: run OCR PDF on the result to make them searchable.",
  },
  {
    q: "Which numbers can it find?",
    a: "Emails, phone numbers, card numbers (checked with the Luhn check card numbers carry), South African ID numbers (13 digits, a real birth date and the check digit), bank account-like numbers and IBANs, and dates. Always look through the list: a pattern can miss an unusual format or catch a number that only looks like one.",
  },
  {
    q: "Can I do it without a mouse?",
    a: "Yes. Search or pick what to find, then use the list to show, untick or remove each mark. Add a box puts one in the middle of the page: the arrow keys move it, Alt and the arrow keys resize it, Shift moves 10 times further, and Delete removes it.",
  },
  {
    q: "Does it work on locked PDFs?",
    a: "A PDF with only an owner password (no password to open it) is redacted as it is, and the result has no password. A PDF that needs a password to open has to be unlocked first.",
  },
];

export async function RedactAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is redacted and checked in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} and ${LIMITS.free.redactPages} pages with marks at a time free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} and ${LIMITS.pro.redactPages.toLocaleString("en-US")} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="redact-about">
      <div>
        <h2 id="redact-about" className="text-2xl font-bold tracking-tight text-foreground">
          Redact a PDF for good
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
