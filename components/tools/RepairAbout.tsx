import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Repair PDF: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "One that won't open, shows an error, or opens with pages missing."],
  ["Repair", "Its structure is rebuilt and every page that can be read is put back."],
  ["Download", "A new copy that opens, and a list of what came back and what didn't."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "What can it fix?",
    a: "Files cut off by a download that stopped, files with extra data before or after the PDF, a broken or missing index, damaged object streams, a missing catalog and a page list that loops or has holes.",
  },
  {
    q: "Why is a page a picture now?",
    a: "Part of that page, often a font, was too damaged to copy as it was, so it was drawn the way a reader shows it. Its text is laid over the picture, invisible, so you can still search and copy it.",
  },
  {
    q: "Will my form fields and bookmarks still work?",
    a: "Yes, on the pages that are copied as they were. Fields on a page that became a picture are part of the picture, and the result says so.",
  },
  {
    q: "What if nothing can be recovered?",
    a: "You are told plainly, and no file is made. A file cut off before its first page arrived, or damaged throughout, has nothing left to save.",
  },
  {
    q: "Does it work on password-protected files?",
    a: "A file that needs a password to open has to be unlocked first with Unlock PDF. One that only limits printing or copying is repaired, and the copy has no limits.",
  },
];

export async function RepairAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is repaired in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="repair-about">
      <div>
        <h2 id="repair-about" className="text-2xl font-bold tracking-tight text-foreground">
          Fix a PDF that won&apos;t open
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
