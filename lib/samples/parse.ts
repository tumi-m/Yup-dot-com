/**
 * Reads the artist and song from a YouTube title (with its channel name) or
 * from what someone typed. Pure functions: no network, used on the server and
 * in the page.
 *
 * The reading is scored (0 to 1) so the page can be honest about it: a
 * "Artist - Title" from the artist's own channel is near certain, a bare
 * title from a reaction channel is a guess.
 */
import { cleanTitle } from "../media";
import { decamel, dice, hasWords } from "./normalize";
import type { ParsedSong, Variant } from "./types";

/** Words that only describe the upload, never the song. */
const DECOR_WORDS = new Set([
  "official", "oficial", "officiel", "offizielles", "ufficiale", "music", "musical", "musik", "musique", "musikvideo",
  "video", "vídeo", "vidéo", "videoclip", "videoclipe", "clip", "audio", "mv", "lyric", "lyrics", "letra", "letras",
  "legendado", "legendada", "tradução", "traducao", "traducción", "paroles", "testo", "sub", "subs", "subtitulado",
  "subtitulada", "español", "english", "eng", "han", "rom", "color", "colour", "coded", "visualizer", "visualiser",
  "hd", "hq", "uhd", "fhd", "remaster", "remastered", "remasterizado", "version", "versión", "explicit", "clean",
  "uncensored", "censored", "dirty", "radio", "edit", "album", "single", "mono", "stereo", "bonus", "track",
  "premiere", "full", "high", "quality", "new", "公式", "공식", "官方", "歌詞", "歌词", "가사", "歌詞付き", "字幕", "中字",
  "뮤직비디오", "官方mv", "with", "and", "&", "+", "/", "-",
]);
/** At least one of these makes a bracket or a trailing run decoration. */
const STRONG_DECOR = new Set([
  "official", "oficial", "officiel", "offizielles", "ufficiale", "mv", "lyric", "lyrics", "letra", "letras",
  "legendado", "legendada", "tradução", "traducao", "paroles", "visualizer", "visualiser", "hd", "hq", "uhd", "4k",
  "8k", "remaster", "remastered", "remasterizado", "explicit", "clean", "audio", "video", "videoclip", "musikvideo",
  "公式", "공식", "官方", "歌詞", "歌词", "가사", "歌詞付き", "뮤직비디오", "官方mv", "edit", "version", "mono", "stereo",
]);
const OFFICIAL = /\b(official|oficial|officiel|offizielles|ufficiale)\b|公式|공식|官方/i;

const CJK_QUOTES: [string, string][] = [["「", "」"], ["『", "』"], ["《", "》"], ["〈", "〉"], ["【", "】"]];

/** Penalties for uploads that usually aren't the song itself. The strongest one applies. */
const NEGATIVE: [RegExp, string, number][] = [
  [/\breact(?:s|ion|ing)?\b/i, "reaction", 0.5],
  [/\b(?:tutorial|lesson)\b|\bhow to (?:play|sing|make|draw)\b/i, "tutorial", 0.5],
  [/\btype ?beat\b/i, "type-beat", 0.5],
  [/\binterview\b/i, "interview", 0.5],
  [/\b\d+\s*(?:hours?|hrs?)\b|\bloop(?:ed)?\b/i, "long-loop", 0.4],
  [/\bfull album\b|\bplaylist\b|\bcompilation\b|\bmegamix\b|\bmashup\b|\bmedley\b|\bgreatest hits\b|\bbest of\b|\bnon[- ]?stop\b/i, "collection", 0.4],
];

/** The same words trailing a title: "Stronger REACTION!!", "Stronger 1 Hour Loop". */
const NEGATIVE_TRAIL =
  /\s+(?:(?:first time )?(?:react(?:s|ion|ing)?)|type ?beat|tutorial|lesson|interview|\d+\s*(?:hours?|hrs?)(?:\s+loop(?:ed)?)?|loop(?:ed)?)\b[\s!?.]*$/i;

const PRONOUNS = new Set(["me", "you", "us", "them", "her", "him", "it", "myself", "yourself", "the", "a"]);

interface Tags {
  official: boolean;
  variant: Variant | null;
  remixer: string | null;
  featured: string[];
  signals: string[];
}

function newTags(): Tags {
  return { official: false, variant: null, remixer: null, featured: [], signals: [] };
}

/** cleanTitle, then full-width forms folded (［ → [, ｜ → |, ： → :). */
function prepare(text: string): string {
  return cleanTitle(text).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function tokens(content: string): string[] {
  return content
    .toLowerCase()
    .replace(/\bm\/v\b/g, "mv")
    .split(/[\s,·・|/]+/)
    .filter(Boolean);
}

/** True when every word only describes the upload ("Official Music Video", "Remastered 2009", "Lyrics"). */
export function isDecoration(content: string): boolean {
  const c = content.trim().toLowerCase();
  if (!c) return true;
  if (/^from\s+["“'«(]|^from (?:the )?(?:motion picture|film|movie|series|soundtrack|original)\b|\bsoundtrack$|\bost$/.test(c)) return true;
  if (/^(?:original|radio|album|single)\s+(?:mix|edit|version)$/.test(c)) return true;
  const words = tokens(c);
  if (!words.length) return true;
  let strong = false;
  for (const w of words) {
    if (/^(?:19|20)\d{2}$/.test(w) || /^\d{3,4}p$/.test(w) || /^\d{1,2}k$/.test(w) || /^\d{2}fps$/.test(w)) {
      if (/k$/.test(w)) strong = true;
      continue;
    }
    if (!DECOR_WORDS.has(w)) return false;
    if (STRONG_DECOR.has(w)) strong = true;
  }
  return strong;
}

/** The kind of version a bracket or trailing segment names, if any. */
function variantOf(content: string): { variant: Variant; remixer: string | null } | null {
  const c = content.trim().toLowerCase();
  if (/\bcover\b/.test(c)) return { variant: "cover", remixer: null };
  const remix = /^(?:(.+?)\s+)?(?:remix|rmx|re-?edit)$/i.exec(content.trim()) ?? /^remix(?:ed)? by\s+(.+)$/i.exec(content.trim());
  if (remix) {
    const who = remix[1]?.trim() ?? null;
    return { variant: "remix", remixer: who && !/^(official|the)$/i.test(who) ? who : null };
  }
  if (/\blive\b|\b(?:ao|en) vivo\b|\bunplugged\b/.test(c)) return { variant: "live", remixer: null };
  if (/\bacoustic\b|\bac[uú]stic[oa]\b/.test(c)) return { variant: "acoustic", remixer: null };
  if (/\bdemo\b/.test(c)) return { variant: "demo", remixer: null };
  if (/\bextended\b|\bclub mix\b/.test(c)) return { variant: "extended", remixer: null };
  if (/\binstrumental\b/.test(c)) return { variant: "instrumental", remixer: null };
  if (/\bkaraoke\b/.test(c)) return { variant: "karaoke", remixer: null };
  if (/\bnightcore\b/.test(c)) return { variant: "nightcore", remixer: null };
  if (/\bsped[\s-]?up\b|\bspeed[\s-]?up\b/.test(c)) return { variant: "sped-up", remixer: null };
  if (/\bslowed\b|\breverb\b/.test(c)) return { variant: "slowed", remixer: null };
  if (/\b8d\b/.test(c)) return { variant: "8d", remixer: null };
  return null;
}

/** "B, C & D" → ["B", "C", "D"]. */
function splitNames(text: string): string[] {
  return text
    .split(/\s*(?:,|&|\band\b|\s[x×]\s)\s*/)
    .map((s) => s.trim())
    .filter((s) => hasWords(s));
}

const FEAT_BRACKET = /^(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i;
const PROD_BRACKET = /^prod(?:\.|uced)?(?:\s+by)?\s+.+$/i;
const FEAT_TRAILING = /\s+(?:\(|\[)?(?:feat\.|ft\.|feat|featuring)\s+(.+?)[)\]]?$/i;
const PROD_TRAILING = /\s+(?:\(|\[)?prod(?:\.|\s+by)\s*.+$/i;

/**
 * Takes every (…), […] and 【…】 out of the text that only decorates the
 * upload, names a version, or credits a guest. Anything else stays: it may
 * be part of the title ("(Don't Don't Do It)") or an alias ("(방탄소년단)").
 */
function stripBrackets(text: string, tags: Tags): string {
  return text
    .replace(/\s*[([【]([^()[\]【】]*)[)\]】]\s*/g, (whole, inner: string, offset: number, all: string) => {
      const content = inner.trim();
      const space = offset > 0 && offset + whole.length < all.length ? " " : "";
      if (isDecoration(content)) {
        if (OFFICIAL.test(content)) tags.official = true;
        tags.signals.push("decoration");
        return space;
      }
      const feat = FEAT_BRACKET.exec(content);
      if (feat) {
        tags.featured.push(...splitNames(feat[1]));
        return space;
      }
      if (PROD_BRACKET.test(content)) return space;
      // "(REACTION)", "[1 Hour]": already scored, and never part of the title.
      if (NEGATIVE.some(([re]) => re.test(content))) return space;
      const v = variantOf(content);
      if (v) {
        tags.variant ??= v.variant;
        tags.remixer ??= v.remixer;
        tags.signals.push(v.variant);
        return space;
      }
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops a trailing run of decoration words ("… Official MV", "… Lyrics"), never everything. */
function stripTrailingDecor(text: string, tags: Tags): string {
  const words = text.split(" ");
  let cut = words.length;
  let strong = false;
  while (cut > 1) {
    const w = words[cut - 1].toLowerCase().replace(/^m\/v$/, "mv");
    if (!DECOR_WORDS.has(w) || ["with", "and", "&", "+", "/", "-", "new", "full", "high", "single", "album", "radio", "track"].includes(w)) break;
    if (STRONG_DECOR.has(w)) strong = true;
    cut--;
  }
  if (!strong || cut === words.length) return text;
  const removed = words.slice(cut).join(" ");
  if (OFFICIAL.test(removed)) tags.official = true;
  tags.signals.push("decoration");
  return words.slice(0, cut).join(" ");
}

/** Emoji, stars and stray dashes at either end. */
function trimSymbols(text: string): string {
  return text
    .replace(/^[\s\p{Extended_Pictographic}\p{So}*~|•·\-–—:]+/u, "")
    .replace(/[\s\p{Extended_Pictographic}\p{So}*~|•·\-–—:]+$/u, "")
    .trim();
}

function unquote(text: string): string {
  const t = text.trim();
  const m = /^["“”'‘’「『《〈]([^"“”「」『』《》〈〉]+)["“”'‘’」』》〉]$/.exec(t);
  return m ? m[1].trim() : t;
}

/** Guests named after the title or the artist: "… ft. B", "… feat. B & C". */
function takeFeatured(text: string, tags: Tags): string {
  let out = text.replace(PROD_TRAILING, "");
  const m = FEAT_TRAILING.exec(out);
  if (m) {
    tags.featured.push(...splitNames(m[1]));
    out = out.slice(0, m.index);
  }
  return out.trim();
}

/** "BTS (방탄소년단)" → BTS with alias 방탄소년단; "周杰倫 Jay Chou" → both names. */
function artistNames(raw: string): { artist: string; aliases: string[] } {
  const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(raw);
  if (paren && hasWords(paren[1]) && hasWords(paren[2])) {
    return { artist: paren[1].trim(), aliases: [paren[2].trim()] };
  }
  const latin = /\p{Script=Latin}/u;
  const other = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u;
  const parts = raw.split(" ");
  for (let i = 1; i < parts.length; i++) {
    const left = parts.slice(0, i).join(" ");
    const right = parts.slice(i).join(" ");
    const leftOther = other.test(left) && !latin.test(left);
    const rightOther = other.test(right) && !latin.test(right);
    if ((leftOther && latin.test(right) && !other.test(right)) || (rightOther && latin.test(left) && !other.test(left))) {
      return { artist: left, aliases: [right] };
    }
  }
  return { artist: raw, aliases: [] };
}

/** The credit split into names, kept only when there are several ("A x B", "Simon & Garfunkel"). */
function creditParts(artist: string): string[] {
  const parts = splitNames(artist);
  return parts.length > 1 ? parts : [];
}

export interface ChannelInfo {
  /** The artist the channel stands for, as best we can tell. */
  name: string | null;
  /** "<Artist> - Topic": YouTube's own auto-generated artist channel. */
  topic: boolean;
  vevo: boolean;
}

export function readChannel(raw: string | null | undefined): ChannelInfo {
  const ch = prepare(raw ?? "");
  if (!ch) return { name: null, topic: false, vevo: false };
  const topic = /^(.+?)\s+-\s+Topic$/i.exec(ch);
  if (topic) return { name: topic[1].trim(), topic: true, vevo: false };
  const vevo = /^(.*?)\s*VEVO$/i.exec(ch);
  if (vevo && vevo[1]) return { name: decamel(vevo[1]), topic: false, vevo: true };
  let name = ch;
  for (let i = 0; i < 3; i++) {
    const next = name.replace(/\s*[-|]?\s*(?:official|music|tv|records|channel)$/i, "").trim();
    if (next === name || !next) break;
    name = next;
  }
  // "TaylorSwiftOfficial" style names lose the suffix above; split the camel case.
  if (!/\s/.test(name) && /\p{Ll}\p{Lu}/u.test(name)) name = decamel(name);
  return { name, topic: false, vevo: false };
}

function negatives(text: string, shorts: boolean, signals: string[]): number {
  let worst = 0;
  for (const [re, label, penalty] of NEGATIVE) {
    if (re.test(text)) {
      signals.push(label);
      worst = Math.max(worst, penalty);
    }
  }
  // A plain "mix" (a DJ set), but not a remix or a named version of the song.
  if (/\bmix\b/i.test(text) && !/\b(?:re|original|radio|club|extended|dub|album|single)[\s-]?mix\b/i.test(text)) {
    signals.push("mix");
    worst = Math.max(worst, 0.3);
  }
  let penalty = worst;
  if (shorts) {
    signals.push("shorts");
    penalty += 0.15;
  }
  return penalty;
}

function finish(p: Omit<ParsedSong, "confidence"> & { score: number }): ParsedSong {
  const { score, ...rest } = p;
  const featured = [...new Set(rest.featured)];
  return { ...rest, featured, confidence: Math.round(Math.min(1, Math.max(0, score)) * 100) / 100 };
}

/**
 * Splits on " - ", " | ", " ~ " and the long dashes; ": " only when nothing
 * else splits (it's common inside titles), and only once.
 */
function segments(text: string, dashesOnly = false): string[] {
  const parts = text.split(dashesOnly ? /\s+[-–—]\s+/ : /\s+[-–—|~]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 || dashesOnly) return parts;
  const colon = text.indexOf(": ");
  return colon > 0 ? [text.slice(0, colon).trim(), text.slice(colon + 2).trim()].filter(Boolean) : parts;
}

/** A trailing segment that names a cover, without catching titles like "Cover Me" or "Take Cover". */
const COVER_SEGMENT = /^(?:cover (?:by|from)\s+.+|(?:acoustic|piano|guitar|violin|cello|ukulele|drum|bass|vocal|sax|saxophone|harp|flute|metal|rock|jazz|lo-?fi)\s+cover)$/i;

/** `Artist 'Title'`, `Artist "Title"`, `Artist「Title」`, `Artist《Title》`, `【Title】`… */
function quoted(text: string): { artist: string; title: string } | null {
  for (const [open, close] of CJK_QUOTES) {
    const at = text.indexOf(open);
    const end = at >= 0 ? text.indexOf(close, at + 1) : -1;
    if (at >= 0 && end > at + 1) {
      const title = text.slice(at + 1, end).trim();
      const before = text.slice(0, at).trim();
      const after = text.slice(end + 1).trim();
      if (hasWords(title)) return { artist: before || after, title };
    }
  }
  const m =
    /^(.*?)\s*["“]([^"“”]+)["”]\s*(.*)$/.exec(text) ?? /^(.*?)(?:^|\s)['‘]([^'‘’]+)['’](?=\s|$)\s*(.*)$/.exec(text);
  if (m && hasWords(m[2])) return { artist: (m[1] || m[3]).trim(), title: m[2].trim() };
  return null;
}

/**
 * The song in a YouTube video's title. `channel` is the uploader's name;
 * `shorts`: the link was a /shorts/ link.
 */
export function parseVideoTitle(rawTitle: string, rawChannel: string | null, opts: { shorts?: boolean } = {}): ParsedSong {
  const tags = newTags();
  const channel = readChannel(rawChannel);
  let text = prepare(rawTitle);
  const shorts = !!opts.shorts || /#shorts\b/i.test(text);
  let score = 0.2 - negatives(text, shorts, tags.signals);

  // Hashtags trail most Shorts titles.
  text = text.replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, "").replace(/#shorts\b/gi, "").trim();
  text = trimSymbols(stripBrackets(text, tags));

  // A Topic channel's title is the track title: only " - Remastered 2009"
  // style suffixes come off it.
  const topic = channel.topic && !!channel.name;
  const all = segments(text, topic).map((s) => trimSymbols(s)).filter((s) => hasWords(s));
  // Segments that only describe the upload ("| Official Video"), or name a
  // version after the title ("- Live at Wembley"), are read and dropped.
  const firstVersionAt = topic ? 1 : 2;
  let segs = all.filter((s, i) => {
    if (all.length > 1 && isDecoration(s)) {
      if (OFFICIAL.test(s)) tags.official = true;
      tags.signals.push("decoration");
      return false;
    }
    if (i >= 1 && COVER_SEGMENT.test(s)) {
      tags.variant ??= "cover";
      tags.signals.push("cover");
      return false;
    }
    const v = i >= firstVersionAt && s.split(" ").length <= 6 ? variantOf(s) : null;
    if (v) {
      tags.variant ??= v.variant;
      tags.remixer ??= v.remixer;
      tags.signals.push(v.variant);
      return false;
    }
    return true;
  });
  if (!segs.length) segs = [text];
  // "… Official MV" with no brackets, at the end of what's left.
  segs[segs.length - 1] = stripTrailingDecor(segs[segs.length - 1], tags);
  if (tags.official) score += 0.05;

  let artist = "";
  let title = "";

  if (topic) {
    // YouTube's auto-generated artist channels: the video title is the track title.
    artist = channel.name!;
    title = segs.join(" - ");
    score += 0.6;
    tags.signals.push("topic");
  } else if (segs.length >= 2) {
    let left = segs[0];
    let right = segs.slice(1).join(" - ");
    score += 0.3;
    tags.signals.push("split");
    if (channel.name) {
      const l = dice(channel.name, takeFeatured(left, newTags()));
      const r = dice(channel.name, takeFeatured(right, newTags()));
      if (l >= 0.85) {
        score += 0.25;
        tags.signals.push("channel-match");
      } else if (r >= 0.85 && r > l) {
        [left, right] = [right, left];
        score += 0.2;
        tags.signals.push("swapped");
      }
    }
    artist = left;
    title = right;
  } else {
    const q = quoted(segs[0]);
    if (q && q.artist) {
      artist = stripTrailingDecor(trimSymbols(q.artist), tags);
      title = q.title;
      score += 0.25;
      tags.signals.push("quoted");
      if (channel.name && dice(channel.name, artistNames(artist).artist) >= 0.85) {
        score += 0.25;
        tags.signals.push("channel-match");
      }
    } else {
      // No split: the whole title is the song, and the channel may be the artist.
      title = q ? q.title : segs[0];
      artist = channel.name ?? "";
      if (channel.vevo) {
        score += 0.25;
        tags.signals.push("channel-match");
      } else {
        tags.signals.push("channel-guess");
      }
    }
  }

  title = trimSymbols(unquote(takeFeatured(title.replace(NEGATIVE_TRAIL, ""), tags)));
  const credit = trimSymbols(takeFeatured(artist, tags));
  const { artist: main, aliases } = artistNames(credit);

  return finish({
    artist: main,
    title: title || trimSymbols(text),
    artistAliases: aliases,
    artistParts: creditParts(main),
    featured: tags.featured,
    variant: tags.variant,
    remixer: tags.remixer,
    signals: [...new Set(tags.signals)],
    score,
  });
}

/**
 * What someone typed: "Artist – Title", "Artist - Title", "Title by Artist",
 * `Artist "Title"`, or just a title (or "kanye west stronger"), which is a
 * guess and is searched as free text.
 */
export function parseTyped(raw: string): ParsedSong {
  const tags = newTags();
  let text = trimSymbols(stripBrackets(prepare(raw), tags));
  text = stripTrailingDecor(text, tags);
  text = unquote(text);

  const done = (artist: string, title: string, score: number, signal: string) => {
    const credit = trimSymbols(takeFeatured(artist, tags));
    const { artist: main, aliases } = artistNames(credit);
    return finish({
      artist: main,
      title: trimSymbols(unquote(takeFeatured(title, tags))),
      artistAliases: aliases,
      artistParts: creditParts(main),
      featured: tags.featured,
      variant: tags.variant,
      remixer: tags.remixer,
      signals: [...new Set([...tags.signals, signal])],
      score,
    });
  };

  for (const sep of [" – ", " — ", " - ", " | "]) {
    const at = text.indexOf(sep);
    if (at > 0) {
      const left = text.slice(0, at).trim();
      const right = text.slice(at + sep.length).trim();
      if (hasWords(left) && hasWords(right)) return done(left, right, 0.8, "typed-split");
    }
  }
  const by = /^(.+)\s+by\s+(.+)$/i.exec(text);
  if (by && hasWords(by[1]) && hasWords(by[2]) && !PRONOUNS.has(by[2].trim().toLowerCase()) && by[2].trim().length > 2) {
    return done(by[2], by[1], 0.75, "typed-by");
  }
  const q = quoted(text);
  if (q && q.artist && hasWords(q.artist)) return done(q.artist, q.title, 0.8, "typed-quoted");
  return finish({
    artist: "",
    title: trimSymbols(text),
    artistAliases: [],
    artistParts: [],
    featured: tags.featured,
    variant: tags.variant,
    remixer: tags.remixer,
    signals: [...new Set([...tags.signals, "bare"])],
    score: 0.2,
  });
}

/** Words a TikTok /music/ link's slug gives ("Stronger-Kanye-West-6814…" → "Stronger Kanye West"). */
export function tiktokMusicSlug(pathname: string): string | null {
  const m = /^\/music\/([^/]+?)-(\d{8,25})\/?$/.exec(pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const words = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return hasWords(words) ? words.slice(0, 200) : null;
}
