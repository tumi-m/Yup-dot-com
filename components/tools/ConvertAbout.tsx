import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";
import { CONVERT_COPY } from "./convert-copy";

/** Server-rendered copy under the files-to-PDF pages: how it works and questions. */
export async function ConvertAbout({ slug }: { slug: string }) {
  const copy = CONVERT_COPY[slug];
  if (!copy) return null;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...copy.faq,
    {
      q: "Are my files uploaded?",
      a: `No. They are converted in your browser and never leave your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="convert-about">
      <div>
        <h2 id="convert-about" className="text-2xl font-bold tracking-tight text-foreground">
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
        // Fixed copy from convert-copy.ts; "<" is escaped so it can't close the tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
    </section>
  );
}
