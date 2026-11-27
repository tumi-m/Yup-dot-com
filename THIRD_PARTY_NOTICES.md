# Third-party notices

PDF Wizard runs these open-source libraries in the visitor's browser. They are
used unmodified, at the versions pinned in `package-lock.json`. Full licence
texts ship with each package in `node_modules/<name>/`.

| Library | Version | Licence | Source |
| --- | --- | --- | --- |
| Mediabunny (video re-encoding) | 1.61.0 | MPL-2.0 | https://github.com/Vanilagy/mediabunny |
| ffmpeg.wasm core (MP3 conversion) | 0.12.10 | GPL-2.0-or-later | https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10 (FFmpeg: https://ffmpeg.org/download.html) |
| ffmpeg.wasm | 0.12.15 | MIT | https://github.com/ffmpegwasm/ffmpeg.wasm |
| jSquash JPEG (MozJPEG) | 1.6.0 | Apache-2.0; MozJPEG under the IJG and BSD licences | https://github.com/jamsinclair/jSquash, https://github.com/mozilla/mozjpeg |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate |
| PDF.js | 4.8.69 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| pdf-lib | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| @cantoo/pdf-lib | 2.11.1 | MIT | https://github.com/cantoo-scribe/pdf-lib |
| Tesseract.js and core | 7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js |
| JSZip | 3.10.1 | MIT (chosen from MIT or GPL-3.0) | https://github.com/Stuk/jszip |
| docx | 9.7.2 | MIT | https://github.com/dolanmiu/docx |
| Motion | 12.43.0 | MIT | https://github.com/motiondivision/motion |
| marked (Markdown to PDF) | 18.1.2 | MIT | https://github.com/markedjs/marked |
| fontkit, pdf-lib build (Text and Markdown to PDF) | 1.1.1 | MIT | https://github.com/Hopding/fontkit |
| UTIF.js, as utif2 (TIFF to PDF) | 4.1.0 | MIT | https://github.com/photopea/UTIF.js |
| pako (used by fontkit and UTIF.js) | 1.0.11 | MIT and Zlib | https://github.com/nodeca/pako |
| jsdiff, as diff (Compare PDFs) | 9.0.0 | BSD-3-Clause | https://github.com/kpdecker/jsdiff |
| uqr (QR code on Scan to PDF, after Project Nayuki's QR generator) | 0.1.3 | MIT | https://github.com/unjs/uqr |

## Fonts

Text and Markdown to PDF and Translate PDF embed Noto Sans and Noto Sans
Mono (Copyright 2022 The Noto Project Authors,
https://github.com/notofonts/latin-greek-cyrillic, and for Devanagari
https://github.com/notofonts/devanagari), licensed under the SIL Open Font
License 1.1, from the @fontsource packages at version 5.3.0. The font files are served from `/vendor/noto-sans/` and
`/vendor/noto-sans-mono/` with the licence beside them (`LICENSE.txt`), and
only the letters a document uses are embedded in its PDF.

The source code of the MPL-2.0 and GPL-licensed components is available at the
links above, for the exact versions listed.

## Data

The Sample Finder shows song relationships from
[MusicBrainz](https://musicbrainz.org), whose core data is in the public domain
(CC0 1.0). Credit isn't required; we give it on the tool's page anyway. The
hand-checked sample list in `lib/samples/catalog.ts` was written for this site
from widely published facts.
