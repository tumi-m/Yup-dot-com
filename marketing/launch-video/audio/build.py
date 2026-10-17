"""Builds the soundtrack: music + sound effects -> mastered stereo WAV (-14 LUFS, true peak under -1 dBTP).

    python audio/build.py [out/audio]

Reads film/timeline.json and out/audio/cues.json (written by scripts/cues.mjs).
Writes music.wav, sfx.wav (stems, pre-master), mix.wav (mastered) and report.json.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import SR, n_of, lufs, true_peak_db, limiter, undb, write_wav  # noqa: E402
import music  # noqa: E402
import sfx  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "out", "audio")
TARGET = -14.0
CEILING = -1.6  # leaves room for AAC overshoot so the MP4 stays under -1 dBTP

tl = json.load(open(os.path.join(ROOT, "film", "timeline.json")))
cues = json.load(open(os.path.join(OUT, "cues.json")))["cues"]
os.makedirs(OUT, exist_ok=True)

mus, stems, kicks = music.render(tl)
fx, hits = sfx.render(cues, tl["duration"])

# music sits under the effects; effects that matter most cut through
mix = mus * 0.62 + fx * 0.9
pre = lufs(mix)
gain = undb(TARGET - pre)
master = limiter(mix * gain, CEILING)
for _ in range(4):  # the limiter takes a little loudness; nudge until on target
    L = lufs(master)
    if abs(L - TARGET) < 0.1:
        break
    gain *= undb(TARGET - L)
    master = limiter(mix * gain, CEILING)

N = n_of(tl["duration"])
assert master.shape[1] == N
write_wav(os.path.join(OUT, "music.wav"), mus * 0.62 * gain)
write_wav(os.path.join(OUT, "sfx.wav"), fx * 0.9 * gain)
write_wav(os.path.join(OUT, "mix.wav"), master)

# A/V check: where each transient's peak landed vs its cue (ms)
errs = [abs(h["peak"] - h["cue"]) * 1000 for h in hits if h["peak"] is not None]
report = {
    "integrated_lufs": round(lufs(master), 2),
    "true_peak_dbtp": round(true_peak_db(master), 2),
    "pre_master_lufs": round(pre, 2),
    "gain_db": round(20 * np.log10(gain), 2),
    "cues": len(hits),
    "peak_alignment_ms_max": round(max(errs), 3) if errs else None,
    "seam_rms_db": {
        "last_100ms": round(20 * np.log10(np.sqrt(np.mean(master[:, -n_of(0.1):] ** 2)) + 1e-12), 1),
        "first_100ms": round(20 * np.log10(np.sqrt(np.mean(master[:, : n_of(0.1)] ** 2)) + 1e-12), 1),
    },
    "sections_rms_db": {},
}
for name, (a, b) in [("intro", (0, 4)), ("groove", (4, 8)), ("build", (8, 10)), ("drop", (10, 30)), ("half", (30, 33.5)), ("gap", (33.5, 34)), ("ring", (34, 38))]:
    seg = master[:, n_of(a): n_of(b)]
    report["sections_rms_db"][name] = round(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-12), 1)
json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
print(json.dumps(report, indent=1))
