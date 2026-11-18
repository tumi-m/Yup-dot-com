/**
 * The copy under the files-to-PDF pages (JPG, PNG, WebP, HEIC, TIFF, SVG,
 * TXT and Markdown to PDF): how it works, and questions people ask. Plain
 * data, so tests can check every page has its own.
 */

export interface ConvertCopy {
  heading: string;
  steps: [string, string][];
  faq: { q: string; a: string }[];
}

const IMAGE_STEPS: [string, string][] = [
  ["Choose pictures", "One or many, in any mix of formats. Drag them into the order you want."],
  ["Pick the page", "A page the size of each picture, or A4, with or without a margin."],
  ["Download", "One PDF, a page for each picture."],
];

const IMAGE_FAQ = [
  {
    q: "Which formats can I use?",
    a: "JPG, PNG, WebP, GIF (its first frame), BMP, TIFF (every page), AVIF, HEIC and SVG, mixed as you like in one PDF. HEIC photos open in Safari only.",
  },
  {
    q: "Will my photos be the right way up?",
    a: "Yes. Phone photos are turned the way the camera recorded them, as they look in your gallery.",
  },
  {
    q: "Does it lower the quality?",
    a: "Not that you can see. A picture sharper than 300 DPI at its size on the page is scaled down to 300 DPI, the most a printer shows, which keeps the file small.",
  },
];

const TEXT_FAQ = [
  {
    q: "Which letters and languages work?",
    a: "Latin letters with any accents, Greek and Cyrillic, in an embedded font that every PDF reader shows the same. Chinese, Japanese, Korean, Arabic, Hebrew and Indian scripts aren't supported yet: those letters are left out, and the result says how many.",
  },
  {
    q: "Can I change how it looks?",
    a: "Pick A4 or Letter, narrow, normal or wide margins, a text size from 9 to 14 pt, and page numbers at the foot of each page. Monospace gives every letter the same width, for code and text laid out in columns.",
  },
];

export const CONVERT_COPY: Record<string, ConvertCopy> = {
  "jpg-to-pdf": {
    heading: "Turn pictures into a PDF",
    steps: IMAGE_STEPS,
    faq: IMAGE_FAQ,
  },
  "png-to-pdf": {
    heading: "Turn PNG images into a PDF",
    steps: IMAGE_STEPS,
    faq: [
      {
        q: "What happens to transparent areas?",
        a: "They stay transparent, so they show the white of the page. Screenshots and graphics are kept lossless; a PNG photo may be stored as a JPG when that is much smaller and looks the same.",
      },
      ...IMAGE_FAQ,
    ],
  },
  "webp-to-pdf": {
    heading: "Turn WebP images into a PDF",
    steps: IMAGE_STEPS,
    faq: [
      {
        q: "What about animated WebP images?",
        a: "The first frame goes on the page. A PDF page can't move.",
      },
      ...IMAGE_FAQ,
    ],
  },
  "heic-to-pdf": {
    heading: "Turn iPhone photos into a PDF",
    steps: IMAGE_STEPS,
    faq: [
      {
        q: "Why won't my HEIC photo open?",
        a: "Only Safari can read HEIC photos, on an iPhone, iPad or Mac. In Chrome, Edge or Firefox, save the photo as JPG first: on a Mac, open it in Preview and choose File > Export, then JPEG. On an iPhone, Settings > Camera > Formats > Most Compatible takes new photos as JPG.",
      },
      ...IMAGE_FAQ,
    ],
  },
  "tiff-to-pdf": {
    heading: "Turn TIFF files into a PDF",
    steps: IMAGE_STEPS,
    faq: [
      {
        q: "My TIFF has several pages. What happens?",
        a: "Each page becomes a page of the PDF, in order. Small preview copies some scanners store beside the pages are left out.",
      },
      {
        q: "Which TIFFs work?",
        a: "Most from scanners, fax software and photo editors: black and white, grey or colour, compressed or not. Pages larger than 50 megapixels are turned away, as they would take more memory than a phone has.",
      },
      ...IMAGE_FAQ,
    ],
  },
  "svg-to-pdf": {
    heading: "Turn SVG graphics into a PDF",
    steps: IMAGE_STEPS,
    faq: [
      {
        q: "Does the PDF keep the SVG as shapes?",
        a: "No. Each SVG is drawn as a picture at print resolution, up to 4096 pixels on its long side, so it prints sharp but can't be edited as shapes in the PDF.",
      },
      {
        q: "Why does my SVG look different?",
        a: "Fonts it names must be installed on your device, and pictures or styles it loads from the web aren't fetched. Labels written as HTML inside it, as some diagram apps do, are left out, with their plain-text stand-in drawn if the file has one. Scripts in an SVG never run.",
      },
      ...IMAGE_FAQ,
    ],
  },
  "txt-to-pdf": {
    heading: "Turn a text file into a PDF",
    steps: [
      ["Choose a text file", "Notes, a log, code or any .txt file."],
      ["Pick the layout", "Page size, margins, text size, font and page numbers."],
      ["Download", "Long lines wrap at the page edge and new pages start as each fills."],
    ],
    faq: [
      {
        q: "Which files work?",
        a: "Plain text in UTF-8, UTF-16 or Windows-1252, the encodings almost every editor saves in. Code, CSV, JSON and log files work too. Word, RTF and other formatted files aren't plain text.",
      },
      ...TEXT_FAQ,
      {
        q: "Can I start a new page where I want?",
        a: "Yes. A form feed character in the file starts a new page, as it does on a printer.",
      },
    ],
  },
  "markdown-to-pdf": {
    heading: "Turn Markdown into a PDF",
    steps: [
      ["Choose a Markdown file", "A README, notes or docs saved as .md."],
      ["Pick the layout", "Page size, margins, text size, font and page numbers."],
      ["Download", "Headings, lists, tables and code laid out on pages, links you can click."],
    ],
    faq: [
      {
        q: "What Markdown is supported?",
        a: "Headings, bold, italic, strikethrough, inline code, links (they can be clicked in the PDF), numbered, bulleted and task lists, nested lists, quotes, code blocks, horizontal rules and GitHub-style tables.",
      },
      {
        q: "What happens to HTML in the file?",
        a: "It isn't rendered. Tags are dropped and the words between them kept as text, and nothing in it runs.",
      },
      {
        q: "What about images?",
        a: "They aren't fetched, so nothing is loaded from the web. Their description shows in their place, as [Image: …].",
      },
      ...TEXT_FAQ,
    ],
  },
};
