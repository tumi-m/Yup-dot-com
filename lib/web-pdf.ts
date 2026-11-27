/**
 * HTML to PDF: a web page (by its address), an HTML file or pasted HTML,
 * opened and printed by the media worker (media-worker/render.py). Shared by
 * the page and /api/render/link. The worker enforces every network rule
 * itself, on every request the page makes; the checks here only turn away,
 * before an allowance is spent, what could never work.
 */

/**
 * Hidden (no page, no listing, no requests) until the media worker can
 * render: set NEXT_PUBLIC_ENABLE_HTML_TO_PDF=1 with MEDIA_WORKER_URL and
 * MEDIA_WORKER_SECRET, and redeploy. Public, because the tool lists are
 * built in the browser too.
 */
export const HTML_TO_PDF_ENABLED = process.env.NEXT_PUBLIC_ENABLE_HTML_TO_PDF === "1";

export type PageSize = "a4" | "letter" | "fit";
export type Orientation = "portrait" | "landscape";
export type Margins = "none" | "small" | "large";
export type PageMedia = "screen" | "print";

export interface WebPdfOptions {
  size: PageSize;
  orientation: Orientation;
  margins: Margins;
  /** Background colours and pictures, as on screen. */
  background: boolean;
  /** The page as it looks on screen, or the site's printer-friendly version. */
  media: PageMedia;
}

export const DEFAULT_OPTIONS: WebPdfOptions = { size: "a4", orientation: "portrait", margins: "small", background: true, media: "screen" };

/** Where Letter is the usual paper; A4 everywhere else. */
const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH", "CL", "CO", "VE", "GT", "PR", "DO", "CR", "PA", "SV", "NI", "HN", "BZ"]);

export function defaultSize(locale: string | undefined): PageSize {
  const region = locale?.match(/[-_]([A-Za-z]{2})\b/)?.[1]?.toUpperCase();
  return region && LETTER_REGIONS.has(region) ? "letter" : "a4";
}

export const SIZE_LABEL: Record<PageSize, string> = { a4: "A4", letter: "Letter", fit: "One long page" };
export const MARGIN_LABEL: Record<Margins, string> = { none: "None", small: "Small (10 mm)", large: "Large (20 mm)" };

/** The most HTML a page may send: RENDER_MAX_HTML_BYTES on the worker. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const HTML_NAME = /\.(x?html?|xht)$/i;

/** An HTML file, by name or type (a dropped file can come without either). */
export function isHtmlFile(file: { name: string; type?: string }): boolean {
  return HTML_NAME.test(file.name) || file.type === "text/html" || file.type === "application/xhtml+xml";
}

/** What the homepage asks for when a dropped file fits no tool. */
export function dropHint(office: boolean, html: boolean): string {
  if (!office && !html) return "Drop a PDF, image, text file or PPTX.";
  return `Drop a PDF, image, text${office ? ", Word, Excel" : ""}${html ? ", HTML" : ""} or PPTX file.`;
}

/** The options as render.py reads them in a grant. */
export function grantOptions(o: WebPdfOptions) {
  return { f: o.size, l: o.orientation === "landscape" ? 1 : 0, g: o.margins, b: o.background ? 1 : 0, p: o.media };
}

export type PageUrlProblem = "empty" | "invalid" | "scheme" | "credentials" | "private" | "local-name" | "port" | "not-found";

export const PAGE_URL_MESSAGE: Record<PageUrlProblem, string> = {
  empty: "Paste a web page's address.",
  invalid: "That isn't a web address. Check it and try again.",
  scheme: "Only http and https pages can be saved.",
  credentials: "Leave the user name and password out of the address: pages are opened signed out.",
  private: "That address is on a private or local network, so it can't be opened.",
  "local-name": "That's a name on a local network, so it can't be opened. Use the site's public address.",
  port: "That address uses a port that can't be opened.",
  "not-found": "We couldn't find that site. Check the address.",
};

/** Names that only mean something on a local network. */
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa|invalid|test|example)$/;

/**
 * A typed address as the worker gets it (https:// added when no scheme is
 * given, which is how people paste them), or why it can't be opened.
 */
export function webPageUrl(input: string): { url: string } | { problem: PageUrlProblem } {
  const raw = input.trim();
  if (!raw) return { problem: "empty" };
  if (raw.length > 2000 || /\s/.test(raw)) return { problem: "invalid" };
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  // "example.com:8080/x" reads as scheme "example.com": only a known scheme is one.
  const hasScheme = !!scheme && (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || ["file", "data", "javascript", "about", "blob", "chrome", "view-source", "mailto", "ftp", "ws", "wss"].includes(scheme));
  if (hasScheme && scheme !== "http" && scheme !== "https") return { problem: "scheme" };
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { problem: "invalid" };
  }
  if (url.username || url.password) return { problem: "credentials" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { problem: "invalid" };
  const port = url.port ? Number(url.port) : null;
  if (port !== null && port !== 80 && port !== 443 && port < 1024) return { problem: "port" };
  if (isIpLiteral(host)) {
    if (blockedAddress(host)) return { problem: "private" };
  } else {
    if (!host.includes(".") || LOCAL_NAME.test(host)) return { problem: "local-name" };
    if (!/^[a-z0-9.-]+$/.test(host) || host.split(".").some((l) => !l || l.length > 63)) return { problem: "invalid" };
  }
  url.hash = "";
  return { url: url.href };
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");
}

function ipv4Number(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** [network, prefix length] as render.py lists them. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function blockedV4(n: number): boolean {
  return BLOCKED_V4.some(([net, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4Number(net)!;
    return n >= start && n < start + size;
  });
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4Number(v4[1]);
    if (n === null) return null;
    text = text.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * True for an address a page may not reach: loopback, private, link-local
 * (cloud metadata), CGNAT, multicast, reserved, and IPv6 forms of those,
 * IPv4 inside IPv6 judged as the IPv4 address. An invalid one is blocked.
 */
export function blockedAddress(ip: string): boolean {
  const v4 = ipv4Number(ip);
  if (v4 !== null) return blockedV4(v4);
  const g = ipv6Groups(ip);
  if (!g) return true;
  const embedded = (g[6] * 65536 + g[7]) >>> 0;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (the old compatible form).
  if (zeros(5) && g[5] === 0xffff) return blockedV4(embedded);
  if (zeros(6)) return embedded <= 1 || blockedV4(embedded);
  // NAT64 64:ff9b::/96 reaches the IPv4 address in its last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(embedded);
  // 6to4 2002::/16 carries one in its second and third groups.
  if (g[0] === 0x2002) return blockedV4((g[1] * 65536 + g[2]) >>> 0);
  // Global unicast is 2000::/3; Teredo, documentation and IETF ranges in it aren't web hosts.
  if (g[0] < 0x2000 || g[0] > 0x3fff) return true;
  if (g[0] === 0x2001 && g[1] < 0x200) return true;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  return false;
}

/** HTML's size in bytes as the worker counts them (UTF-8). */
export function htmlBytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

/**
 * The text with any lone surrogate as U+FFFD, the way TextEncoder writes
 * it, so the worker's SHA-256 of what arrives matches the one the grant names.
 */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** SHA-256 (hex) of the HTML's UTF-8 bytes. */
export async function htmlDigest(html: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * An HTML file's text: by its byte order mark, else the charset its
 * <meta> names near the top (older pages are often windows-1252), else UTF-8.
 */
export function decodeHtml(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const charset = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // A name the browser doesn't know: UTF-8 below.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function formatHtmlLimit(): string {
  return `${MAX_HTML_BYTES / 1024 / 1024} MB`;
}
