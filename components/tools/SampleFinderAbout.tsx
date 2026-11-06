import { headers } from "next/headers";
import { LIMITS } from "@/lib/limits";

/** Server-rendered copy under the Sample Finder: how it works, where the data comes from, and questions. */
const FAQ: { q: string; a: string }[] = [
  {
    q: "What's an interpolation?",
    a: "A part of an older song that was replayed or re-sung for the new one, instead of lifted from the original recording. We mark those as interpolations, never as samples.",
  },
  {
    q: "Why is a sample missing?",
    a: "MusicBrainz is written by volunteers and doesn't list every sample yet, and our own list covers the famous ones. If you know a sample that's missing, you can add it on MusicBrainz, and it shows up here once it's there.",
  },
  {
    q: "Does this download the video?",
    a: "No. We read the video's title and channel from YouTube's public oEmbed service, then search for that song. Nothing is downloaded.",
  },
  {
    q: "Can I look up TikTok sounds?",
    a: "Yes, when the TikTok uses a released song: paste the post's link and we read the sound's name. An original sound (the creator's own audio) isn't a song we can look up.",
  },
];

export async function SampleFinderAbout() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section className="mx-auto mt-16 max-w-2xl space-y-10 text-sm leading-relaxed text-muted-foreground" aria-labelledby="sample-finder-about">
      <div>
        <h2 id="sample-finder-about" className="text-2xl font-bold tracking-tight text-foreground">
          Find the samples in any song
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["Paste a link or type a song", "A YouTube or TikTok link, or Artist – Title."],
            ["We read the title", "Just the video's title and channel. We never download the video."],
            ["See its connections", "What it samples, where it was sampled, covers and remixes."],
          ].map(([title, body], i) => (
            <li key={title} className="rounded-2xl border border-border bg-card p-4">
              <span className="text-xs font-semibold text-primary">{i + 1}</span>
              <p className="mt-1 font-semibold text-foreground">{title}</p>
              <p className="mt-1">{body}</p>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground">Where the data comes from</h2>
        <p className="mt-2">
          <a href="https://musicbrainz.org" className="font-medium text-primary hover:underline" rel="noopener noreferrer" target="_blank">
            MusicBrainz
          </a>
          , an open music database written by its community and free for anyone to use (CC0), plus our own hand-checked list
          of famous samples, which also says what each one takes. Each result says which of the two it came from.
        </p>
        <p className="mt-2">
          Looking up a song uses one of your daily lookups ({LIMITS.guest.sampleLookupsPerDay} without an account,{" "}
          {LIMITS.free.sampleLookupsPerDay} with a free one, {LIMITS.pro.sampleLookupsPerDay} with Pro). Our hand-checked
          results, picking another match for the same search, and shared links are free.
        </p>
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
