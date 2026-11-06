/**
 * Pure helpers behind the homepage's "what are you working on?" start:
 * which branch a dropped file or a URL hash belongs to, and where each
 * pasted link can go. Kept free of React so it can be unit tested.
 */
import { linkIn, parseMediaUrl, parsePlaylistUrl, YOUTUBE_ENABLED } from "./media";
import { finderForLink } from "./samples/links";

export type JourneyChoice = "pdf" | "pptx" | "slides" | "media";

export const JOURNEY_CHOICES: JourneyChoice[] = ["pdf", "pptx", "slides", "media"];

/** `#pdf`, `#pptx`, `#slides`, `#media` deep-link straight into a branch. */
export function choiceFromHash(hash: string): JourneyChoice | null {
  const key = hash.replace(/^#/, "").toLowerCase();
  return (JOURNEY_CHOICES as string[]).includes(key) ? (key as JourneyChoice) : null;
}

export type DroppedKind = "pdf" | "image" | "pptx" | "legacy-slides" | "other";

/** Classifies a file by extension first (browsers often leave `type` empty for Office files). */
export function fileKind(file: { name: string; type?: string }): DroppedKind {
  const name = file.name.toLowerCase();
  const type = (file.type ?? "").toLowerCase();
  if (name.endsWith(".pdf") || type === "application/pdf") return "pdf";
  if (/\.(png|jpe?g)$/.test(name) || type === "image/png" || type === "image/jpeg") return "image";
  if (name.endsWith(".pptx") || type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return "pptx";
  }
  if (/\.(ppt|pps|ppsx|pot|potx|key|odp)$/.test(name) || type === "application/vnd.ms-powerpoint") {
    return "legacy-slides";
  }
  return "other";
}

/** Which branch a set of dropped files should open, or null if none fit. */
export function choiceForFiles(files: { name: string; type?: string }[]): JourneyChoice | null {
  const kinds = files.map(fileKind);
  if (kinds.some((k) => k === "pdf" || k === "image")) return "pdf";
  if (kinds.some((k) => k === "pptx" || k === "legacy-slides")) return "pptx";
  return null;
}

const SLIDES_LINK = /^(?:https?:\/\/)?docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/([\w-]{20,})(?:[/?#]|$)/i;

/** True for a Google Slides share link (docs.google.com/presentation/d/<id>). */
export function isSlidesLink(input: string): boolean {
  return SLIDES_LINK.test(input.trim());
}

export interface JourneyAction {
  label: string;
  href: string;
}

export function slidesActions(input: string): JourneyAction[] {
  const link = linkIn(input);
  if (!isSlidesLink(link)) return [];
  const url = encodeURIComponent(link);
  return [
    { label: "PDF", href: `/tools/google-slides-to-pdf?url=${url}` },
    { label: "PPTX", href: `/tools/google-slides-to-pptx?url=${url}` },
    { label: "Edit", href: `/tools/google-slides-to-pptx?url=${url}&then=edit` },
  ];
}

/**
 * A tool page opened with ?url= from another site only fills in the box:
 * starting spends an import and saves a file, so it waits for a click. The
 * homepage leaves a note in this tab right before it sends the user on, and
 * the tool page starts by itself only when the note names the address it was
 * opened at. Reading the note clears it.
 */
const SENT_KEY = "pdf-wizard:sent";

type NoteStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStore(): NoteStore | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Path and query, the way the browser writes them. */
function address(href: string): string {
  const u = new URL(href, "http://localhost");
  return u.pathname + u.search;
}

export function markSent(href: string, store: NoteStore | null = tabStore()) {
  try {
    store?.setItem(SENT_KEY, address(href));
  } catch {
    /* site data blocked: the page will just fill in the box */
  }
}

/** True once, when the homepage sent the user to `href`. */
export function takeSent(href: string, store: NoteStore | null = tabStore()): boolean {
  try {
    const note = store?.getItem(SENT_KEY) ?? null;
    store?.removeItem(SENT_KEY);
    return note !== null && note === address(href);
  } catch {
    return false;
  }
}

/**
 * A playlist link goes to the playlist tool; one that also names a video
 * (watch?v=…&list=…) offers that single video too. A YouTube video can
 * always go to the Sample Finder, which only reads its title, so it works
 * while YouTube downloads are paused. Text around the link, as a phone's
 * share sheet copies it, is left behind.
 */
export function mediaActions(input: string, youtube: boolean = YOUTUBE_ENABLED): JourneyAction[] {
  const link = linkIn(input);
  const playlist = youtube ? parsePlaylistUrl(link) : null;
  const parsed = playlist ? playlist.video : parseMediaUrl(link);
  const actions: JourneyAction[] = playlist
    ? [{ label: "Playlist", href: `/tools/youtube-playlist?url=${encodeURIComponent(playlist.canonical)}` }]
    : [];
  if (!parsed) return actions;
  // Single videos are passed on as their canonical link, without the list.
  const url = encodeURIComponent(playlist ? parsed.canonical : link);
  if (parsed.platform === "youtube") {
    const samples: JourneyAction = { label: "Find samples", href: finderForLink(parsed.canonical) };
    // YouTube downloads are paused (lib/media.ts): finding samples still works.
    if (!youtube) return [samples];
    return [
      ...actions,
      { label: "MP4", href: `/tools/youtube-to-mp4?url=${url}` },
      { label: "MP3", href: `/tools/youtube-to-mp3?url=${url}` },
      samples,
    ];
  }
  return [
    { label: "MP4", href: `/tools/${parsed.platform}-to-mp4?url=${url}` },
    { label: "MP3", href: `/tools/${parsed.platform}-to-mp3?url=${url}` },
  ];
}

/** What the homepage's link box says under a link, or null. */
export function mediaNote(input: string, youtube: boolean = YOUTUBE_ENABLED): string | null {
  if (youtube) return null;
  const link = linkIn(input);
  if (parseMediaUrl(link)?.platform === "youtube") return "Downloads are paused. You can still find this song's samples.";
  return null;
}

/** Why a link in the homepage's video box has no actions. */
export function mediaHint(input: string, youtube: boolean = YOUTUBE_ENABLED): string {
  const link = linkIn(input);
  if (!youtube && !parseMediaUrl(link) && parsePlaylistUrl(link)) return "Paste one song's link to find its samples.";
  return "Paste a YouTube, X, TikTok or Instagram video link.";
}
