"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Check, ExternalLink, RotateCcw, Share2 } from "lucide-react";
import { POP_IN } from "@/components/motion/primitives";
import { youtubeSearchUrl } from "@/lib/samples/links";
import type { SongRef, Variant, VideoInfo } from "@/lib/samples/types";
import { cn } from "@/lib/utils";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const VARIANT_NOTE: Record<Variant, string> = {
  live: "Live version: showing the song's connections.",
  acoustic: "Acoustic version: showing the song's connections.",
  demo: "Demo: showing the song's connections.",
  extended: "Extended version: showing the song's connections.",
  instrumental: "Instrumental: showing the song's connections.",
  karaoke: "Karaoke version: showing the song's connections.",
  "sped-up": "Sped-up version: showing the song's connections.",
  slowed: "Slowed version: showing the song's connections.",
  nightcore: "Nightcore version: showing the song's connections.",
  "8d": "8D version: showing the song's connections.",
  remix: "Remix: showing the original song's connections.",
  cover: "This video is a cover. Results are for the original.",
};

/** A record drawn in CSS, coloured from the title, for songs with no picture. */
function Vinyl({ seed }: { seed: string }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div
      aria-hidden
      data-testid="song-vinyl"
      className="h-full w-full"
      style={{
        background: `radial-gradient(circle, hsl(${h} 75% 62%) 0 17%, hsl(0 0% 8%) 18% 20%, transparent 21%), repeating-radial-gradient(circle, hsl(0 0% 10%) 0 2px, hsl(0 0% 16%) 2px 4px)`,
      }}
    />
  );
}

export function SongCard({
  song,
  video,
  variant,
  listen,
  shared,
  onShare,
  onNotThis,
  onReset,
  titleRef,
}: {
  song: SongRef;
  video: VideoInfo | null;
  variant: Variant | null;
  /** A video MusicBrainz links to this recording. */
  listen: string | null;
  shared: boolean;
  onShare: () => void;
  onNotThis: () => void;
  onReset: () => void;
  titleRef?: (el: HTMLElement | null) => void;
}) {
  const watch = video?.url ?? listen ?? youtubeSearchUrl(song.artist, song.title);
  // A thumbnail that doesn't load (blocked, removed) shows the drawn record instead.
  const [broken, setBroken] = useState<string | null>(null);
  const thumbnail = video?.thumbnail && video.thumbnail !== broken ? video.thumbnail : null;
  return (
    <div data-testid="song-card" className="rounded-3xl border border-border bg-card shadow-xl shadow-primary/5">
      <div className="flex gap-3 p-4 sm:gap-4 sm:p-5">
        <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-secondary sm:h-24 sm:w-24">
          {thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <motion.img
              {...POP_IN}
              data-testid="song-thumb"
              src={thumbnail}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setBroken(thumbnail)}
              className="h-full w-full object-cover"
            />
          ) : (
            <Vinyl seed={`${song.artist}|${song.title}`} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 ref={titleRef} tabIndex={-1} data-testid="song-title" className="line-clamp-2 break-words rounded text-lg font-bold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {song.title}
          </h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground" data-testid="song-artist">
            {song.artist || "Artist unknown"}
            {song.year ? ` · ${song.year}` : ""}
          </p>
          {video && (
            <p className="mt-1 truncate text-xs text-muted-foreground" data-testid="song-from">
              From ‘{video.title}’{video.channel ? ` · ${video.channel}` : ""}
            </p>
          )}
          {variant && <p className="mt-1 text-xs text-muted-foreground">{VARIANT_NOTE[variant]}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-5">
        <a
          href={watch}
          target="_blank"
          rel="noopener noreferrer"
          className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium transition-colors duration-fast hover:border-primary/50", focusRing)}
        >
          <ExternalLink className="h-4 w-4" aria-hidden /> Watch
          <span className="sr-only"> on YouTube (opens a new tab)</span>
        </a>
        <button
          type="button"
          data-testid="share"
          onClick={onShare}
          className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium transition-colors duration-fast hover:border-primary/50", focusRing)}
        >
          {shared ? <Check className="h-4 w-4 text-emerald-600" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
          {shared ? "Link copied" : "Share"}
        </button>
        <span className="ml-auto flex items-center gap-1 text-sm">
          <button
            type="button"
            data-testid="not-this-song"
            onClick={onNotThis}
            className={cn("inline-flex min-h-11 items-center rounded-lg px-2 font-medium text-primary hover:underline", focusRing)}
          >
            Not this song?
          </button>
          <button
            type="button"
            onClick={onReset}
            className={cn("inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-muted-foreground hover:text-foreground", focusRing)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> New search
          </button>
        </span>
      </div>
    </div>
  );
}
