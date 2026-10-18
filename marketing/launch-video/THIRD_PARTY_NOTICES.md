# Third-party notices

The launch film's code, picture and sound are original to this project, except for the
material below. Nothing here is shipped with the PDF Wizard app; this folder only produces
video files.

## Code adapted into this project

### product-launch-motion (MIT)

`film/src/core.js` (closed-form spring step response, the summed-spring track, the blur
content swap, the log-zoom camera, edge-split stretch) and the price odometer in
`film/src/ui.js` are adapted from the code notes in `references/technique.md` of
product-launch-motion.

```
MIT License

Copyright (c) 2026 Abubakr Chan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### whaleyxbt's motion toolkit (MIT)

The integrated-loudness meter in `audio/dsp.py` (`lufs`) follows the structure of its
`sfx/loudness.py`, rewritten for numpy. Same MIT terms as above, with this notice:

```
Copyright (c) 2026 whaleyxbt
```

### Lucide icons (ISC)

`film/src/icons.js` holds icon shapes copied from `lucide-react` 0.487.0 (the version the
app uses) by `scripts/icons.mjs`.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Font

Inter, from the npm package `@fontsource/inter` 5.3.0, SIL Open Font License 1.1
(https://openfontlicense.org). The font files are not copied into this folder; the film
loads them from `node_modules`, and the rendered frames contain the type as pixels.

## Build tools (not shipped)

- Playwright 1.63.0 and Chromium: Apache-2.0 / BSD-style. Used to capture frames.
- FFmpeg 4.1 static build from `@ffmpeg-installer/linux-x64` 4.1.0: GPLv3. Used to blend,
  encode and measure. It is never distributed with the app or the videos.
- numpy, scipy, matplotlib (BSD-style licences): synthesize the sound and plot checks.
- pdf-lib (MIT), the app's own dependency: `scripts/demo-pdf.mjs` uses it to build the demo
  proposal.pdf behind the Compress result. The PDF is not shipped.

## Sound

All music and sound effects are original and synthesized in code (`audio/`). No samples,
loops, stock music or third-party sound files are used.

## References read, nothing copied

Several public motion-design and sound-design guides (MIT and Apache-2.0) were read as
guidance. No code, sounds or images from them are in this folder beyond what is listed above.
