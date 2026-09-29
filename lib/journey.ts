/**
 * Pure helpers behind the homepage's "what are you working on?" start:
 * which branch a dropped file or a URL hash belongs to, and where each
 * pasted link can go. Kept free of React so it can be unit tested.
 */
import { parseMediaUrl } from "./media";

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
  if (!isSlidesLink(input)) return [];
  const url = encodeURIComponent(input.trim());
  return [
    { label: "PDF", href: `/tools/google-slides-to-pdf?url=${url}` },
    { label: "PPTX", href: `/tools/google-slides-to-pptx?url=${url}` },
    { label: "Edit", href: `/tools/google-slides-to-pptx?url=${url}&then=edit` },
  ];
}

export function mediaActions(input: string): JourneyAction[] {
  const parsed = parseMediaUrl(input);
  if (!parsed) return [];
  const url = encodeURIComponent(input.trim());
  if (parsed.platform === "youtube") return [{ label: "MP4", href: `/tools/youtube-to-mp4?url=${url}` }];
  return [
    { label: "MP4", href: `/tools/x-to-mp4?url=${url}` },
    { label: "MP3", href: `/tools/x-to-mp3?url=${url}` },
  ];
}
