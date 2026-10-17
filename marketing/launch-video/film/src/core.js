/*
 * core.js: the time-pure motion engine behind the launch film.
 *
 * Every frame is drawn by seek(t) from the time alone: no CSS transitions, no
 * timers, no state carried between frames. Values that change target many
 * times are sums of closed-form spring step responses, so any frame can be
 * drawn on its own and two renders of the same frame are identical.
 *
 * The spring step response, the summed-spring track, the blur content swap and
 * the log-zoom camera are adapted from the code notes in product-launch-motion
 * (MIT, Copyright (c) 2026 Abubakr Chan). See THIRD_PARTY_NOTICES.md.
 */
(function () {
  "use strict";

  const Q = new URLSearchParams(location.search);
  const FMT = Q.get("fmt") === "9x16" ? "9x16" : "16x9";
  const V = FMT === "9x16";
  const W = V ? 1080 : 1920;
  const H = V ? 1920 : 1080;
  const RENDER = Q.has("render");

  // ---------------------------------------------------------------- maths
  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, k) => a + (b - a) * k;
  const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
  const ev = (v, t) => (typeof v === "function" ? v(t) : v);

  /** Damped spring step response, 0 -> 1. z < 1 overshoots a little. */
  function stepR(tau, sp) {
    if (tau <= 0) return 0;
    const w = sp.w, z = sp.z;
    if (z >= 1) {
      const x = w * tau;
      return x > 60 ? 1 : 1 - Math.exp(-x) * (1 + x);
    }
    const a = z * w;
    if (a * tau > 60) return 1;
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-a * tau) * (Math.cos(wd * tau) + (a / wd) * Math.sin(wd * tau));
  }

  /** Seconds a spring takes to cover `frac` of its move. */
  function lead(sp, frac = 0.9) {
    let t = 0;
    while (stepR(t, sp) < frac && t < 5) t += 0.002;
    return t;
  }

  const SP = {
    ui: { w: 22, z: 0.8 },        // UI: a hair of overshoot
    uiSoft: { w: 15, z: 0.84 },
    pop: { w: 30, z: 0.72 },
    text: { w: 19, z: 1 },        // type never overshoots
    textSlow: { w: 12, z: 1 },
    tile: { w: 17, z: 0.82 },
    tileSlow: { w: 11, z: 0.86 },
    cam: { w: 5.2, z: 1 },        // camera never overshoots
    camMed: { w: 8, z: 1 },
    camFast: { w: 13, z: 1 },
    cursor: { w: 13, z: 1 },
  };

  /** A value with many targets: the sum of one spring per change. Targets may be functions of t. */
  class Seq {
    constructor(v0) { this.v0 = v0; this.k = []; this.last = v0; }
    to(t, v, sp = SP.ui) { this.k.push([t, this.last, v, sp]); this.last = v; return this; }
    set(t, v) { this.k.push([t, this.last, v, null]); this.last = v; return this; }
    at(t) {
      let val = ev(this.v0, t);
      const k = this.k;
      for (let i = 0; i < k.length; i++) {
        const e = k[i];
        if (t <= e[0]) continue;
        const s = e[3] ? stepR(t - e[0], e[3]) : 1;
        if (s === 0) continue;
        val += (ev(e[2], t) - ev(e[1], t)) * s;
      }
      return val;
    }
  }

  /** Enter on a spring, leave short and early (exits take about half an entrance). */
  function vis(t, tin, tout, o = {}) {
    const e = tin == null ? 1 : stepR(t - tin, o.sp || SP.text);
    const x = tout == null ? 0 : clamp((t - tout) / (o.dOut ?? 0.14));
    const xo = x * x;
    const ec = clamp(e);
    return {
      o: ec * (1 - xo),
      b: (1 - ec) * (o.blur ?? 8) + xo * (o.blurOut ?? 8),
      y: (1 - e) * (o.dy ?? 16) + xo * (o.dyOut ?? -10),
      s: 1 + (1 - e) * (o.ds ?? 0) + xo * (o.dsOut ?? 0),
      e, x: xo,
    };
  }

  function show(el, on) {
    if (on) { if (el._v !== 1) { el.style.visibility = ""; el._v = 1; } }
    else if (el._v !== 0) { el.style.visibility = "hidden"; el._v = 0; }
    return on;
  }

  function applyVis(el, v, pre = "") {
    if (!show(el, v.o > 0.002)) return false;
    el.style.opacity = v.o >= 0.999 ? "" : v.o.toFixed(4);
    el.style.filter = v.b > 0.04 ? `blur(${v.b.toFixed(2)}px)` : "";
    el.style.transform = `${pre} translate3d(0, ${v.y.toFixed(2)}px, 0) scale(${v.s.toFixed(4)})`;
    return true;
  }

  /** Deterministic PRNG (mulberry32). */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- DOM
  function h(tag, cls, parent, style, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (style) Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function icon(name, size = 20, sw = 2, parent, color) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", color || "currentColor");
    s.setAttribute("stroke-width", sw);
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("class", "svg");
    const node = window.ICONS[name];
    if (!node) throw new Error(`icon ${name}`);
    for (const [tag, attrs] of node) {
      const e = document.createElementNS(SVGNS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      s.appendChild(e);
    }
    if (parent) parent.appendChild(s);
    return s;
  }

  /** Layout box of `node` relative to `root`, from offset metrics (immune to transforms). */
  function boxIn(node, root) {
    let x = 0, y = 0, n = node;
    while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    if (n !== root) throw new Error("boxIn: root is not an offset ancestor");
    return { x, y, w: node.offsetWidth, h: node.offsetHeight };
  }

  const rectC = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const grow = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });

  // ---------------------------------------------------------------- colour
  function hexRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  class ColorSeq {
    constructor(hex, a = 1) { const c = hexRGB(hex); this.r = new Seq(c[0]); this.g = new Seq(c[1]); this.b = new Seq(c[2]); this.a = new Seq(a); }
    to(t, hex, sp, a = 1) { const c = hexRGB(hex); this.r.to(t, c[0], sp); this.g.to(t, c[1], sp); this.b.to(t, c[2], sp); this.a.to(t, a, sp); return this; }
    css(t) {
      const r = clamp(this.r.at(t), 0, 255), g = clamp(this.g.at(t), 0, 255), b = clamp(this.b.at(t), 0, 255), a = clamp(this.a.at(t));
      return `rgba(${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)}, ${a.toFixed(3)})`;
    }
  }

  // ---------------------------------------------------------------- stage
  const stage = document.getElementById("stage");
  const world = document.getElementById("world");
  const hud = document.getElementById("hud");
  stage.style.width = W + "px";
  stage.style.height = H + "px";
  document.documentElement.dataset.fmt = FMT;

  function fitViewport() {
    if (RENDER) { stage.style.transform = ""; return; }
    const k = Math.min(innerWidth / W, (innerHeight - 40) / H);
    stage.style.transform = `scale(${k})`;
    stage.parentElement.style.placeItems = "start";
    stage.style.marginLeft = `${(innerWidth - W * k) / 2}px`;
    stage.style.marginTop = `${(innerHeight - 40 - H * k) / 2}px`;
  }

  // ---------------------------------------------------------------- camera
  class Camera {
    constructor(c0) {
      this.x = new Seq(c0.cx); this.y = new Seq(c0.cy); this.lz = new Seq(Math.log(c0.z));
      this.punches = [];
    }
    to(t, c, sp = SP.cam) {
      this.x.to(t, c.cx, sp); this.y.to(t, c.cy, sp); this.lz.to(t, Math.log(c.z), sp);
      return this;
    }
    punch(t, amt, decay = 0.35) { this.punches.push([t, amt, decay]); return this; }
    at(t) {
      let z = Math.exp(this.lz.at(t));
      for (const [tp, amt, dec] of this.punches) {
        const d = t - tp;
        if (d > 0) z *= 1 + amt * (1 - Math.exp(-d / 0.045)) * Math.exp(-d / dec);
      }
      return { cx: this.x.at(t), cy: this.y.at(t), z };
    }
    /** Camera that fits world rect `r` into screen region `reg`. */
    static fit(r, reg, k = 1) {
      const z = Math.min(reg.w / r.w, reg.h / r.h) * k;
      return {
        cx: r.x + r.w / 2 - (reg.x + reg.w / 2 - W / 2) / z,
        cy: r.y + r.h / 2 - (reg.y + reg.h / 2 - H / 2) / z,
        z,
      };
    }
    /** Camera at zoom z that puts world point p at screen point s. */
    static place(p, s, z) {
      return { cx: p.x - (s.x - W / 2) / z, cy: p.y - (s.y - H / 2) / z, z };
    }
  }
  const toScreen = (p, c) => ({ x: (p.x - c.cx) * c.z + W / 2, y: (p.y - c.cy) * c.z + H / 2 });
  const toWorld = (s, c) => ({ x: (s.x - W / 2) / c.z + c.cx, y: (s.y - H / 2) / c.z + c.cy });

  // ---------------------------------------------------------------- groups
  /**
   * A block of UI placed in world space. Its transform is a function of time
   * (enter/exit, pan offset) and its children's world boxes follow it.
   */
  class Group {
    constructor(name, x, y, opts = {}) {
      this.name = name;
      this.el = h("div", "grp ui " + (opts.cls || ""), opts.parent || world);
      this.el.style.left = x + "px";
      this.el.style.top = y + "px";
      if (opts.w) this.el.style.width = opts.w + "px";
      if (opts.h) this.el.style.height = opts.h + "px";
      if (opts.z != null) this.el.style.zIndex = opts.z;
      this.x = x; this.y = y;
      this.xfs = [];
      this.windows = [];
      FILM.groups.push(this);
    }
    get w() { return this.el.offsetWidth; }
    get h() { return this.el.offsetHeight; }
    /** Visibility window: enter at tin, leave at tout. */
    life(tin, tout, o = {}) { this.windows.push([tin, tout, o]); return this; }
    /** Extra transform contributor: (t) => {tx, ty, s}. */
    xf(fn) { this.xfs.push(fn); return this; }
    state(t) {
      let o = 1, b = 0, tx = 0, ty = 0, s = 1;
      for (const [tin, tout, op] of this.windows) {
        const v = vis(t, tin, tout, op);
        o *= v.o; b += v.b; ty += v.y; s *= v.s;
      }
      for (const fn of this.xfs) { const r = fn(t); tx += r.tx || 0; ty += r.ty || 0; s *= r.s ?? 1; if (r.o != null) o *= r.o; if (r.b) b += r.b; }
      return { o, b, tx, ty, s };
    }
    /** World box of a child node at time t (the group scales about its centre). */
    box(node) {
      const local = node === this.el ? { x: 0, y: 0, w: this.w, h: this.h } : boxIn(node, this.el);
      const gw = this.w, gh = this.h;
      return (t) => {
        const st = this.state(t);
        return {
          x: this.x + gw / 2 + (local.x - gw / 2) * st.s + st.tx,
          y: this.y + gh / 2 + (local.y - gh / 2) * st.s + st.ty,
          w: local.w * st.s, h: local.h * st.s,
        };
      };
    }
    rest(node) { return this.box(node)(1e6); }
    draw(t) {
      const st = this.state(t);
      if (!show(this.el, st.o > 0.002)) return;
      this.el.style.opacity = st.o >= 0.999 ? "" : st.o.toFixed(4);
      this.el.style.filter = st.b > 0.04 ? `blur(${st.b.toFixed(2)}px)` : "";
      this.el.style.transform = `translate(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px) scale(${st.s.toFixed(5)})`;
      for (const d of this.drawers || []) d(t, st);
    }
    on(fn) { (this.drawers ||= []).push(fn); return this; }
  }

  // ---------------------------------------------------------------- the Spell Tile
  /**
   * The one shape that never cuts. Its four edges, radius, fill, border and
   * shadow are springs between states; its content swaps with a short blur.
   */
  class Tile {
    constructor() {
      this.el = h("div", "tile", world);
      this.el.style.zIndex = 50;
      this.ring = h("div", "abs", this.el, { inset: "0", borderRadius: "inherit", pointerEvents: "none" });
      this.faces = [];
      this.states = [];
      this.sheens = [];
      this.presses = [];
      this.ghosts = [];
      this.sheenEl = h("div", "sheen", this.el);
    }
    /** A quick press: the shape dips a few percent and springs back. */
    press(t, amt = 0.045) { this.presses.push([t, amt]); return this; }
    init(st) {
      const r = st.rect;
      this.x0 = new Seq(r.x); this.y0 = new Seq(r.y); this.x1 = new Seq(r.x + r.w); this.y1 = new Seq(r.y + r.h);
      this.rad = new Seq(st.r ?? 12);
      this.fill = new ColorSeq(st.fill || "#7c3aed");
      this.border = new ColorSeq(st.border || "#ffffff", st.border ? 1 : 0);
      this.bw = new Seq(st.bw ?? 1);
      this.shadow = new Seq(st.shadow ?? 0.3);
      this.states.push({ t: -1e9, ...st });
      if (st.face) this.addFace(st.face, -1e9, st);
      return this;
    }
    /**
     * Go to a new state at time t. rect may be a function of time (to follow a
     * moving element). lead: "l" | "r" | "t" | "b" stretches that edge ahead.
     */
    go(t, st) {
      const sp = st.sp || SP.tile;
      const fast = { w: sp.w * 1.5, z: Math.max(sp.z, 0.86) };
      const slow = { w: sp.w * 0.62, z: 1 };
      const L = st.lead;
      const spX0 = L === "l" ? fast : L === "r" ? slow : sp;
      const spX1 = L === "r" ? fast : L === "l" ? slow : sp;
      const spY0 = L === "t" ? fast : L === "b" ? slow : sp;
      const spY1 = L === "b" ? fast : L === "t" ? slow : sp;
      const r = st.rect;
      const f = typeof r === "function";
      this.x0.to(t, f ? (u) => r(u).x : r.x, spX0);
      this.y0.to(t, f ? (u) => r(u).y : r.y, spY0);
      this.x1.to(t, f ? (u) => r(u).x + r(u).w : r.x + r.w, spX1);
      this.y1.to(t, f ? (u) => r(u).y + r(u).h : r.y + r.h, spY1);
      const csp = st.csp || { w: sp.w * 1.8, z: 1 };
      if (st.r != null) this.rad.to(t, st.r, st.rsp || sp);
      if (st.fill) this.fill.to(t, st.fill, csp);
      if (st.border !== undefined) this.border.to(t, st.border || "#ffffff", csp, st.border ? 1 : 0);
      if (st.bw != null) this.bw.to(t, st.bw, csp);
      if (st.shadow != null) this.shadow.to(t, st.shadow, csp);
      const prev = this.states[this.states.length - 1];
      if (st.face !== undefined) {
        for (const fc of this.faces) if (fc.tout == null && fc.tin < t) fc.tout = t + (st.faceOut ?? 0) + (fc.hold ?? 0);
        if (st.face) this.addFace(st.face, t + (st.faceIn ?? 0.1), st);
      }
      this.states.push({ t, ...st, prev });
      if (st.ghost !== false && typeof r !== "function") {
        // a faint outline stays where the tile started, then fades
        const el = h("div", "abs", world, { zIndex: 4, border: "1.5px dashed rgba(124, 58, 237, 0.45)", pointerEvents: "none" });
        this.ghosts.push({ t, el });
      }
      return this;
    }
    addFace(face, tin, st) {
      // face: { el, anchor: "c" | "l" | "fill" | "world", pad, world: (t)=>rect, sp }
      if (!face.el.parentNode) this.el.insertBefore(face.el, this.sheenEl);
      face.el.classList.add("face");
      this.faces.push({ ...face, tin, tout: null, st });
    }
    /** Time of the latest state change at or before t. */
    sheen(t, dur = 0.7) { this.sheens.push([t, dur]); return this; }
    rect(t) {
      const x0 = this.x0.at(t), y0 = this.y0.at(t), x1 = this.x1.at(t), y1 = this.y1.at(t);
      const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      let k = 0;
      for (const [tp, amt] of this.presses) {
        const d = t - tp;
        if (d > -0.1 && d < 0.7) k += amt * (d < 0 ? Math.exp(-((d / 0.035) ** 2)) : Math.exp(-d / 0.085));
      }
      if (k) { const dx = r.w * k / 2, dy = r.h * k / 2; r.x += dx; r.y += dy; r.w -= 2 * dx; r.h -= 2 * dy; }
      return r;
    }
    draw(t) {
      const r = this.rect(t);
      const s = this.el.style;
      s.transform = `translate(${r.x.toFixed(2)}px, ${r.y.toFixed(2)}px)`;
      s.width = r.w.toFixed(2) + "px";
      s.height = r.h.toFixed(2) + "px";
      const rad = clamp(this.rad.at(t), 0, Math.min(r.w, r.h) / 2);
      s.borderRadius = rad.toFixed(2) + "px";
      s.background = this.fill.css(t);
      const bw = this.bw.at(t);
      this.ring.style.boxShadow = `inset 0 0 0 ${bw.toFixed(2)}px ${this.border.css(t)}`;
      const sh = clamp(this.shadow.at(t), 0, 1);
      s.boxShadow = sh > 0.005
        ? `0 ${(18 * sh).toFixed(1)}px ${(44 * sh).toFixed(1)}px -${(10 * sh).toFixed(1)}px rgba(124, 58, 237, ${(0.42 * sh).toFixed(3)}), 0 2px 6px rgba(46, 16, 101, ${(0.08 * sh).toFixed(3)})`
        : "";
      for (const f of this.faces) {
        const v = vis(t, f.tin, f.tout, { sp: f.sp || SP.ui, dy: f.dy ?? 10, blur: f.blur ?? 7, dOut: f.dOut ?? 0.09, dyOut: f.dyOut ?? -6, blurOut: 7, ds: f.ds ?? 0.06 });
        if (f.cut && f.tout != null && t >= f.tout) v.o = 0;
        let pre = "";
        if (f.anchor === "world") {
          const wr = f.world(t);
          pre = `translate(${(wr.x - r.x).toFixed(2)}px, ${(wr.y - r.y).toFixed(2)}px)`;
          f.el.style.width = wr.w + "px";
          f.el.style.height = wr.h + "px";
        } else if (f.anchor === "fill") {
          f.el.style.width = r.w.toFixed(2) + "px";
          f.el.style.height = r.h.toFixed(2) + "px";
        } else if (f.anchor === "l") {
          f.el.style.height = r.h.toFixed(2) + "px";
          pre = `translate(${f.pad ?? 0}px, 0)`;
        } else {
          if (f.w == null) { f.w = f.el.offsetWidth; f.h = f.el.offsetHeight; }
          const fw = f.w, fh = f.h;
          pre = `translate(${((r.w - fw) / 2).toFixed(2)}px, ${((r.h - fh) / 2).toFixed(2)}px)`;
        }
        if (applyVis(f.el, v, pre) && f.draw) f.draw(t, r, v);
      }
      for (const g of this.ghosts) {
        const k = (t - g.t) / 0.7;
        if (!show(g.el, k > 0.04 && k < 1)) continue;
        const gr = this.rect(g.t), cur = r;
        if (gr.w > 380 || gr.h > 260) { show(g.el, false); continue; }
        const moved = Math.hypot(gr.x - cur.x, gr.y - cur.y, gr.w - cur.w, gr.h - cur.h);
        const o = Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k) * Math.min(1, moved / 60) * 0.9;
        g.el.style.opacity = o.toFixed(3);
        g.el.style.transform = `translate(${gr.x.toFixed(2)}px, ${gr.y.toFixed(2)}px)`;
        g.el.style.width = gr.w.toFixed(2) + "px";
        g.el.style.height = gr.h.toFixed(2) + "px";
        g.el.style.borderRadius = clamp(this.rad.at(g.t), 0, Math.min(gr.w, gr.h) / 2).toFixed(2) + "px";
      }
      let sv = 0, sx = -60;
      for (const [ts, dur] of this.sheens) {
        const k = (t - ts) / dur;
        if (k > 0 && k < 1) { sv = Math.sin(Math.PI * k); sx = lerp(-60, 160, smooth(k)); }
      }
      show(this.sheenEl, sv > 0.01);
      this.sheenEl.style.left = sx + "%";
      this.sheenEl.style.opacity = (sv * 0.9).toFixed(3);
    }
    /** Speed of the tile centre in world px/s (for adaptive motion blur). */
    speed(t) {
      const a = this.rect(t), b = this.rect(t - 1 / 240);
      return Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h) * 240;
    }
  }

  // ---------------------------------------------------------------- cursor
  const CURSOR_SVG = '<svg viewBox="0 0 24 24" width="46" height="46"><path d="M5.2 2.6 L5.2 19.4 L9.4 15.5 L12.1 21.6 L15.0 20.3 L12.4 14.3 L18.2 14.0 Z" fill="#0f172a" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  class Cursor {
    constructor(p0) {
      this.el = h("div", "cursor", hud);
      this.el.innerHTML = CURSOR_SVG;
      this.ripples = [];
      this.x = new Seq(p0.x); this.y = new Seq(p0.y);
      this.clicks = [];
      this.windows = [];
    }
    /** Move to world point p (or a function of t); x and y on different springs so the path bows. */
    move(t, p, sp = SP.cursor) {
      const f = typeof p === "function";
      this.x.to(t, f ? (u) => p(u).x : p.x, sp);
      this.y.to(t, f ? (u) => p(u).y : p.y, { w: sp.w * 0.78, z: 1 });
      return this;
    }
    click(t) {
      this.clicks.push(t);
      this.ripples.push([t, h("div", "ripple", hud)]);
      return this;
    }
    life(tin, tout) { this.windows.push([tin, tout]); return this; }
    pos(t, cam) {
      const c = cam.at(t);
      return toScreen({ x: this.x.at(t), y: this.y.at(t) }, c);
    }
    draw(t, cam) {
      let o = 0;
      for (const [a, b] of this.windows) o = Math.max(o, clamp((t - a) / 0.2) * (1 - clamp((t - b) / 0.2)));
      const p = this.pos(t, cam);
      const q = this.pos(t - 1 / 120, cam);
      const vx = (p.x - q.x) * 120;
      let press = 1;
      for (const c of this.clicks) press -= 0.16 * Math.exp(-(((t - c) / 0.05) ** 2));
      const lean = clamp(-vx * 0.0035, -14, 14);
      if (show(this.el, o > 0.002)) {
        this.el.style.opacity = o.toFixed(3);
        this.el.style.transform = `translate(${(p.x - 6).toFixed(2)}px, ${(p.y - 4).toFixed(2)}px) rotate(${lean.toFixed(2)}deg) scale(${press.toFixed(4)})`;
      }
      for (const [tc, r] of this.ripples) {
        const k = (t - tc) / 0.45;
        if (!show(r, k > 0 && k < 1 && o > 0.01)) continue;
        const pc = toScreen({ x: this.x.at(tc), y: this.y.at(tc) }, cam.at(t));
        const rad = 8 + 34 * (1 - (1 - k) ** 3);
        r.style.width = r.style.height = rad * 2 + "px";
        r.style.transform = `translate(${(pc.x - rad).toFixed(2)}px, ${(pc.y - rad).toFixed(2)}px)`;
        r.style.opacity = ((1 - k) * 0.7).toFixed(3);
      }
    }
  }

  // ---------------------------------------------------------------- captions
  /**
   * Words rise out of a mask one by one; the whole caption leaves fast and early.
   * lines: [[{text, cls, at}], ...]  (at = per-word entrance time, optional)
   */
  class Caption {
    constructor(lines, o) {
      this.o = o;
      this.el = h("div", "cap display", o.parent || hud, { fontSize: o.size + "px", textAlign: o.align || "left" });
      if (o.lh) this.el.style.lineHeight = o.lh;
      this.words = [];
      lines.forEach((line, li) => {
        const ln = h("div", "line", this.el);
        if (o.lineGap && li > 0) ln.style.marginTop = o.lineGap + "px";
        line.forEach((wd, wi) => {
          if (wi > 0) ln.appendChild(document.createTextNode(" "));
          const outer = h("span", "word", ln);
          const inner = h("span", wd.cls || "", outer, null, wd.text);
          if (wd.style) Object.assign(inner.style, wd.style);
          this.words.push({ outer, inner, at: wd.at, cls: wd.cls || "" });
        });
      });
      FILM.captions.push(this);
    }
    place(x, y, anchor = "tl") {
      this.px = x; this.py = y; this.anchor = anchor;
      return this;
    }
    /** Gradient text continuous across the words of each line. */
    fixGradients() {
      for (const w of this.words) {
        if (!w.cls.includes("grad-text")) continue;
        const line = w.outer.parentNode;
        const lw = line.scrollWidth || line.offsetWidth;
        const gradWords = this.words.filter((x) => x.outer.parentNode === line && x.cls.includes("grad-text"));
        const x0 = gradWords[0].outer.offsetLeft;
        const x1 = gradWords[gradWords.length - 1].outer.offsetLeft + gradWords[gradWords.length - 1].outer.offsetWidth;
        w.inner.style.backgroundSize = `${x1 - x0}px 100%`;
        w.inner.style.backgroundPosition = `${x0 - w.outer.offsetLeft}px 0`;
        void lw;
      }
    }
    draw(t) {
      const o = this.o;
      const tout = o.tout;
      const x = tout == null ? 0 : clamp((t - tout) / (o.dOut ?? 0.2));
      const xo = x * x;
      if (!show(this.el, t > o.tin - 0.01 && xo < 0.999)) return;
      if (this._w == null) { this._w = this.el.offsetWidth; this._h = this.el.offsetHeight; }
      const w = this._w, hh = this._h;
      let left = this.px, top = this.py;
      if (this.anchor[1] === "c") left -= w / 2; else if (this.anchor[1] === "r") left -= w;
      if (this.anchor[0] === "c") top -= hh / 2; else if (this.anchor[0] === "b") top -= hh;
      this.el.style.left = left + "px";
      this.el.style.top = top + "px";
      this.el.style.opacity = (1 - xo).toFixed(4);
      this.el.style.filter = xo > 0.001 ? `blur(${(xo * 10).toFixed(2)}px)` : "";
      this.el.style.transform = `translateY(${(-xo * 18).toFixed(2)}px)`;
      this.words.forEach((wd, i) => {
        const ti = wd.at ?? o.tin + i * (o.stagger ?? 0.09);
        const e = stepR(t - ti, o.sp || SP.text);
        wd.inner.style.transform = `translateY(${((1 - e) * 104).toFixed(2)}%)`;
        wd.inner.style.filter = e < 0.995 ? `blur(${((1 - clamp(e)) * 6).toFixed(2)}px)` : "";
        wd.inner.style.opacity = clamp(e * 1.6).toFixed(3);
      });
    }
  }

  // ---------------------------------------------------------------- background
  function buildBackground() {
    const aur = document.getElementById("aurora");
    const blobs = [
      { c: "139, 92, 246", a: 0.26, r: V ? 820 : 900, x: V ? 120 : 260, y: V ? 260 : 120, k: [1, 2] },
      { c: "217, 70, 239", a: 0.19, r: V ? 760 : 820, x: V ? 960 : 1700, y: V ? 520 : 200, k: [2, 1] },
      { c: "251, 191, 36", a: 0.15, r: V ? 760 : 800, x: V ? 520 : 980, y: V ? 1820 : 1060, k: [1, 3] },
    ].map((b) => {
      const el = h("div", "blob", aur, {
        width: b.r * 2 + "px", height: b.r * 2 + "px",
        background: `radial-gradient(closest-side, rgba(${b.c}, ${b.a}), rgba(${b.c}, 0))`,
      });
      return { ...b, el };
    });
    const starsEl = document.getElementById("stars");
    const R = rng(42);
    const stars = [];
    const N = V ? 34 : 44;
    for (let i = 0; i < N; i++) {
      const s = { x: R() * W, y: R() * H, size: 1.3 + R() * 2.4, a: 0.22 + R() * 0.45, k: 3 + Math.floor(R() * 9), ph: R() * Math.PI * 2, dk: 1 + Math.floor(R() * 2), dph: R() * 6.28 };
      s.els = [0, 1].map((j) => h("div", "star", starsEl, { width: s.size + "px", height: s.size + "px", left: s.x + (V ? 0 : j * W) + "px", top: s.y + (V ? j * H : 0) + "px" }));
      stars.push(s);
    }
    return { blobs, stars, starsEl };
  }

  // ---------------------------------------------------------------- grain
  function buildGrain() {
    const tiles = [];
    const R = rng(7);
    for (let i = 0; i < 12; i++) {
      const c = document.createElement("canvas");
      c.width = c.height = 384;
      const g = c.getContext("2d");
      const img = g.createImageData(384, 384);
      for (let p = 0; p < img.data.length; p += 4) {
        const v = 128 + (R() + R() + R() - 1.5) * 120;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      tiles.push(`url(${c.toDataURL("image/png")})`);
    }
    return tiles;
  }

  // ---------------------------------------------------------------- film registry
  const FILM = {
    fmt: FMT, vertical: V, W, H, render: RENDER,
    duration: 38, fps: V ? 30 : 60,
    groups: [], captions: [], drawers: [], cues: [],
    tile: null, cam: null, cursor: null,
    pan: new Seq(0),
    panDist: V ? 2600 : 2400,
    cue(t, kind, o = {}) { this.cues.push({ t: +t.toFixed(4), kind, ...o }); },
  };

  function seekAll(t) {
    const c = FILM.cam.at(t);
    world.style.transform = `translate(${W / 2}px, ${H / 2}px) scale(${c.z.toFixed(5)}) translate(${(-c.cx).toFixed(2)}px, ${(-c.cy).toFixed(2)}px)`;
    // ground: aurora drifts on 38 s cycles; stars twinkle on whole cycles and wrap through the pan.
    const P = (2 * Math.PI) / FILM.duration;
    for (const b of BG.blobs) {
      const dx = Math.sin(P * b.k[0] * t) * 60 - (c.cx - FILM.cam0.cx) * 0.03;
      const dy = Math.cos(P * b.k[1] * t) * 40 - (c.cy - FILM.cam0.cy) * 0.03;
      b.el.style.transform = `translate(${(b.x - b.r + dx).toFixed(1)}px, ${(b.y - b.r + dy).toFixed(1)}px)`;
    }
    const pan = FILM.pan.at(t);
    let sx = -(c.cx - FILM.cam0.cx) * 0.07 - (V ? 0 : pan * W);
    let sy = -(c.cy - FILM.cam0.cy) * 0.07 - (V ? pan * H : 0);
    if (V) sy = ((sy % H) + H) % H - H; else sx = ((sx % W) + W) % W - W;
    BG.starsEl.style.transform = `translate(${sx.toFixed(2)}px, ${sy.toFixed(2)}px)`;
    for (const s of BG.stars) {
      const tw = 0.5 + 0.5 * Math.sin(P * s.k * t + s.ph);
      const o = s.a * (0.35 + 0.65 * tw);
      const dy = Math.sin(P * s.dk * t + s.dph) * 6;
      for (const e of s.els) { e.style.opacity = o.toFixed(3); e.style.transform = `translateY(${dy.toFixed(2)}px)`; }
    }
    // grain re-seeded at 12 Hz (a whole number of seeds per film, so it loops)
    const gi = ((Math.floor(t * 12) % 12) + 12) % 12;
    if (GRAIN.el._i !== gi) {
      GRAIN.el._i = gi;
      GRAIN.el.style.backgroundImage = GRAIN.tiles[gi];
      GRAIN.el.style.backgroundPosition = `${(gi * 97) % 384}px ${(gi * 151) % 384}px`;
    }
    for (const g of FILM.groups) g.draw(t);
    FILM.tile.draw(t);
    for (const d of FILM.drawers) d(t, c);
    for (const cap of FILM.captions) cap.draw(t);
    FILM.cursor.draw(t, FILM.cam);
  }

  let BG, GRAIN;
  FILM.boot = async function (build) {
    await document.fonts.ready;
    await Promise.all(["400", "500", "600", "700", "800"].map((w) => document.fonts.load(`${w} 40px Inter`)));
    BG = buildBackground();
    GRAIN = { el: document.getElementById("grain"), tiles: buildGrain() };
    const tl = await (await fetch("timeline.json")).json();
    FILM.tl = tl;
    FILM.duration = tl.duration;
    build(tl);
    for (const cap of FILM.captions) cap.fixGradients();
    FILM.cues.sort((a, b) => a.t - b.t);
    fitViewport();
    addEventListener("resize", fitViewport);
    FILM.seek(Q.has("t") ? +Q.get("t") : 0);
    if (!RENDER) preview();
    FILM.isReady = true;
  };

  FILM.seek = function (t) {
    FILM.t = t;
    seekAll(t);
  };

  /** Largest on-screen speed (px/s) of the camera, tile and pan at t: drives adaptive motion blur. */
  FILM.speed = function (t) {
    const dt = 1 / 240;
    const a = FILM.cam.at(t), b = FILM.cam.at(t - dt);
    const camV = (Math.hypot(a.cx - b.cx, a.cy - b.cy) * a.z + Math.abs(Math.log(a.z / b.z)) * W * 0.5) / dt;
    const tileV = FILM.tile.speed(t) * a.z;
    const panV = Math.abs(FILM.pan.at(t) - FILM.pan.at(t - dt)) * FILM.panDist * a.z / dt;
    const cp = FILM.cursor.pos(t, FILM.cam), cq = FILM.cursor.pos(t - dt, FILM.cam);
    const curV = Math.hypot(cp.x - cq.x, cp.y - cq.y) / dt * 0.5;
    return Math.max(camV, tileV, panV, curV);
  };

  /**
   * Stereo position of a cue from the picture: the cursor for hands-on sounds,
   * the Spell Tile for everything it does. -1 = left, +1 = right.
   */
  FILM.panFor = function (cue) {
    const c = FILM.cam.at(cue.t);
    let x;
    if (["click", "key", "pen", "drag", "paste"].includes(cue.kind)) x = FILM.cursor.pos(cue.t, FILM.cam).x;
    else { const r = FILM.tile.rect(cue.t + 0.15); x = toScreen({ x: r.x + r.w / 2, y: 0 }, c).x; }
    return clamp((x / W) * 2 - 1, -1, 1);
  };

  function preview() {
    const bar = document.getElementById("bar");
    const clock = document.getElementById("clock");
    document.getElementById("scrub").hidden = false;
    bar.max = FILM.duration;
    let playing = false, t0 = 0, p0 = 0;
    const set = (t) => { t = ((t % FILM.duration) + FILM.duration) % FILM.duration; FILM.seek(t); bar.value = t; clock.textContent = `${t.toFixed(2)}  beat ${(t * 2 + 1).toFixed(0)}`; };
    bar.addEventListener("input", () => { playing = false; set(+bar.value); });
    addEventListener("keydown", (e) => {
      const f = 1 / FILM.fps;
      if (e.code === "Space") { playing = !playing; t0 = performance.now(); p0 = FILM.t; e.preventDefault(); }
      if (e.code === "ArrowRight") set(FILM.t + (e.shiftKey ? 0.5 : f));
      if (e.code === "ArrowLeft") set(FILM.t - (e.shiftKey ? 0.5 : f));
      if (e.code === "KeyR") { set(0); playing = true; t0 = performance.now(); p0 = 0; }
    });
    const loop = () => {
      if (playing) set(p0 + (performance.now() - t0) / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    set(FILM.t || 0);
  }

  Object.assign(window, {
    FILM, SP, Seq, ColorSeq, Camera, Group, Tile, Cursor, Caption,
    stepR, lead, vis, applyVis, show, clamp, lerp, smooth, ev, rng, h, icon, boxIn, rectC, grow, toScreen, toWorld,
    W, H, V,
  });
})();
