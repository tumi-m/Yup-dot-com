"""Waveform and spectrogram of the soundtrack against the beat grid and the cue list.

    python audio/viz.py [out/audio] [--from 8 --to 12]
"""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy import signal  # noqa: E402
from scipy.io import wavfile  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
OUT = os.path.abspath(args[0]) if args and not args[0].startswith("--") else os.path.join(ROOT, "out", "audio")
a = float(args[args.index("--from") + 1]) if "--from" in args else 0.0
b = float(args[args.index("--to") + 1]) if "--to" in args else 38.0
sr, x = wavfile.read(os.path.join(OUT, "mix.wav"))
x = x.astype(float) / 32768
mono = x.mean(axis=1)
cues = json.load(open(os.path.join(OUT, "cues.json")))["cues"]
i0, i1 = int(a * sr), int(b * sr)
seg = mono[i0:i1]
t = np.arange(len(seg)) / sr + a

fig, ax = plt.subplots(3, 1, figsize=(22, 10), gridspec_kw={"height_ratios": [2, 1, 3]}, sharex=True)
ax[0].plot(t, seg, lw=0.3, color="#6d28d9")
for beat in np.arange(np.ceil(a * 2) / 2, b, 0.5):
    for k in range(3):
        ax[k].axvline(beat, color="#f59e0b" if beat % 2 == 0 else "#ddd", lw=0.8 if beat % 2 == 0 else 0.5, zorder=0)
ax[0].set_ylim(-1, 1)
ax[0].set_title(f"mix {a:.2f}-{b:.2f} s  (amber = bar lines, grey = beats)")
for c in cues:
    if a <= c["t"] <= b:
        ax[1].axvline(c["t"], color="#c026d3", lw=1)
        ax[1].text(c["t"], 0.5 + 0.4 * ((hash(c["kind"]) % 5) / 5), c["kind"], fontsize=7, rotation=90)
ax[1].set_yticks([])
ax[1].set_title("cues exported from the film")
f, tt, S = signal.spectrogram(seg, sr, nperseg=2048, noverlap=1536)
ax[2].pcolormesh(tt + a, f, 10 * np.log10(S + 1e-12), shading="auto", vmin=-110, vmax=-30, cmap="magma")
ax[2].set_yscale("symlog", linthresh=200)
ax[2].set_ylim(30, 16000)
ax[2].set_xlabel("seconds")
plt.tight_layout()
name = "wave.png" if (a, b) == (0.0, 38.0) else f"wave-{a:g}-{b:g}.png"
plt.savefig(os.path.join(OUT, name), dpi=80)
print(os.path.join(OUT, name))
