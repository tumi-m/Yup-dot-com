import { headers } from "next/headers";
import type { OfficeTool } from "@/lib/office";
import { OFFICE_COPY } from "./office-copy";

/** Server-rendered copy under Word to PDF and Excel to PDF: how it works and questions. */
export async function OfficeAbout({ tool }: { tool: OfficeTool }) {
  const copy = OFFICE_COPY[tool];
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: copy.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="office-about">
      <div>
        <h2 id="office-about" className="text-2xl font-bold tracking-tight text-foreground">
          {copy.heading}
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {copy.steps.map(([title, body], i) => (
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
          {copy.faq.map((f) => (
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
        // Fixed copy from office-copy.ts; "<" is escaped so it can't close the tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
    </section>
  );
}
