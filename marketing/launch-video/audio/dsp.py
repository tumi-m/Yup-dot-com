"""DSP building blocks for the film's original score and sound effects (numpy + scipy).

Everything is generated from code: no samples. A seeded RNG keeps every render identical.
The BS.1770 loudness meter follows the structure of sfx/loudness.py in whaleyxbt's motion
toolkit (MIT, Copyright (c) 2026 whaleyxbt), rewritten for numpy. See THIRD_PARTY_NOTICES.md.
"""
import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

SR = 48000
RNG = np.random.default_rng(20261017)


def n_of(sec):
    return int(round(sec * SR))


def times(n):
    return np.arange(n) / SR


def midi_hz(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=float) - 69.0) / 12.0)


def db(x):
    return 20 * np.log10(max(x, 1e-12))


def undb(d):
    return 10 ** (d / 20)


# ------------------------------------------------------------------ oscillators
def phase(freq, n, ph0=0.0):
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return (ph0 + np.cumsum(f) / SR) % 1.0


def sine(freq, n, ph0=0.0):
    return np.sin(2 * np.pi * phase(freq, n, ph0))


def saw(freq, n, ph0=0.0):
    """Band-limited (polyBLEP) sawtooth."""
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    dt = f / SR
    ph = (ph0 + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    m = ph < dt
    x = ph[m] / dt[m]
    y[m] -= x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    y[m] -= x * x + x + x + 1
    return y


def tri(freq, n, ph0=0.0):
    ph = phase(freq, n, ph0)
    return 4 * np.abs(ph - 0.5) - 1


def noise(n):
    return RNG.standard_normal(n)


# ------------------------------------------------------------------ envelopes
def adsr(n, a, d, s, r, hold=None):
    """Attack/decay/sustain/release envelope over n samples (release at the end)."""
    t = times(n)
    total = n / SR
    rel_start = total - r if hold is None else hold
    e = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6)))
    e = np.where(t > rel_start, e * np.clip(1 - (t - rel_start) / max(r, 1e-6), 0, 1), e)
    return e


def perc(n, decay, attack=0.002):
    t = times(n)
    return np.minimum(1, t / attack) * np.exp(-t / decay)


# ------------------------------------------------------------------ filters
def butter(x, kind, fc, order=2):
    fc = np.atleast_1d(fc)
    wn = np.clip(fc / (SR / 2), 1e-4, 0.999)
    sos = signal.butter(order, wn if len(wn) > 1 else wn[0], btype=kind, output="sos")
    return signal.sosfilt(sos, x)


def sweep_filter(x, kind, fc_curve, order=2, block=256, q_bw=None):
    """Time-varying Butterworth filter: coefficients updated every `block` samples."""
    y = np.zeros_like(x)
    zi = None
    for i in range(0, len(x), block):
        fc = float(fc_curve[min(i, len(fc_curve) - 1)])
        if kind == "bandpass":
            bw = q_bw or 0.6
            lo, hi = fc * (1 - bw / 2), fc * (1 + bw / 2)
            wn = [np.clip(lo / (SR / 2), 1e-4, 0.99), np.clip(hi / (SR / 2), 2e-4, 0.995)]
        else:
            wn = np.clip(fc / (SR / 2), 1e-4, 0.995)
        sos = signal.butter(order, wn, btype=kind, output="sos")
        if zi is None or zi.shape[0] != sos.shape[0]:
            zi = np.zeros((sos.shape[0], 2))
        y[i:i + block], zi = signal.sosfilt(sos, x[i:i + block], zi=zi)
    return y


# ------------------------------------------------------------------ space
def pan2(x, p):
    """Equal-power pan, p in [-1, 1]."""
    a = (np.clip(p, -1, 1) + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)])


def reverb_ir(seconds=2.4, damp=0.55, seed=3):
    r = np.random.default_rng(seed)
    n = n_of(seconds)
    t = times(n)
    env = np.exp(-t * 6.9 / seconds)
    ir = np.stack([r.standard_normal(n), r.standard_normal(n)]) * env
    # darker tail: lowpass that closes over time
    for c in range(2):
        ir[c] = butter(ir[c], "lowpass", 9000 * damp + 1500)
    ir[:, : n_of(0.012)] *= np.linspace(0, 1, n_of(0.012))
    return ir / np.sqrt(np.sum(ir ** 2) / 2)


def reverb(st, ir, mix):
    out = np.zeros((2, st.shape[1] + ir.shape[1] - 1))
    for c in range(2):
        out[c] = signal.fftconvolve(st[c], ir[c])
    return out * mix


def pingpong(st, delay, feedback=0.42, taps=6, damp=4500):
    d = n_of(delay)
    out = np.zeros((2, st.shape[1] + d * taps))
    out[:, : st.shape[1]] += st
    mono = st.mean(axis=0)
    g = 1.0
    for k in range(1, taps + 1):
        g *= feedback
        mono = butter(mono, "lowpass", damp)
        ch = k % 2
        out[ch, k * d: k * d + len(mono)] += mono * g
    return out


# ------------------------------------------------------------------ placing sounds
def place(bus, t, x, gain=1.0, pan=0.0, align="peak"):
    """Mix mono or stereo x into stereo bus so that its own peak (or start) lands on t."""
    if x.ndim == 1:
        st = pan2(x, pan)
    else:
        st = x
    if align == "peak":
        k = int(np.argmax(np.abs(st).max(axis=0)))
    else:
        k = 0
    i0 = n_of(t) - k
    a, b = max(0, i0), min(bus.shape[1], i0 + st.shape[1])
    if b > a:
        bus[:, a:b] += st[:, a - i0: b - i0] * gain
    return i0 + k


# ------------------------------------------------------------------ dynamics and metering
def limiter(st, ceiling_db=-1.5, look=0.004, release=0.06):
    """Look-ahead peak limiter: the gain dips just before a peak and recovers over `release`."""
    ceil = undb(ceiling_db)
    peak = np.abs(st).max(axis=0)
    need = np.minimum(1.0, ceil / np.maximum(peak, 1e-9))
    L = max(3, n_of(look))
    g = minimum_filter1d(need, size=2 * L + 1)
    g = minimum_filter1d(g, size=n_of(release), origin=(n_of(release) - 1) // 2)  # hold after each peak
    g = uniform_filter1d(g, size=2 * L)
    g = np.minimum(g, need)
    return st * g


_SHELF = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
_HIGHPASS = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def lufs(st):
    """Integrated loudness, ITU-R BS.1770-4 with EBU R128 gating (48 kHz)."""
    k = [signal.lfilter(*_HIGHPASS, signal.lfilter(*_SHELF, ch)) for ch in st]
    p = k[0] ** 2 + k[1] ** 2
    block, hop = n_of(0.4), n_of(0.1)
    cs = np.concatenate([[0], np.cumsum(p)])
    idx = np.arange(0, len(p) - block + 1, hop)
    z = (cs[idx + block] - cs[idx]) / block
    L = -0.691 + 10 * np.log10(np.maximum(z, 1e-20))
    z1 = z[L > -70]
    if not len(z1):
        return float("-inf")
    rel = -0.691 + 10 * np.log10(z1.mean()) - 10
    z2 = z1[(-0.691 + 10 * np.log10(z1)) > rel]
    return -0.691 + 10 * np.log10(z2.mean())


def true_peak_db(st):
    up = signal.resample_poly(st, 4, 1, axis=1)
    return db(float(np.abs(up).max()))


def write_wav(path, st):
    from scipy.io import wavfile
    x = np.clip(st.T, -1, 1)
    wavfile.write(path, SR, (x * 32767).astype(np.int16))
