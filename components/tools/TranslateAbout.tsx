import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";
import { LANGUAGES } from "@/lib/translate/languages";

/** Server-rendered copy under Translate PDF: how it works and questions. */
const chars = (n: number) => n.toLocaleString("en-US");
// About 3,000 characters to a page of plain text.
const pages = (n: number) => Math.round(n / 3000);

const STEPS: [string, string][] = [
  ["Choose a PDF", "Its text is read in your browser: headings, paragraphs, lists and tables, in reading order."],
  ["Pick a language", `${LANGUAGES.length} languages, including all of South Africa's official languages.`],
  ["Download", "A Word file you can edit, and a PDF, with the headings, lists and tables kept."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is my file uploaded?",
    a: `No. The PDF is read in your browser. Only its text is sent to our translation service (a language model), a page's worth at a time, to be translated, and nothing is kept once it's done. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
  },
  {
    q: "How good is the translation?",
    a: "It is machine translation. Quality varies by language: widely written languages usually read well, while less widely written ones, some South African languages among them, can have mistakes. Have anything important checked by a person before you rely on it.",
  },
  {
    q: "How much can I translate?",
    a: `As a guest, ${chars(LIMITS.guest.translateCharsPerDay)} characters a day (about ${pages(LIMITS.guest.translateCharsPerDay)} pages). With a free account, ${chars(LIMITS.free.translateCharsPerDay)} (about ${pages(LIMITS.free.translateCharsPerDay)} pages). With Pro or Team, ${chars(LIMITS.pro.translateCharsPerDay)} (about ${pages(LIMITS.pro.translateCharsPerDay)} pages). Numbers, dates and text repeated on every page count once or not at all.`,
  },
  {
    q: "Does it keep the layout?",
    a: "It keeps the structure: headings, paragraphs, lists and tables, in reading order. Pictures, columns, fonts and exact positions aren't kept: the text is laid out afresh.",
  },
  {
    q: "Which languages come as a PDF?",
    a: "Languages written in Latin, Greek, Cyrillic or Devanagari letters come as a Word file and a PDF. Others, such as Arabic, Hebrew, Chinese, Japanese and Korean, come as a Word file only for now, because the PDF font doesn't have their letters yet. Arabic, Hebrew, Persian and Urdu are set right to left.",
  },
  {
    q: "What about scanned pages?",
    a: "A scan is a picture of text, so there's nothing to translate yet. Run OCR PDF on it first to make it searchable, then translate the result.",
  },
  {
    q: "What if part of it isn't translated?",
    a: "A passage the service doesn't return, even after a second try, stays in the original language in its own place, and the result says how many and on which pages.",
  },
  {
    q: "Can I stop it?",
    a: "Yes. Cancel stops it at once and nothing is kept. What was already sent counts toward the day's allowance.",
  },
];

export async function TranslateAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="translate-about">
      <div>
        <h2 id="translate-about" className="text-2xl font-bold tracking-tight text-foreground">
          Translate a PDF into another language
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
          {FAQ.map((f) => (
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
