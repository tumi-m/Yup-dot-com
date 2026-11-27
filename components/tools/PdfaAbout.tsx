import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under PDF to PDF/A: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "Pick PDF/A-2b, or PDF/A-3b to keep attached files. Add the password if it needs one to open."],
  ["Convert", "Fonts are embedded, a colour profile and archive details are added, and what PDF/A forbids is taken out."],
  ["Check and download", "The copy is checked against the rules we fix, and you see what passed and what changed."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "What is PDF/A?",
    a: "The ISO standard for PDFs kept for a long time. Everything needed to show the file is inside it: fonts, colour profile and details, and nothing that depends on scripts, other files or a password. Courts, universities and public bodies often ask for it.",
  },
  {
    q: "Which kind should I choose?",
    a: "PDF/A-2b, unless you were told otherwise. PDF/A-3b is the same but keeps attached files, such as an invoice's data. PDF/A-1b isn't offered: it forbids see-through drawing and needs lists of every letter in each embedded font, which would turn many pages into pictures.",
  },
  {
    q: "What changes in my file?",
    a: "Fonts that weren't in the file are embedded, using free look-alikes with the same letter widths (Arimo for Arial and Helvetica, Tinos for Times, Cousine for Courier), so text stays where it was. Form fields become part of the page. Scripts, sound, video and actions that open other things are removed, and with PDF/A-2b so are attached files. The password is removed.",
  },
  {
    q: "Why is a page a picture now?",
    a: "A few things can't be fixed in place, most often a font that isn't in the file and has no free look-alike, such as Wingdings. That page is drawn as a picture at 200 DPI with its text laid over it, invisible, so you can still search and copy it. The result names those pages.",
  },
  {
    q: "Is the check a certified validation?",
    a: "No. It is our own check of the rules this tool fixes, run on the finished file. For formal proof, open the file in the free veraPDF validator (verapdf.org), which courts and archives use.",
  },
];

export async function PdfaAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is converted in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="pdfa-about">
      <div>
        <h2 id="pdfa-about" className="text-2xl font-bold tracking-tight text-foreground">
          Make an archival copy of a PDF
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
        <p className="mt-4">
          <a href="https://verapdf.org" target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-2">
            veraPDF, the free PDF/A validator
          </a>
        </p>
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
