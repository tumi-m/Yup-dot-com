import { headers } from "next/headers";
import { LIMITS, formatLimitBytes } from "@/lib/limits";

/** Server-rendered copy under Crop PDF: how it works and questions. */
const STEPS: [string, string][] = [
  ["Choose a PDF", "Its pages show one at a time, as they print."],
  ["Set the box", "Drag it, type the margins, or let it trim the white edges. Pick the pages it goes on."],
  ["Download", "The pages come out the size of the box."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is what I cut off deleted?",
    a: "Not unless you ask. A crop hides what's outside the box, so it no longer shows or prints, but it is still in the file and the right software can find it. Tick Remove what's outside the box to take it out for good: the cropped pages then become pictures of the area kept.",
  },
  {
    q: "What does Remove what's outside the box change?",
    a: "Each cropped page is redrawn as a picture of the area kept, at the quality you pick. Text inside stays searchable and links inside still work; comments and form fields become part of the picture. Text that runs across the edge of the box isn't searchable, since that would bring back the words cut off.",
  },
  {
    q: "How does Trim white margins work?",
    a: "Each page is looked at on its own and cut to its content, with a little space left round it. Blank pages stay as they are. The preview shows the result for the page you're on before you save.",
  },
  {
    q: "Can I crop only some pages?",
    a: "Yes. Apply the box to all pages, the page you're looking at, odd or even pages, or pages you type, like 2-4, 7. The same margins come off each page you pick.",
  },
  {
    q: "Can I do it without a mouse?",
    a: "Yes. Tab to the box and use the arrow keys to move it, Alt and the arrow keys to resize it, and Shift to move 10 times further. Or type the margins in millimetres, inches or points.",
  },
  {
    q: "What happens to links, comments and form fields?",
    a: "Those inside the box, or partly inside, stay and still work. Those wholly outside it are taken out.",
  },
  {
    q: "Will the pages print at the new size?",
    a: "Yes. The page's media, crop, trim, bleed and art boxes are all set to the area kept, so viewers and printers agree on the size.",
  },
];

export async function CropAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const all = [
    ...FAQ,
    {
      q: "Is my file uploaded?",
      a: `No. It is cropped in your browser and never leaves your device. Files up to ${formatLimitBytes(LIMITS.free.maxFileBytes)} free, ${formatLimitBytes(LIMITS.pro.maxFileBytes)} with Pro.`,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: all.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="crop-about">
      <div>
        <h2 id="crop-about" className="text-2xl font-bold tracking-tight text-foreground">
          Crop the pages of a PDF
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
