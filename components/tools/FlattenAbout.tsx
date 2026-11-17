import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Flatten PDF: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "A filled-in form, a file with comments, or both."],
  ["Pick what to flatten", "Form fields, fields and comments, or every page as a picture."],
  ["Download", "What was typed and marked now looks the same in every reader, and can't be changed."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "What does each choice do?",
    a: "Form fields only paints what is typed, ticked and picked into the page, and leaves comments as they are. Fields and comments does the same for comments, highlights, stamps and drawings too. Pages as images turns every page into a picture, so nothing on it can be picked out or edited.",
  },
  {
    q: "Can I still select and search the text?",
    a: "Yes with the first two choices: only the fields and comments change, and links keep working. Pages as images has no text unless you tick Keep the text searchable, which lays the page's text over the picture, invisible.",
  },
  {
    q: "Can it be undone?",
    a: "No. A flattened field is part of the page, like printed text, so keep your original if you may need to fill it in again.",
  },
  {
    q: "Are the old values still hidden in the file?",
    a: "No. The fields and comments that are flattened are taken out of the file, along with what only they used, such as a file attached to a comment.",
  },
  {
    q: "Why did a field stay fillable?",
    a: "Its value has letters, such as Greek or Arabic, that the PDF's standard font can't draw. Rather than show nothing, the field is left as it was, and the result says so.",
  },
];

export async function FlattenAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is flattened in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="flatten-about">
      <div>
        <h2 id="flatten-about" className="text-2xl font-bold tracking-tight text-foreground">
          Lock form fields and comments into a PDF
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
