import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Resize PDF: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "Any size, any mix of page sizes."],
  ["Pick the size", "A4, Letter and the other papers, or your own. The preview shows the first page."],
  ["Download", "Every page comes out the same size, still sharp."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Does it make the text blurry?",
    a: "No. Pages are scaled as they are, not turned into pictures, so text stays sharp and you can still select and search it.",
  },
  {
    q: "What do the fit choices do?",
    a: "Fit inside makes the page as big as it can be without cutting anything off. Fill the page covers the whole new page and crops what sticks out. Don't scale keeps the page at its size and centres it on the new one.",
  },
  {
    q: "My PDF has pages of different sizes. What happens?",
    a: "They all become the size you pick. With Keep each page's own, landscape pages stay landscape and portrait pages stay portrait.",
  },
  {
    q: "What happens to links, bookmarks, comments and forms?",
    a: "Links, bookmarks and comments move with their pages and still work. Form fields are flattened first: what's typed in them becomes part of the page, so it can't move out of place.",
  },
  {
    q: "What does pages per sheet do?",
    a: "It puts 2 or 4 pages side by side on each new page, to print handouts or save paper. Links, bookmarks and comments come along to the sheet.",
  },
  {
    q: "Is anything cut off taken out of the file?",
    a: "No. With Fill the page, what sticks out is hidden, not removed, so someone with the right software could still find it. Don't rely on it to hide anything private.",
  },
];

export async function ResizeAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is resized in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="resize-about">
      <div>
        <h2 id="resize-about" className="text-2xl font-bold tracking-tight text-foreground">
          Change the page size of a PDF
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
