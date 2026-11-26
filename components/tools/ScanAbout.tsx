import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Scan to PDF: how it works and questions. */
const STEPS: [string, string][] = [
  ["Photograph each page", "Open the camera on your phone, or choose photos you've taken. Lay the page flat in good light."],
  ["Check the corners", "The page's edges are found for you. Drag a corner if it's off, then pick colour, grey or black and white."],
  ["Download", "One PDF, a flat page for each photo, in the order you set."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need an app?",
    a: "No. It works in your phone's browser. On a computer, scan the code on this page with your phone to open it there, or use a webcam or photos you already have.",
  },
  {
    q: "What does Document do?",
    a: "It makes the page black and white like a photocopy. Shadows and uneven light are evened out first, so the paper comes out white and the writing black.",
  },
  {
    q: "Can I make the PDF searchable?",
    a: "Yes. Tick Make it searchable and pick the document's language. The text is read on your device and added invisibly over each page, so you can search and copy it.",
  },
  {
    q: "What page size will I get?",
    a: "Fit makes each page the shape of the paper you scanned. A4 and Letter put each scan on that paper size, turned to suit it.",
  },
  {
    q: "Can I do it without a mouse or touch?",
    a: "Yes. Tab to a corner and use the arrow keys to move it, with Shift to move it further. Pages move earlier or later with their buttons, or Alt and the arrow keys.",
  },
  {
    q: "Why does the camera ask for permission?",
    a: "Your browser asks before any site can use the camera. Only this page can ask; the rest of the site can't use the camera at all. If you say no, you can still take photos with your camera app and choose them here.",
  },
];

export async function ScanAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Are my photos uploaded?",
      a: `No. The camera, the photos and the PDF all stay in your browser and never leave your device. Up to ${LIMITS.free.maxBatchFiles} pages a scan free, ${LIMITS.pro.maxBatchFiles} with Pro; photos up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="scan-about">
      <div>
        <h2 id="scan-about" className="text-2xl font-bold tracking-tight text-foreground">
          Scan paper to PDF with your phone
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
