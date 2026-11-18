import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Compare PDFs: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose two PDFs", "The original and the changed version. Swap them if they went in the wrong way round."],
  ["Compare", "Every word is checked, over the whole file, so text that moved to another page still lines up."],
  ["Review", "Step through the changes on the pages, or lay the pages over each other. Download a report."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "How are the changes shown?",
    a: "Words taken out are struck through in red on the original. Words put in are underlined in green on the changed version. Moved words get a dashed blue line, and pictures that look different a dashed orange box. The lines and boxes tell them apart without the colours.",
  },
  {
    q: "What if a page was added or taken out?",
    a: "The pages are paired by the words they share, so a page added or taken out in the middle shows on its own, and the pages after it still line up with their own.",
  },
  {
    q: "Does it see changes in pictures, charts or the layout?",
    a: "Pages without text, such as scans, are always compared by how they look. Tick Also compare pictures and drawings to do that on every page. Overlay lays one page over the other with a slider, and Difference shows which pixels changed.",
  },
  {
    q: "Can it compare scanned PDFs?",
    a: "By how they look, yes. To compare their words, make them searchable with OCR PDF first, then compare the results.",
  },
  {
    q: "What do I get to download?",
    a: "A report PDF listing every change with its pages, and copies of both files with the changes marked as comments that any PDF viewer shows. The pages themselves are left as they were.",
  },
  {
    q: "Can I do it without a mouse?",
    a: "Yes. Press N for the next change and P for the previous one, or Tab to the list and press Enter on a change to show it on the pages.",
  },
  {
    q: "Does it work on password-protected files?",
    a: "A file that only limits printing or copying is compared as it is. One that needs a password to open has to be unlocked first with Unlock PDF.",
  },
];

export async function CompareAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Are my files uploaded?",
      a: `No. Both are compared in your browser and never leave your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} and ${LIMITS.free.comparePages.toLocaleString("en-US")} pages each free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} and ${LIMITS.pro.comparePages.toLocaleString("en-US")} pages with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="compare-about">
      <div>
        <h2 id="compare-about" className="text-2xl font-bold tracking-tight text-foreground">
          See what changed between two PDFs
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
