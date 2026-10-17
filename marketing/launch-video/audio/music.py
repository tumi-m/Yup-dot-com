"""Original score for "Cast a spell": 120 BPM, A major, 38 s, made entirely in code.

Shape (from timeline.json "music"): intro 0-4 (pad, plucked arpeggio), groove 4-8 (kick,
filtered bass), build 8-10 (accelerating snare roll, rising sweep that ends on 10.0),
drop 10-30 (full beat, ducked bass, bell melody, a change every 4 bars), half-time
30-33.5 (pad opens), near-silence 33.5-34, deep hit and final chord on 34.0, ring-out.
The tail past 38 s is folded onto the start so the loop is seamless.
"""
import numpy as np
from dsp import (SR, n_of, times, midi_hz, saw, sine, tri, noise, adsr, perc, butter, sweep_filter,
                 pan2, reverb_ir, reverb, pingpong, place)

BEAT = 0.5
BAR = 2.0
S16 = BEAT / 4

# one chord per bar (19 bars); the build sits on E so the drop resolves to A
PROG = ["A", "F#m", "D", "Bm", "E", "A", "F#m", "D", "E", "A", "F#m", "D", "E", "A", "F#m", "D", "E", "A", "A"]
PAD = {"A": [57, 61, 64, 69], "F#m": [57, 61, 66, 69], "D": [57, 62, 66, 69], "Bm": [59, 62, 66, 71], "E": [59, 64, 68, 71]}
ROOT = {"A": 33, "F#m": 30, "D": 38, "Bm": 35, "E": 40}


def bus(total):
    return np.zeros((2, n_of(total)))


# ------------------------------------------------------------------ instruments
def kick(vel=1.0):
    n = n_of(0.5)
    t = times(n)
    f = 46 + 120 * np.exp(-t / 0.032)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.30)
    click = butter(noise(n_of(0.006)), "highpass", 2500) * 0.25
    body[: len(click)] += click * np.linspace(1, 0, len(click))
    return np.tanh(body * 1.6) * vel


def snare(vel=1.0, tone=190):
    n = n_of(0.35)
    t = times(n)
    nz = butter(noise(n), "bandpass", [1200, 7500]) * np.exp(-t / 0.11)
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t / 0.05)
    return (nz * 0.9 + body * 0.7) * vel


def clap(vel=1.0):
    n = n_of(0.3)
    t = times(n)
    env = np.zeros(n)
    for k, d in enumerate([0, 0.011, 0.022]):
        i = n_of(d)
        env[i:] += np.exp(-(t[: n - i]) / (0.012 if k < 2 else 0.09))
    return butter(noise(n), "bandpass", [900, 5000]) * env * 0.8 * vel


def hat(open_=False, vel=1.0):
    n = n_of(0.3 if open_ else 0.08)
    t = times(n)
    return butter(noise(n), "highpass", 7500) * np.exp(-t / (0.12 if open_ else 0.022)) * vel


def fm(freq, dur, ratio=2.0, index=2.5, idx_decay=0.15, decay=0.4, attack=0.003):
    n = n_of(dur)
    t = times(n)
    mod = index * np.exp(-t / idx_decay) * np.sin(2 * np.pi * freq * ratio * t)
    return np.sin(2 * np.pi * freq * t + mod) * perc(n, decay, attack)


def pluck(m, dur=0.5, vel=1.0):
    f = float(midi_hz(m))
    return (fm(f, dur, 2.0, 2.2, 0.08, 0.28) * 0.8 + fm(f * 2, dur, 1.0, 0.6, 0.05, 0.12) * 0.2) * vel


def bell(m, dur=1.6, vel=1.0):
    f = float(midi_hz(m))
    return (fm(f, dur, 3.5, 1.6, 0.35, 0.9, 0.002) * 0.55 + fm(f, dur, 1.0, 0.8, 0.5, 1.2, 0.004) * 0.45) * vel


def pad_chord(notes, dur, cutoff, attack=0.25, release=0.5):
    n = n_of(dur + release)
    out = np.zeros((2, n))
    for i, m in enumerate(notes):
        f = float(midi_hz(m))
        for j, cents in enumerate((-8, 0, 7)):
            v = saw(f * 2 ** (cents / 1200), n, ph0=(i * 0.37 + j * 0.21) % 1)
            out += pan2(v, (-0.6 + 1.2 * i / max(1, len(notes) - 1)) * (0.5 + 0.25 * j)) / 3
    env = adsr(n, attack, 0.6, 0.85, release, hold=dur)
    out *= env
    for c in range(2):
        out[c] = sweep_filter(out[c], "lowpass", cutoff if np.ndim(cutoff) else np.full(n, cutoff))
    return out / len(notes)


def bass_note(m, dur, cutoff=500, vel=1.0):
    n = n_of(dur)
    f = float(midi_hz(m))
    v = saw(f, n) * 0.6 + np.sign(np.sin(2 * np.pi * f * times(n))) * 0.25 + np.sin(2 * np.pi * f * times(n)) * 0.6
    v = butter(v, "lowpass", cutoff)
    return v * adsr(n, 0.004, 0.12, 0.75, min(0.06, dur * 0.3)) * vel


# ------------------------------------------------------------------ score
def render(tl):
    D = tl["duration"]
    total = D + 4.0
    mu = tl["music"]
    drums, bassb, padb, plk, bel, fx = (bus(total) for _ in range(6))
    rev_send, dly_send = bus(total), bus(total)
    kicks = []

    def bar_of(t):
        return min(len(PROG) - 1, int(t // BAR))

    # --- pad: every bar; filter follows the sections
    for b, ch in enumerate(PROG):
        t0 = b * BAR
        if t0 >= 33.5 and t0 < 34:
            continue
        if b == 16:   # bar 16 (32-34) stops for the gap at 33.5
            dur = 1.5
        elif b >= 17:  # final chord: one long note from the hit to the loop point
            if b == 18:
                continue
            dur = 4.0
        else:
            dur = BAR
        n = n_of(dur + 0.5)
        tt = t0 + times(n)
        cutoff = np.interp(tt, [0, 4, 8, 10, 10.01, 30, 33.5, 34, 37], [900, 1300, 1600, 3800, 2400, 2600, 6500, 4000, 1400])
        vel = 1.25 if b < 2 else 1.0
        att = 0.35 if b in (0, 17) else 0.08
        ch_notes = PAD[ch] + ([45] if b >= 17 else [])
        p = pad_chord(ch_notes, dur, cutoff, attack=att, release=1.2 if b == 17 else 0.45 if b != 16 else 0.12) * vel
        i0 = n_of(t0)
        padb[:, i0:i0 + p.shape[1]] += p[:, : padb.shape[1] - i0]

    # --- plucked "magic" arpeggio: intro, groove, and as a counter line in the second half of the drop
    def arp(t_from, t_to, step, vel, octave=12, pattern=(0, 1, 2, 3, 2, 1)):
        k = 0
        t = t_from
        while t < t_to - 1e-6:
            notes = PAD[PROG[bar_of(t)]]
            m = notes[pattern[k % len(pattern)]] + octave
            x = pluck(m, 0.6, vel * (1.0 if k % 4 == 0 else 0.78))
            place(plk, t, x, 1.0, pan=0.35 * np.sin(k * 1.3), align="start")
            k += 1
            t += step
    arp(0.0, 8.0, BEAT / 2, 0.7)
    arp(8.0, 9.75, BEAT / 4, 0.4)
    arp(18.0, 26.0, BEAT / 4, 0.28, octave=24, pattern=(0, 2, 1, 3))

    # --- kick, snare, hats
    def k_at(t, vel=1.0):
        place(drums, t, kick(vel), 0.95, 0, align="start")
        kicks.append(t)
    for i in range(int(4 / BEAT), int(8 / BEAT)):  # groove: four on the floor
        k_at(i * BEAT, 0.85)
    for t in (8.0, 8.5, 9.0):  # build: the kick thins out
        k_at(t, 0.8)
    for i in range(int(10 / BEAT), int(30 / BEAT)):  # drop
        k_at(i * BEAT, 1.0)
    for t in (30.0, 30.75, 32.0, 32.75):  # half-time
        k_at(t, 0.95)
    for b in range(5, 15):
        for off in (0.5, 1.5):
            t = b * BAR + off
            place(drums, t, clap(1.0), 0.55, 0.05, align="start")
            place(drums, t, snare(0.6), 0.35, -0.05, align="start")
            place(rev_send, t, snare(0.6), 0.25, 0, align="start")
    for t in (31.0, 33.0):
        place(drums, t, snare(1.0, 170), 0.6, 0, align="start")
        place(drums, t, clap(1.0), 0.5, 0, align="start")
        place(rev_send, t, clap(1.0), 0.7, 0, align="start")
    # build: snare roll speeding up (8ths, 16ths, 32nds), louder towards 10.0
    t = 8.0
    while t < 9.999:
        step = 0.25 if t < 9.0 else 0.125 if t < 9.5 else 0.0625
        vel = 0.25 + 0.75 * ((t - 8.0) / 2.0) ** 1.6
        place(drums, t, snare(vel, 200 + 60 * (t - 8)), 0.5, 0.1 * np.sin(t * 9), align="start")
        t += step
    # hats: offbeat 8ths in the drop, 16ths from bar 13, open hat every other bar
    for b in range(5, 15):
        for k in range(16):
            t = b * BAR + k * S16
            if k % 2 == 1 or b >= 13:
                v = 0.5 if k % 2 == 1 else 0.28
                place(drums, t, hat(False, v), 0.32, 0.35, align="start")
        if b % 2 == 0:
            place(drums, b * BAR + 1.75, hat(True, 0.6), 0.3, 0.4, align="start")
    for k in range(int(4 / S16), int(8 / S16)):  # groove hats, quieter
        if k % 2 == 1:
            place(drums, k * S16, hat(False, 0.35), 0.22, 0.35, align="start")
    # fill into the half-time at 29.5
    for j, t in enumerate(np.arange(29.5, 30.0, 0.0625)):
        place(drums, t, snare(0.4 + 0.08 * j, 210), 0.4, -0.3 + 0.08 * j, align="start")

    # --- bass: filtered in the groove, open and ducked in the drop, long notes in half-time
    for b in range(2, 5):
        root = ROOT[PROG[b]]
        for q in range(4):
            place(bassb, b * BAR + q * BEAT, bass_note(root, 0.42, 380, 0.9), 1.0, 0, align="start")
    for b in range(5, 15):
        root = ROOT[PROG[b]]
        for e in range(8):
            m = root + (12 if e in (3, 7) else 0)
            place(bassb, b * BAR + e * BEAT / 2, bass_note(m, 0.23, 900, 1.0 if e % 2 == 0 else 0.8), 1.0, 0, align="start")
    for b, dur in ((15, 1.95), (16, 1.45)):
        place(bassb, b * BAR, bass_note(ROOT[PROG[b]], dur, 700, 1.0), 1.0, 0, align="start")

    # --- bell melody (A major pentatonic) in the drop; a change every 4 bars
    MOTIF = [
        [(0, 76, 2), (3, 73, 2), (6, 76, 2), (8, 78, 3), (11, 76, 2), (14, 73, 2)],
        [(0, 73, 2), (3, 69, 2), (6, 71, 2), (8, 73, 4), (12, 69, 4)],
        [(0, 78, 2), (3, 76, 2), (6, 74, 2), (8, 76, 3), (11, 78, 2), (14, 81, 2)],
        [(0, 76, 2), (3, 71, 2), (6, 76, 2), (8, 80, 6)],
    ]
    for b in range(5, 15):
        phrase = MOTIF[(b - 5) % 4]
        for step, m, d in phrase:
            t = b * BAR + step * S16
            vel = 0.8
            x = bell(m, 1.4, vel)
            place(bel, t, x, 1.0, pan=-0.2, align="start")
            if b >= 9:  # second half: octave doubling, a little brighter
                place(bel, t, bell(m + 12, 1.0, 0.35), 1.0, pan=0.3, align="start")
            place(dly_send, t, x, 0.5, 0, align="start")
    for t, notes in ((30.0, [69, 73, 76]), (32.0, [71, 76, 80])):  # half-time stabs
        for j, m in enumerate(notes):
            place(bel, t + j * 0.02, bell(m, 2.0, 0.55), 1.0, pan=-0.4 + 0.4 * j, align="start")
            place(dly_send, t, bell(m, 1.5, 0.5), 0.5, 0, align="start")

    # --- riser into the drop: noise sweep plus a rising saw, ending on 10.0
    n = n_of(2.0)
    tt = times(n)
    k = tt / 2.0
    sweep = sweep_filter(noise(n), "bandpass", 300 * (30 ** k), q_bw=0.5) * (k ** 2.2)
    tone = butter(saw(220 * 2 ** (k * 1.0), n), "lowpass", 3000) * (k ** 3) * 0.25
    r = (sweep * 0.8 + tone)
    r[-n_of(0.008):] *= np.linspace(1, 0, n_of(0.008))
    place(fx, 8.0, pan2(r, 0) * np.array([[1.0], [0.92]]), 0.55, align="start")

    # --- the hit on 34.0: deep boom, final chord bells, star melody
    n = n_of(3.5)
    tt = times(n)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 50 * np.exp(-tt / 0.08)) / SR) * np.exp(-tt / 1.1)
    boom += butter(noise(n), "lowpass", 900) * np.exp(-tt / 0.18) * 0.35
    place(fx, 34.0, np.tanh(boom * 1.4), 0.9, 0, align="start")
    place(rev_send, 34.0, butter(noise(n_of(0.5)), "bandpass", [300, 4000]) * np.exp(-times(n_of(0.5)) / 0.12), 0.6, 0, align="start")
    for j, m in enumerate([57, 61, 64, 69, 73]):
        place(bel, 34.0 + j * 0.012, bell(m, 3.5, 0.5), 1.0, pan=-0.5 + 0.25 * j, align="start")
    for j, m in enumerate([76, 81, 85, 88]):  # star melody E6 A6 C#7 E7
        x = bell(m, 1.8, 0.42 - 0.04 * j)
        place(bel, 34.5 + j * 0.125, x, 1.0, pan=-0.3 + 0.2 * j, align="start")
        place(dly_send, 34.5 + j * 0.125, x, 0.6, 0, align="start")
    place(bassb, 34.0, bass_note(33, 3.2, 300, 0.9), 1.0, 0, align="start")

    # --- sidechain: bass and pad duck under each kick
    duck = np.ones(bassb.shape[1])
    for t in kicks:
        i = n_of(t)
        m = min(len(duck) - i, n_of(0.35))
        duck[i:i + m] = np.minimum(duck[i:i + m], 1 - 0.75 * np.exp(-times(m) / 0.09))
    bassb *= duck
    padb *= 1 - (1 - duck) * 0.45

    # --- space
    ir = reverb_ir(2.6)
    wet = reverb(padb * 0.25 + bel * 0.5 + plk * 0.45 + rev_send * 0.6, ir, 0.32)
    dly = pingpong(dly_send + plk * 0.5, 0.375, 0.38, 5)
    mix = drums * 0.9 + bassb * 0.62 + padb * 0.55 + plk * 0.42 + bel * 0.5 + fx * 0.85
    out = np.zeros((2, n_of(total) + ir.shape[1]))
    out[:, : mix.shape[1]] += mix
    out[:, : wet.shape[1]] += wet[:, : out.shape[1]]
    out[:, : dly.shape[1]] += dly[:, : out.shape[1]] * 0.22
    # gap: 33.5-34 holds only the echo
    # fold everything past the end onto the start, so the loop has no seam
    N = n_of(D)
    film = out[:, :N].copy()
    tail = out[:, N:]
    film[:, : min(N, tail.shape[1])] += tail[:, :N]
    stems = {"drums": drums[:, :N], "bass": bassb[:, :N], "pad": padb[:, :N], "pluck": plk[:, :N], "bell": bel[:, :N], "fx": fx[:, :N]}
    return film, stems, kicks
