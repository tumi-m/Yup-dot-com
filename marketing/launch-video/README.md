# PDF Wizard launch film: "Cast a spell"

A 38-second launch film (16:9 master at 60 fps, plus a vertical 9:16 cut at 30 fps) built as
one web page whose every frame is drawn from the time alone, then captured with Chromium and
encoded with FFmpeg. Music and sound effects are original and made in code. No voice: the
words on screen carry it, so it works muted.

## Render it

Needs Node 20+, Python 3.10+ and about 2 GB of free disk.

```bash
cd marketing/launch-video
npm install                       # Inter, Playwright, a static FFmpeg build (build tools only)
python3 -m venv .venv && .venv/bin/pip install -r audio/requirements.txt

npm run draft                     # 30 fps half-size check, about 3 minutes
npm run render:16x9               # master, 60 fps with motion blur, about 45 minutes on 4 cores
npm run render:9x16               # vertical cut, 30 fps, about 30 minutes
npm run cues                      # sound cues, read from the film itself
.venv/bin/python audio/build.py   # score + effects -> out/audio/mix.wav at -14 LUFS
npm run master                    # adds sound; writes everything to out/deliver/
```

If Playwright's own Chromium is not installed, point `CHROME_PATH` at any Chromium binary
(the scripts also look under `PLAYWRIGHT_BROWSERS_PATH` and `/opt/pw-browsers`).

To watch it in a browser while editing: `npm run preview` and open the printed link
(space plays, arrows step a frame, shift+arrows a beat, `?t=12.5` jumps, `?fmt=9x16` for vertical).

## How it is put together

| Path | What it does |
|---|---|
| `film/timeline.json` | Every beat by name. Retime the film here; picture and sound both read it. |
| `film/src/core.js` | Springs, the Spell Tile, camera, cursor, captions, background and grain. |
| `film/src/ui.js` | The app's screens rebuilt in HTML/CSS from its own tokens and Lucide icons. |
| `film/src/scenes.js` | The choreography: what happens on each named beat, for both formats. |
| `audio/` | `music.py` (score), `sfx.py` (effects from the cue list), `build.py` (mix and master), `viz.py` (waveform check). |
| `scripts/` | `render.mjs`, `snap.mjs` (stills and contact sheets), `qa.mjs` (checks on the MP4), `cues.mjs`, `master.mjs`. |

Rendering: each output frame blends 4 to 16 captures over a 180-degree shutter (more where
the motion is fastest), in 1-second chunks across 3 workers. Frames go straight from
Chromium into FFmpeg, so no image files pile up. The blend's delay is measured on the FFmpeg
in use and padded out, and every chunk and the joined film are checked for an exact frame
count, so the picture cannot drift against the sound. Output is H.264 High, yuv420p, BT.709,
CRF 18 for the master and 20 for the vertical cut, AAC 192 kbps, with the index at the front
for fast start.

Checks: `npm run qa -- sheet <mp4> <png>` (1 frame per second), `qa -- pops <mp4>` (jumps and
one-frame flashes), `qa -- loop <mp4>` (first vs last frame), `qa -- loud <mp4>` (EBU R128).

## What is real

The screens are rebuilt from screenshots of the app taken on 17 Oct 2026, with its colours,
type, icons and wording. The sample files (`proposal.pdf`, `q4-plan.pptx`) are made-up demos;
their body text is shown as grey lines. The only numbers on screen are the prices from
`lib/plans.ts` (R0, R49 and R199 a month, which the price counters roll up to) and "5 seats". No user counts, sizes, timings,
testimonials or logos. YouTube is not shown. X, TikTok and Instagram appear as plain text
names only, with the site's own line "Only download videos you have permission to use."
"Stays on your device." appears only over the PDF tools. The "Ask your PDF" scene shows
the real prompt chips and the real waiting state, never an answer.

## Sound credits

Music: "Cast a spell" (original), 120 BPM, A major, made in code (`audio/music.py`).
Sound effects: original, synthesized in code (`audio/sfx.py`). No samples are used.

## Decisions (any of these can be overturned)

1. The real headline "Cast spells on your PDFs." is the promise; its rotating word gives the three acts.
2. The logo's violet tile is the one shape that never cuts, from the first frame to the last.
   It also writes the headline, word by word, and ends it as the full stop.
3. The film opens on the product, not on a problem scene.
4. The only numbers are the prices, "5 seats" and nothing else. Plan features with numbers are left out.
5. "Stays on your device." appears only over PDF tools.
6. The "Ask your PDF" scene shows no answer.
7. YouTube is left out; platform names are text only, with the permission line on screen.
8. Original synthesized music and effects: A major, 120 BPM, drop at 10.0 s, no voiceover.
9. Frame 0 is the end card, so the thumbnail is the logo and the film loops cleanly.
10. 16:9 at 60 fps is the master; the vertical cut is laid out again at 30 fps with the same sound.
11. In the vertical cut, product UI fades out before the top 10% and before the caption band.

## Caveats

- The soundtrack has been measured (loudness, peaks, timing against the cues), not listened
  to. Listen at 0.25 s (star chime), 9.0-10.2 s (build into the drop), 12.0-15.8 s (typing
  and signature), 33.5-34.3 s (silence and the logo hit) and 37.5-38.0 s (the loop join).
- If the site's screens change, re-shoot them and compare with `film/src/ui.js`.
- X, TikTok and Instagram are other companies' trademarks, named only to say which links work.
