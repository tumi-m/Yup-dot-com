import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";
import type { PagesMode } from "@/lib/pdf/pages/plan";

/** Server-rendered copy under Organize PDF, Delete pages and Extract pages: how it works and questions. */
const COPY: Record<PagesMode, { heading: string; steps: [string, string][]; faq: { q: string; a: string }[] }> = {
  organize: {
    heading: "Put the pages in the order you want",
    steps: [
      ["Choose a PDF", "Every page shows as a thumbnail."],
      ["Move, turn and delete", "Drag pages, or pick them and use the buttons. Add blank pages or another PDF's pages."],
      ["Save", "Download the new PDF. Undo works until you save."],
    ],
    faq: [
      {
        q: "Can I add pages from another PDF?",
        a: "Yes. Add PDF puts its pages at the end, and you move them where you want. Its form fields come along too.",
      },
      {
        q: "Does turning a page change its quality?",
        a: "No. Pages are moved and turned as they are, without being redrawn, so text stays sharp and searchable.",
      },
      {
        q: "Are links and bookmarks kept?",
        a: "Yes, for the pages that stay. Links and bookmarks to pages you delete are taken out, so none of them lead nowhere.",
      },
      {
        q: "How do I do it with the keyboard?",
        a: "Tab to the pages, then use the arrow keys to move around, Space to pick a page and Alt with an arrow key to move it. Delete removes it and Ctrl+Z undoes.",
      },
    ],
  },
  delete: {
    heading: "Take out the pages you don't need",
    steps: [
      ["Choose a PDF", "Every page shows as a thumbnail."],
      ["Pick the pages", "Tap them, or type page numbers like 2-4, 7."],
      ["Delete", "Download the PDF without them."],
    ],
    faq: [
      {
        q: "Is anything else of the deleted pages left in the file?",
        a: "No. Pictures, fonts and form fields only those pages used go with them, so the file gets smaller too.",
      },
      {
        q: "What stays?",
        a: "The other pages exactly as they were, with their form fields and values, links, bookmarks and the document's title.",
      },
      {
        q: "Can I delete every page?",
        a: "No, a PDF needs at least one page. To get rid of all of them, delete the file itself.",
      },
    ],
  },
  extract: {
    heading: "Save some pages as their own PDF",
    steps: [
      ["Choose a PDF", "Every page shows as a thumbnail."],
      ["Pick the pages", "Tap them, or type page numbers like 2-4, 7."],
      ["Extract", "Download one new PDF with just those pages."],
    ],
    faq: [
      {
        q: "How is this different from Split PDF?",
        a: "Extract pages makes one PDF of the pages you pick. Split PDF makes a separate file for each range or each page.",
      },
      {
        q: "What comes along with the pages?",
        a: "Their form fields, notes, links between them, bookmarks to them and the document's title. Nothing of the other pages does.",
      },
      {
        q: "Does the original change?",
        a: "No. Your file stays as it is; the pages are copied into a new one.",
      },
    ],
  },
};

export async function PagesAbout({ mode }: { mode: PagesMode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const { heading, steps, faq } = COPY[mode];
  const all = [
    ...faq,
    {
      q: "Is my file uploaded?",
      a: `No. It is read and saved in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="pages-about">
      <div>
        <h2 id="pages-about" className="text-2xl font-bold tracking-tight text-foreground">
          {heading}
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {steps.map(([title, body], i) => (
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
