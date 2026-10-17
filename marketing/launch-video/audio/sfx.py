"""Sound effects, synthesized and placed from the film's own cue list (out/audio/cues.json).

Transients (clicks, ticks, keys, pops, chimes, impacts) land on their cue by their own
loudest sample; moving sounds (whooshes, the pen, the drag) start on their cue. Tonal
sounds are in A major. Stereo position comes from where the thing is on screen.
"""
import numpy as np
from dsp import SR, n_of, times, midi_hz, sine, noise, perc, butter, sweep_filter, pan2, place, RNG

PENTA = [69, 71, 73, 76, 78, 81, 83, 85]  # A major pentatonic from A4


def click():
    n = n_of(0.09)
    t = times(n)
    press = butter(noise(n), "bandpass", [1800, 6500]) * np.exp(-t / 0.004)
    thump = np.sin(2 * np.pi * 180 * t) * np.exp(-t / 0.012) * 0.6
    rel = np.zeros(n)
    i = n_of(0.045)
    rel[i:] = butter(noise(n - i), "bandpass", [2500, 8000]) * np.exp(-t[: n - i] / 0.003) * 0.35
    return press + thump + rel


def tick(bright=1.0):
    n = n_of(0.05)
    t = times(n)
    return butter(noise(n), "bandpass", [3000, 9000]) * np.exp(-t / 0.0035) * 0.8 + np.sin(2 * np.pi * 2637 * t) * np.exp(-t / 0.01) * 0.25 * bright


def key(i):
    n = n_of(0.08)
    t = times(n)
    r = np.random.default_rng(100 + i)
    body = np.sin(2 * np.pi * (240 + r.uniform(-30, 30)) * t) * np.exp(-t / 0.012)
    top = butter(r.standard_normal(n), "bandpass", [2200, 7000]) * np.exp(-t / 0.005)
    return (body * 0.5 + top) * r.uniform(0.8, 1.0)


def pop(note):
    m = PENTA[int(note) % len(PENTA)]
    f = float(midi_hz(m))
    n = n_of(0.16)
    t = times(n)
    fr = f * (0.7 + 0.3 * (1 - np.exp(-t / 0.012)))
    x = np.sin(2 * np.pi * np.cumsum(fr) / SR) * perc(n, 0.05, 0.003)
    return x + np.sin(4 * np.pi * np.cumsum(fr) / SR) * perc(n, 0.025, 0.002) * 0.25


def blip(note):
    m = PENTA[int(note) % len(PENTA)] + 12
    n = n_of(0.12)
    t = times(n)
    return np.sin(2 * np.pi * float(midi_hz(m)) * t) * perc(n, 0.035, 0.004)


def bell_tone(m, dur, vel=1.0):
    f = float(midi_hz(m))
    n = n_of(dur)
    t = times(n)
    mod = 1.2 * np.exp(-t / 0.25) * np.sin(2 * np.pi * f * 3.5 * t)
    return np.sin(2 * np.pi * f * t + mod) * perc(n, dur / 3.2, 0.002) * vel


def chime(kind):
    if kind == "star":  # a small high sparkle on the hat's star
        out = np.zeros(n_of(1.4))
        for j, m in enumerate([88, 93, 97]):
            x = bell_tone(m, 1.2, 0.5 - 0.1 * j)
            i = n_of(j * 0.045)
            out[i:i + len(x)] += x[: len(out) - i]
        sh = butter(noise(len(out)), "highpass", 9000) * np.exp(-times(len(out)) / 0.25) * 0.08
        return out + sh
    # success: E5, A5, C#6 rising quickly, the way the check lands
    out = np.zeros(n_of(1.8))
    for j, m in enumerate([76, 81, 85]):
        x = bell_tone(m, 1.6, 0.7 - 0.12 * j)
        i = n_of(j * 0.06)
        out[i:i + len(x)] += x[: len(out) - i]
    return out


def whoosh(dur, up=True):
    n = n_of(dur)
    t = times(n)
    k = t / dur
    env = np.sin(np.pi * np.clip(k, 0, 1) ** 0.8) ** 2
    fc = 500 * (6 ** k) if up else 3000 * (0.3 ** k)
    return sweep_filter(noise(n), "bandpass", fc, q_bw=0.9) * env


def whip(dur):
    n = n_of(dur)
    t = times(n)
    k = t / dur
    env = np.exp(-((k - 0.32) / 0.2) ** 2)
    fc = 300 + 5000 * np.exp(-((k - 0.3) / 0.22) ** 2)
    x = sweep_filter(noise(n), "bandpass", fc, q_bw=1.1) * env
    x += np.sin(2 * np.pi * np.cumsum(90 + 140 * env) / SR) * env * 0.25
    return x


def drop(big=False):
    n = n_of(0.5 if big else 0.25)
    t = times(n)
    f = 70 + 90 * np.exp(-t / 0.03)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.22 if big else 0.07))
    x += butter(noise(n), "lowpass", 1800) * np.exp(-t / 0.01) * 0.4
    return np.tanh(x * 1.3)


def impact():
    n = n_of(2.5)
    t = times(n)
    x = np.sin(2 * np.pi * np.cumsum(34 + 60 * np.exp(-t / 0.06)) / SR) * np.exp(-t / 0.9)
    x += butter(noise(n), "bandpass", [80, 2200]) * np.exp(-t / 0.09) * 0.5
    return np.tanh(x * 1.5)


def shimmer(dur):
    n = n_of(dur + 0.6)
    out = np.zeros(n)
    r = np.random.default_rng(9)
    for j in range(10):
        m = PENTA[r.integers(3, 8)] + 12
        x = bell_tone(m, 0.5, 0.18)
        i = n_of(j * dur / 10)
        out[i:i + len(x)] += x[: n - i]
    return out


def pen(dur, env, rate):
    n = n_of(dur + 0.05)
    t = times(n)
    sp = np.interp(t, np.arange(len(env)) / rate, np.asarray(env, float))
    sp = sp / max(1e-6, np.percentile(sp, 95))
    grain = butter(noise(n), "bandpass", [1800, 6500])
    rough = 0.6 + 0.4 * butter(np.abs(noise(n)), "lowpass", 60)
    x = grain * np.clip(sp, 0, 1.3) * rough
    x[-n_of(0.04):] *= np.linspace(1, 0, n_of(0.04))
    return x * 0.8


def drag(dur):
    n = n_of(dur)
    t = times(n)
    env = np.sin(np.pi * t / dur) ** 1.5
    return butter(noise(n), "bandpass", [400, 2200]) * env * 0.5


def paste():
    w = np.concatenate([np.zeros(n_of(0.03)), whoosh(0.18) * 0.4])
    c = click() * 0.6
    out = np.zeros(max(len(w), len(c)))
    out[: len(c)] += c
    out[: len(w)] += w
    return out


def odo():
    n = n_of(0.03)
    t = times(n)
    return butter(noise(n), "bandpass", [3500, 9000]) * np.exp(-t / 0.002)


def render(cues, duration):
    total = duration + 3.0
    bus = np.zeros((2, n_of(total)))
    hits = []
    for c in cues:
        k, t, g, p = c["kind"], c["t"], c.get("gain", 1.0), c.get("pan", 0.0)
        align = "peak"
        if k == "click":
            x, lvl = click(), 0.32
        elif k == "tick":
            x, lvl = tick(), 0.22
        elif k == "key":
            x, lvl = key(c.get("i", 0)), 0.2
        elif k == "pop":
            x, lvl = pop(c.get("note", 0)), 0.2
        elif k == "blip":
            x, lvl = blip(c.get("note", 0)), 0.1
        elif k == "chime":
            x, lvl = chime(c.get("note", "success")), 0.26
        elif k == "whoosh":
            x, lvl, align = whoosh(c.get("dur", 0.3)), 0.2, "start"
        elif k == "whip":
            x, lvl, align = whip(c.get("dur", 0.5)), 0.45, "start"
        elif k == "drop":
            x, lvl = drop(c.get("big", False)), 0.45 if c.get("big") else 0.3
        elif k == "impact":
            x, lvl = impact(), 0.55
        elif k == "shimmer":
            x, lvl, align = shimmer(c.get("dur", 0.5)), 0.5, "start"
        elif k == "pen":
            x, lvl, align = pen(c["dur"], c["env"], c.get("envRate", 100)), 0.2, "start"
        elif k == "drag":
            x, lvl, align = drag(c.get("dur", 0.4)), 0.25, "start"
        elif k == "paste":
            x, lvl = paste(), 0.3
        elif k == "odo":
            x, lvl = odo(), 0.12
        else:
            continue
        x = x / max(1e-9, np.abs(x).max())
        at = place(bus, t, x, lvl * g, p, align)
        hits.append({"kind": k, "cue": t, "peak": at / SR if align == "peak" else None})
    # wrap anything past the end onto the start (the film loops)
    N = n_of(duration)
    out = bus[:, :N].copy()
    out[:, : bus.shape[1] - N] += bus[:, N:]
    return out, hits
