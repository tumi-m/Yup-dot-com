import { headers } from "next/headers";
import { LIMITS } from "@/lib/limits";
import { formatHtmlLimit } from "@/lib/web-pdf";

/** Server-rendered copy under HTML to PDF: how it works and questions. */

const STEPS: [string, string][] = [
  ["Paste an address", "Or choose an .html file, or paste HTML. Pick A4, Letter or one long page if you like."],
  ["We open it", "A browser on our server loads the page as a signed-out visitor, with no cookies, and prints it."],
  ["Download", "Your PDF keeps the page's text selectable and its links working. We delete it once you have it."],
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is the page or my HTML uploaded?",
    a: "Yes, this tool can't work in your browser alone. The address (or your HTML) goes to our server, where a browser opens it and makes the PDF. The PDF is deleted from our server as soon as you download it, or after about two minutes if you don't. We don't keep the address, the HTML or the PDF.",
  },
  {
    q: "What about pages behind a login or a cookie banner?",
    a: "They come out as a signed-out visitor sees them: our browser has no cookies, passwords or sign-ins, and never uses yours. A page that needs a login shows its login screen, and a cookie banner stays on the page. To save something only you can see, use your browser's Print and choose Save as PDF.",
  },
  {
    q: "Which pages can't be saved?",
    a: "Addresses on a private or local network (such as 192.168.x.x, localhost or a company intranet), anything that isn't http or https, files that download instead of opening, and sites that block automatic visits. Videos and live connections aren't loaded, and a page gets up to a minute.",
  },
  {
    q: "What's the difference between “As on screen” and “Print version”?",
    a: "As on screen keeps the page's menus, colours and layout. Print version uses the site's own printer-friendly styles, if it has any, which often leave out menus and adverts.",
  },
  {
    q: "What does “One long page” do?",
    a: "The whole page becomes a single tall PDF page, as wide as a computer screen, so nothing is split between pages. Very long pages are cut into pages 200 inches (about 5 m) tall.",
  },
  {
    q: "Do pictures in my HTML file show?",
    a: `Pictures, styles and fonts that are on the web (an address starting https://) load. Files next to the HTML on your device aren't sent, so pictures given as a file name (like photo.jpg) are left out. HTML up to ${formatHtmlLimit()}.`,
  },
  {
    q: "How many can I save?",
    a: `As a guest, ${LIMITS.guest.webPdfsPerDay} pages a day; with a free account, ${LIMITS.free.webPdfsPerDay}; with Pro or Team, ${LIMITS.pro.webPdfsPerDay}. Each PDF has up to ${LIMITS.free.webPdfPages} pages free, ${LIMITS.pro.webPdfPages} with Pro. Each try counts, even when the site doesn't answer.`,
  },
];

export async function WebToPdfAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="web-pdf-about">
      <div>
        <h2 id="web-pdf-about" className="text-2xl font-bold tracking-tight text-foreground">
          Save a web page as a PDF
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
          {FAQ.map((f) => (
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
