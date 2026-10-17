/*
 * scenes.js: the choreography of "Cast a spell". Every beat time comes from
 * timeline.json; this file only says what happens on each named beat.
 *
 * World layout: the end card sits at the origin. All product UI is centred on
 * the full stop of "your PDFs." (P), so the opening zoom-through into the full
 * stop lands straight in the product. The 19.0 s pan moves content, not the
 * camera, so the film ends where it began and loops.
 */
(function () {
  "use strict";

  /** A white card frame that morphs between screens (size, radius) on springs. */
  class Frame {
    constructor(cls = "card journey", z = 5) {
      this.el = h("div", "abs " + cls, world, { zIndex: z, left: 0, top: 0, transformOrigin: "0 0" });
      this.wins = [];
      this.xfs = [];
      FILM.drawers.push((t) => this.draw(t));
    }
    init(r, rad = 24) {
      this.x0 = new Seq(r.x); this.y0 = new Seq(r.y); this.x1 = new Seq(r.x + r.w); this.y1 = new Seq(r.y + r.h);
      this.rad = new Seq(rad);
      return this;
    }
    go(t, r, sp = SP.uiSoft, rad) {
      const f = typeof r === "function";
      this.x0.to(t, f ? (u) => r(u).x : r.x, sp);
      this.y0.to(t, f ? (u) => r(u).y : r.y, sp);
      this.x1.to(t, f ? (u) => r(u).x + r(u).w : r.x + r.w, sp);
      this.y1.to(t, f ? (u) => r(u).y + r(u).h : r.y + r.h, sp);
      if (rad != null) this.rad.to(t, rad, sp);
      return this;
    }
    life(tin, tout, o = {}) { this.wins.push([tin, tout, o]); return this; }
    xf(fn) { this.xfs.push(fn); return this; }
    rect(t) {
      const x0 = this.x0.at(t), y0 = this.y0.at(t), x1 = this.x1.at(t), y1 = this.y1.at(t);
      let r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      for (const fn of this.xfs) { const d = fn(t); r = { ...r, x: r.x + (d.tx || 0), y: r.y + (d.ty || 0) }; }
      return r;
    }
    draw(t) {
      let o = 1, b = 0, s = 1, dy = 0;
      for (const [a, z, op] of this.wins) { const v = vis(t, a, z, op); o *= v.o; b += v.b; s *= v.s; dy += v.y; }
      if (!show(this.el, o > 0.002)) return;
      const r = this.rect(t);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const w = r.w * s, hh = r.h * s;
      this.el.style.width = Math.max(0, w).toFixed(2) + "px";
      this.el.style.height = Math.max(0, hh).toFixed(2) + "px";
      this.el.style.transform = `translate(${(cx - w / 2).toFixed(2)}px, ${(cy - hh / 2 + dy).toFixed(2)}px)`;
      this.el.style.borderRadius = this.rad.at(t).toFixed(2) + "px";
      this.el.style.opacity = o >= 0.999 ? "" : o.toFixed(4);
      this.el.style.filter = b > 0.04 ? `blur(${b.toFixed(2)}px)` : "";
    }
  }

  /** Place a group so its measured box is centred at (cx, cy). */
  function centre(g, root, cx, cy) {
    const w = root.offsetWidth, hh = root.offsetHeight;
    g.el.style.width = w + "px";
    g.el.style.height = hh + "px";
    g.x = cx - w / 2; g.y = cy - hh / 2;
    g.el.style.left = g.x + "px";
    g.el.style.top = g.y + "px";
    return { x: g.x, y: g.y, w, h: hh };
  }

  const cen = (rf) => (t) => { const r = ev(rf, t); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
  const at = (rf, fx, fy) => (t) => { const r = ev(rf, t); return { x: r.x + r.w * fx, y: r.y + r.h * fy }; };
  const inflate = (r, k) => ({ x: r.x - k, y: r.y - k, w: r.w + 2 * k, h: r.h + 2 * k });
  const sq = (c, s) => ({ x: c.x - s / 2, y: c.y - s / 2, w: s, h: s });

  FILM.boot((tl) => {
    const O = tl.open, CH = tl.chooser, PD = tl.pdf, CP = tl.compress, DN = tl.done, ED = tl.editor;
    const AI = tl.ai, SL = tl.slides, VD = tl.video, PR = tl.price, EN = tl.end;

    // ---------------------------------------------------------------- layout per format
    const L = V
      ? {
          head: 120, caret: 0.73, lockTile: 210, wm: 118, url: 46, tag: 34,
          cap: { fs: 74, x: 510, y: 1500, anchor: "bc", align: "center" },
          act: { fs: 124, x: 510, y: 440, anchor: "cc", align: "center" },
          ui: { x: 60, y: 320, w: 920, h: 930 },
          uiAct: { x: 60, y: 660, w: 920, h: 700 },
          full: { x: 70, y: 280, w: 880, h: 1200 },
          price: { x: 60, y: 280, w: 920, h: 980 },
        }
      : {
          head: 150, caret: 0.73, lockTile: 168, wm: 108, url: 42, tag: 30,
          cap: { fs: 86, x: 150, y: 540, anchor: "cl", align: "left" },
          act: { fs: 140, x: 150, y: 540, anchor: "cl", align: "left" },
          ui: { x: 760, y: 100, w: 1040, h: 880 },
          uiAct: { x: 760, y: 100, w: 1040, h: 880 },
          full: { x: 170, y: 110, w: 1580, h: 860 },
          price: { x: 140, y: 300, w: 1640, h: 680 },
        };
    const PAN = V ? { x: 0, y: FILM.panDist } : { x: FILM.panDist, y: 0 };
    const panOut = (t) => { const p = FILM.pan.at(t); return { tx: -PAN.x * p, ty: -PAN.y * p }; };
    const panIn = (t) => { const p = 1 - FILM.pan.at(t); return { tx: PAN.x * p, ty: PAN.y * p }; };

    const cue = (t, kind, o) => FILM.cue(t, kind, o);
    const pad = (n) => n * (V ? 0.3 : 0.6);

    // ---------------------------------------------------------------- end card (also frame 0)
    const endG = new Group("end", 0, 0, { z: 20 });
    const wmWrap = h("div", "abs", endG.el, { overflow: "hidden", padding: "0.1em 0.06em 0.18em", margin: "-0.1em -0.06em -0.18em" });
    const wm = h("div", "display", wmWrap, { fontSize: L.wm + "px", fontWeight: 700, letterSpacing: "-0.025em" }, "PDF Wizard");
    const urlWrap = h("div", "abs", endG.el, { overflow: "hidden", padding: "0.1em 0.1em 0.3em", margin: "-0.1em -0.1em -0.3em" });
    const url = h("div", "", urlWrap, { fontSize: L.url + "px", fontWeight: 600, letterSpacing: "-0.01em", color: "var(--primary-ink)", whiteSpace: "nowrap" }, "pdfwizard.xyz");
    const underline = h("div", "abs", endG.el, { height: V ? "5px" : "4px", borderRadius: "3px", background: "var(--grad)", transformOrigin: "0 50%" });
    const tag = h("div", "abs muted", endG.el, { fontSize: L.tag + "px", fontWeight: 500, whiteSpace: "nowrap" }, "No sign-up needed.");
    const T0 = L.lockTile;
    let tileHome, wmBox, urlBox;
    {
      const wmW = wm.offsetWidth, wmH = wm.offsetHeight, uW = url.offsetWidth, uH = url.offsetHeight;
      if (V) {
        tileHome = { x: -T0 / 2, y: -T0 / 2 - 190, w: T0, h: T0 };
        wmBox = { x: -wmW / 2, y: tileHome.y + T0 + 54, w: wmW, h: wmH };
        urlBox = { x: -uW / 2, y: wmBox.y + wmH + 40, w: uW, h: uH };
      } else {
        const gap = 40, total = T0 + gap + wmW;
        tileHome = { x: -total / 2, y: -T0 / 2 - 34, w: T0, h: T0 };
        wmBox = { x: tileHome.x + T0 + gap, y: tileHome.y + (T0 - wmH) / 2 - 4, w: wmW, h: wmH };
        urlBox = { x: -uW / 2, y: tileHome.y + T0 + 58, w: uW, h: uH };
      }
      Object.assign(wmWrap.style, { left: wmBox.x + "px", top: wmBox.y + "px" });
      Object.assign(urlWrap.style, { left: urlBox.x + "px", top: urlBox.y + "px" });
      Object.assign(underline.style, { left: urlBox.x + "px", top: urlBox.y + urlBox.h + 10 + "px", width: urlBox.w + "px" });
      Object.assign(tag.style, { left: -tag.offsetWidth / 2 + "px", top: urlBox.y + urlBox.h + (V ? 64 : 54) + "px" });
    }
    const cam0 = V ? { cx: 0, cy: -40, z: 1 } : { cx: 0, cy: 10, z: 1 };
    FILM.cam0 = cam0;
    const cam = (FILM.cam = new Camera(cam0));

    // end-card element windows: visible before the opening, back after the logo hit
    function endWin(t, tin) {
      const out = vis(t, null, O.lockupOut, { dOut: 0.22, blurOut: 10 });
      const back = vis(t, tin, null, { sp: SP.text });
      return t < 20 ? out : back;
    }
    endG.on((t) => {
      // wordmark slides out from behind the tile; URL rises; underline draws; tagline comes and goes
      const a = endWin(t, EN.word);
      const e = t < 20 ? 1 : stepR(t - EN.word, { w: 13, z: 1 });
      show(wmWrap, a.o > 0.002);
      wm.style.transform = V ? `translateY(${(-(1 - e) * 100).toFixed(2)}%)` : `translateX(${(-(1 - e) * 104).toFixed(2)}%)`;
      wmWrap.style.opacity = a.o.toFixed(3);
      wmWrap.style.filter = a.b > 0.05 ? `blur(${a.b.toFixed(2)}px)` : "";
      const u = endWin(t, EN.url);
      const ue = t < 20 ? 1 : stepR(t - EN.url, SP.text);
      show(urlWrap, u.o > 0.002);
      urlWrap.style.opacity = u.o.toFixed(3);
      url.style.transform = `translateY(${((1 - ue) * 105).toFixed(2)}%)`;
      urlWrap.style.filter = u.b > 0.05 ? `blur(${u.b.toFixed(2)}px)` : "";
      const ul = t < 20 ? 1 - smooth((t - O.lockupOut) / 0.2) : stepR(t - EN.underline, { w: 11, z: 1 });
      show(underline, ul > 0.003);
      underline.style.transform = `scaleX(${clamp(ul).toFixed(4)})`;
      const tg = vis(t, EN.tag, EN.tagOut, { dOut: 0.3 });
      applyVis(tag, tg);
    });

    // ---------------------------------------------------------------- the Spell Tile
    const tile = (FILM.tile = new Tile());
    const hatFace = (size) => {
      const el = h("div", "", null, { width: size + "px", height: size + "px" });
      const svg = UI.hat(size, el);
      return { el, svg, w: size, h: size };
    };
    const startHat = hatFace(T0 * 0.52);
    const starTwinkle = (svg, tw) => (t) => {
      const st = svg.querySelector(".star");
      const k = (t - tw) / 0.55;
      const s = k > 0 && k < 1 ? 1 + 0.55 * Math.sin(Math.PI * k) * (1 - k * 0.3) : 1;
      const rot = k > 0 && k < 1 ? 72 * smooth(k) : 0;
      st.setAttribute("transform", `rotate(${rot.toFixed(2)} 12 9.6) translate(12 9.6) scale(${s.toFixed(4)}) translate(-12 -9.6)`);
    };
    startHat.draw = starTwinkle(startHat.svg, O.twinkle);
    tile.init({ rect: tileHome, r: T0 * 0.25, fill: "#7c3aed", shadow: 0.85, face: { ...startHat, anchor: "c" } });
    tile.sheen(O.twinkle - 0.05, 0.75);
    cue(O.twinkle, "chime", { note: "star", gain: 0.9, x: 0 });

    // ---------------------------------------------------------------- OPENING: the tile writes the headline
    const headG = new Group("head", 0, 0, { z: 20 });
    const fs = L.head;
    const l1 = h("div", "display abs", headG.el, { fontSize: fs + "px", left: 0, top: 0 });
    const l1words = ["Cast", "spells", "on"].map((w, i) => {
      if (i) l1.appendChild(document.createTextNode(" "));
      return h("span", "", l1, { display: "inline-block" }, w);
    });
    const l2 = h("div", "display abs", headG.el, { fontSize: fs + "px", left: 0, top: fs * 1.08 + "px" });
    const l2words = ["your", "PDFs"].map((w, i) => {
      if (i) l2.appendChild(document.createTextNode(" "));
      const o = h("span", "word", l2);
      return { outer: o, inner: h("span", "grad-text", o, null, w) };
    });
    const dotSpan = h("span", "", l2, { color: "transparent" }, ".");
    const base2 = h("span", "", l2, { display: "inline-block", width: 0, height: 0, verticalAlign: "baseline" });
    const base1 = h("span", "", l1, { display: "inline-block", width: 0, height: 0, verticalAlign: "baseline" });
    // centre the block on the origin (slightly above the card centre line)
    const l1w = l1.offsetWidth, l2w = l2.offsetWidth;
    const headW = Math.max(l1w, l2w), headH = fs * 2.08;
    l1.style.left = (headW - l1w) / 2 + "px";
    l2.style.left = (headW - l2w) / 2 + "px";
    centre(headG, { offsetWidth: headW, offsetHeight: headH }, 0, V ? -60 : -10);
    // gradient continuous across "your PDFs"
    {
      const x0 = l2words[0].outer.offsetLeft, x1 = l2words[1].outer.offsetLeft + l2words[1].outer.offsetWidth;
      for (const w of l2words) { w.inner.style.backgroundSize = `${x1 - x0}px 100%`; w.inner.style.backgroundPosition = `${x0 - w.outer.offsetLeft}px 0`; }
    }
    const capH = fs * L.caret;
    const baseY1 = headG.y + boxIn(base1, headG.el).y;
    const baseY2 = headG.y + boxIn(base2, headG.el).y;
    const wb = l1words.map((w) => { const b = boxIn(w, headG.el); return { x: headG.x + b.x, y: headG.y + b.y, w: b.w, h: b.h }; });
    const gapC = fs * 0.16;
    const caretAt = (x) => ({ x, y: baseY1 - capH, w: capH, h: capH });
    const dotB = boxIn(dotSpan, headG.el);
    const dotS = fs * 0.178;
    const dotRect = { x: headG.x + dotB.x + (dotB.w - dotS) / 2 - fs * 0.005, y: baseY2 - dotS + fs * 0.005, w: dotS, h: dotS };
    const P = { x: dotRect.x + dotS / 2, y: dotRect.y + dotS / 2 };

    // the tile: centre stage, then caret before "Cast", then after each word, then the full stop
    const caretSp = { w: 21, z: 1 };
    // (no outline left behind while it writes: the words are what it leaves)
    tile.go(O.caret, { rect: caretAt(wb[0].x - gapC - capH), r: capH * 0.25, sp: { w: 11, z: 1 }, ghost: false });
    const wordTimes = [O.w1, O.w2, O.w3];
    wordTimes.forEach((tw, i) => {
      tile.go(tw - 0.2, { rect: caretAt(wb[i].x + wb[i].w + gapC), sp: caretSp, lead: "r", ghost: false });
      cue(tw, "tick", { gain: 0.8, x: (wb[i].x + wb[i].w) / 900 });
    });
    const fadeStarts = [];
    headG.on((t) => {
      const tr = tile.rect(t);
      l1words.forEach((w, i) => {
        const b = wb[i];
        let k = t < O.line2 - 0.05 ? clamp((tr.x - 4 - b.x) / b.w) : 1;
        if (t < O.w1 - 0.21) k = 0;
        const out = vis(t, null, O.out + i * 0.03, { dOut: 0.16, blurOut: 10 });
        w.style.clipPath = `inset(-30% ${((1 - k) * (b.w + 8)).toFixed(2)}px -40% -12%)`;
        w.style.opacity = (clamp(k * 2.2) * out.o).toFixed(3);
        w.style.filter = out.b > 0.05 || k < 1 ? `blur(${(out.b + (1 - k) * 3).toFixed(2)}px)` : "";
        w.style.transform = `translateY(${out.y.toFixed(2)}px)`;
      });
      l2words.forEach((w, i) => {
        const e = stepR(t - (O.line2 + i * 0.09), SP.text);
        const out = vis(t, null, O.out + 0.06 + i * 0.03, { dOut: 0.16, blurOut: 10 });
        w.inner.style.transform = `translateY(${((1 - e) * 104 + out.y).toFixed(2)}%)`;
        w.outer.style.opacity = (clamp(e * 1.6) * out.o).toFixed(3);
        w.outer.style.filter = e < 0.995 || out.b > 0.05 ? `blur(${((1 - clamp(e)) * 6 + out.b).toFixed(2)}px)` : "";
      });
      show(headG.el, t > O.caret - 0.1 && t < O.out + 0.5);
    });
    void fadeStarts;
    tile.go(O.line2 - 0.02, { rect: dotRect, r: dotS * 0.42, fill: "#b45309", shadow: 0.25, face: null, sp: { w: 13, z: 0.86 }, ghost: false });
    cue(O.line2, "whoosh", { gain: 0.55, dur: 0.35, x: 0.2 });
    cue(O.line2 + 0.32, "pop", { note: 0, gain: 0.8, x: 0.3 });
    // camera: hold the end card, then a slow push into the headline
    cam.to(O.push, { cx: 0, cy: V ? -40 : -12, z: V ? 1.04 : 1.07 }, { w: 2.6, z: 1 });

    // ---------------------------------------------------------------- the card frame (PDF act)
    const frame = new Frame();
    const ch = new Group("chooser", 0, 0, { z: 10 });
    const chUI = UI.chooser(ch.el, V);
    const chBox = centre(ch, chUI.root, P.x, P.y);
    ch.el.style.overflow = "visible";
    frame.init(sq(P, dotS * 0.6), dotS * 0.3);
    frame.go(CH.in, chBox, { w: 15, z: 0.86 }, 24);
    frame.life(CH.in, AI.open + 0.04, { sp: { w: 30, z: 1 }, dy: 0, blur: 6, dOut: 0.16 });
    const optBox = (id) => ch.box(chUI.opts[id]);
    // the full stop grows into the PDF option; the other choices follow on half-beats
    const pdfOptFace = UI.optFace(UI.CHOICES[0], chUI.opts.pdf.offsetWidth, chUI.opts.pdf.offsetHeight);
    tile.go(CH.in + 0.02, { rect: optBox("pdf"), r: 16, fill: "#ffffff", border: "#e7e2ee", bw: 1, shadow: 0.35, face: { el: pdfOptFace, anchor: "c" }, faceIn: CH.pdf - CH.in, sp: { w: 14, z: 0.84 } });
    cue(CH.in, "whoosh", { gain: 0.5, dur: 0.4, x: 0.1 });
    show(chUI.opts.pdf, false);
    chUI.opts.pdf.style.visibility = "hidden";
    const chEnter = [[chUI.title, CH.title], [chUI.opts.pptx, CH.pptx], [chUI.opts.slides, CH.slides], [chUI.opts.media, CH.media], [chUI.drop, CH.drop]];
    ch.on((t) => {
      for (const [el, tin] of chEnter) {
        if (el === chUI.opts.pdf) continue;
        const v = vis(t, tin, CH.click + 0.05 + (el === chUI.title ? 0 : 0.03), { sp: SP.ui, dy: 18, ds: -0.06, blur: 8, dOut: 0.12 });
        applyVis(el, v);
      }
    });
    [CH.pdf, CH.pptx, CH.slides, CH.media].forEach((tp, i) => cue(tp, "pop", { note: i, gain: 0.75, x: -0.4 + i * 0.27 }));
    show(ch.el, true);
    ch.life(CH.in, CH.click + 0.4, { dy: 0, blur: 0, sp: { w: 40, z: 1 } });

    // camera dives into the full stop: the card fills the frame
    const regA = L.full;
    cam.to(CH.in - 0.05, Camera.fit(inflate(chBox, pad(40)), V ? L.ui : regA), { w: 7, z: 1 });

    // cursor
    const offscreen = (sx, sy) => (t) => toWorld({ x: sx, y: sy }, cam.at(t));
    const off0 = offscreen(W + 80, H * 0.92);
    const cursor = (FILM.cursor = new Cursor({ x: (t) => off0(t).x, y: (t) => off0(t).y }));
    cursor.life(CH.cursorIn, PR.cursorOut + 0.6);
    const moveTo = (t, target, sp) => cursor.move(t, target, sp);
    const click = (t, x = 0, kind = "click") => { cursor.click(t); cue(t, kind, { gain: 0.9, x }); };

    moveTo(CH.cursorIn, at(optBox("pdf"), 0.62, 0.66), { w: 7.5, z: 1 });
    click(CH.click, -0.2);
    tile.go(CH.click, { rect: optBox("pdf"), fill: "#f5f3ff", border: "#8b5cf6", bw: 2, sp: SP.pop });
    tile.press(CH.click);

    // ---------------------------------------------------------------- PDF branch
    const br = new Group("branch", 0, 0, { z: 10 });
    const brUI = UI.pdfBranch(br.el, V);
    // the card keeps its top edge and grows downwards, like the site's journey card
    const brBox = centre(br, brUI.root, P.x, chBox.y + brUI.root.offsetHeight / 2);
    // the card grows with its content: header and file first, then the tool grid
    {
      const chipB = boxIn(brUI.chip, br.el);
      frame.go(PD.out - 0.02, { ...brBox, h: chipB.y + chipB.h + 16 }, SP.uiSoft);
      frame.go(PD.grid - 0.08, brBox, { w: 13, z: 0.9 });
    }
    br.life(PD.out, CP.panel + 0.05, { dy: 0, blur: 0, sp: { w: 40, z: 1 } });
    const chipFace = UI.fileChipFace("proposal.pdf", "file-text", brUI.chip.offsetWidth, 52);
    tile.go(PD.chip - 0.12, { rect: br.box(brUI.chip), r: 12, fill: "#f4f2f8", border: null, bw: 0, shadow: 0.22, face: { el: chipFace, anchor: "c" }, sp: { w: 14, z: 0.74 }, lead: "t" });
    cue(PD.chip, "drop", { gain: 0.8, x: 0 });
    const toolsOrder = ["edit", "sign", "compress", "word", "pptx", "ai", "ocr", "split", "protect"];
    br.on((t) => {
      applyVis(brUI.header, vis(t, PD.header, CP.panel, { sp: SP.ui, dy: 12, blur: 6, dOut: 0.12 }));
      // static chip appears only once the tile has left it
      show(brUI.chip, t > PD.toCompress - 0.05);
      brUI.chip.style.opacity = vis(t, null, CP.panel + 0.02, { dOut: 0.12 }).o;
      toolsOrder.forEach((id, i) => {
        const el = brUI.tools[id];
        if (id === "compress" && t < CP.panel + 0.2) { show(el, false); return; }
        const v = vis(t, PD.grid + i * PD.gridStep, CP.panel + 0.02 + Math.abs(i - 2) * 0.02, { sp: SP.ui, dy: 14, ds: -0.08, blur: 8, dOut: 0.1 });
        applyVis(el, v);
      });
    });
    toolsOrder.forEach((id, i) => cue(PD.grid + i * PD.gridStep, "pop", { note: i % 5, gain: 0.4, x: -0.3 + (i % 3) * 0.3 }));

    // caption: Stays on your device.
    const capLines = (words) => words.map((ln) => ln.split(" ").map((w) => ({ text: w })));
    const caption = (lines, tin, tout, o = {}) => {
      const c = new Caption(o.raw || capLines(lines), { size: o.fs || L.cap.fs, tin, tout, align: L.cap.align, stagger: 0.09, lh: 1.04, ...o });
      c.place(o.x ?? L.cap.x, o.y ?? L.cap.y, o.anchor || L.cap.anchor);
      return c;
    };
    caption(V ? ["Stays on", "your device."] : ["Stays on", "your device."], PD.caption, PD.captionOut);
    cue(PD.caption, "whoosh", { gain: 0.35, dur: 0.3, x: -0.6 });

    cam.to(PD.out - 0.05, Camera.fit(inflate(brBox, pad(24)), L.ui), SP.camMed);

    // pick Compress
    const cmpFace = UI.toolFace(UI.PDF_TOOLS[2], brUI.tools.compress.offsetWidth, brUI.tools.compress.offsetHeight, V);
    moveTo(PD.toCompress - 0.25, at(br.box(brUI.tools.compress), 0.6, 0.62), { w: 9, z: 1 });
    tile.go(PD.toCompress, { rect: br.box(brUI.tools.compress), r: 12, fill: "#ffffff", border: "#e7e2ee", bw: 1, shadow: 0.3, face: { el: cmpFace, anchor: "c" }, sp: { w: 15, z: 0.84 } });
    cue(PD.toCompress + 0.12, "whoosh", { gain: 0.25, dur: 0.22, x: 0.2 });
    click(PD.click, 0.2);
    tile.go(PD.click, { rect: br.box(brUI.tools.compress), fill: "#f5f3ff", border: "#8b5cf6", bw: 2, sp: SP.pop });
    tile.press(PD.click);

    // ---------------------------------------------------------------- Compress
    const cp = new Group("compress", 0, 0, { z: 10 });
    const cpUI = UI.compressPanel(cp.el, V);
    const cpBox = centre(cp, cpUI.root, P.x, P.y);
    frame.go(CP.panel - 0.02, cpBox, SP.uiSoft);
    cp.life(CP.panel, DN.check + 0.02, { dy: 0, blur: 0, sp: { w: 40, z: 1 } });
    const cpKids = [...cpUI.root.children];
    cp.on((t) => {
      cpKids.forEach((el, i) => {
        if (el === cpUI.btn || el === cpUI.bar) return;
        if (el === cpUI.casting) { applyVis(el, vis(t, CP.barStart, DN.check, { sp: SP.ui, dy: 8, dOut: 0.1 })); return; }
        applyVis(el, vis(t, CP.panel + 0.06 + i * 0.05, DN.check + 0.0, { sp: SP.ui, dy: 14, blur: 7, dOut: 0.12 }));
      });
    });
    const castFace = UI.castFace();
    tile.go(CP.button - 0.2, { rect: cp.box(cpUI.btn), r: 12, fill: "#7c3aed", border: null, bw: 0, shadow: 0.7, face: { el: castFace, anchor: "c" }, sp: { w: 14, z: 0.82 } });
    moveTo(CP.button - 0.05, at(cp.box(cpUI.btn), 0.66, 0.6), { w: 8, z: 1 });
    click(CP.click, 0.05);
    tile.press(CP.click, 0.05);
    // the button stretches into the progress bar: front edge first
    const barFill = h("div", "", null, { height: "100%", borderRadius: "999px", background: "linear-gradient(90deg, #a78bfa, #7c3aed 55%, #c026d3)" });
    const barFace = { el: h("div", "", null, { display: "block" }), anchor: "fill", draw: (t, r) => {
      const k = clamp((t - CP.barStart) / (CP.barEnd - CP.barStart));
      const p = 0.04 + 0.96 * (k * k * (1.6 - 0.6 * k));
      barFill.style.width = (p * 100).toFixed(3) + "%";
    } };
    barFace.el.appendChild(barFill);
    barFace.el.style.justifyContent = "flex-start";
    tile.go(CP.click + 0.06, { rect: cp.box(cpUI.bar), r: 5, fill: "#ede9fe", shadow: 0.0, face: barFace, faceIn: 0.04, sp: { w: 15, z: 0.9 }, lead: "r" });
    cue(CP.click + 0.08, "whoosh", { gain: 0.3, dur: 0.25, x: 0.2 });
    // camera: frame the panel, then lean in through the build
    cam.to(CP.panel - 0.05, Camera.fit(inflate(cpBox, pad(30)), L.ui), SP.camMed);
    cam.to(CP.click, Camera.fit(inflate(cpBox, -10), L.ui), { w: 2.4, z: 1 });

    // ---------------------------------------------------------------- Spell complete (the drop)
    const dn = new Group("done", 0, 0, { z: 10 });
    const dnUI = UI.donePanel(dn.el, V);
    const dnBox = centre(dn, dnUI.root, P.x, P.y);
    frame.go(DN.check - 0.03, dnBox, { w: 18, z: 0.84 });
    dn.life(DN.check, ED.open + 0.04, { dy: 0, blur: 0, sp: { w: 40, z: 1 } });
    const ck = UI.checkFace(68, 3);
    ck.draw = (t) => { ck._path.setAttribute("stroke-dashoffset", (100 * (1 - smooth((t - DN.check - 0.06) / 0.24))).toFixed(2)); };
    tile.go(DN.check - 0.06, { rect: dn.box(dnUI.check), r: 34, fill: "#10b981", shadow: 0.3, face: { el: ck, anchor: "c", sp: SP.pop }, faceIn: 0.05, sp: { w: 16, z: 0.8 } });
    cue(DN.check, "drop", { gain: 1, x: 0, big: true });
    cue(DN.check + 0.02, "chime", { note: "success", gain: 1, x: 0 });
    cam.to(DN.check - 0.12, Camera.fit(inflate(dnBox, pad(30)), V ? L.ui : L.full), { w: 9, z: 1 });
    cam.punch(DN.check, V ? 0.06 : 0.08, 0.5);
    // static check, shown once the tile moves on
    const ckStatic = h("div", "abs ico", dnUI.check, { inset: 0, borderRadius: "50%", background: "#10b981", color: "#fff", boxShadow: "0 10px 24px -10px rgba(16,185,129,0.6)" });
    icon("check", 32, 3, ckStatic);
    const dnItems = [[dnUI.glow, DN.check], [dnUI.title, DN.title], [dnUI.dl, DN.buttons], [dnUI.so, DN.buttons + 0.08], [dnUI.nextLbl, DN.next]];
    UI.NEXT.forEach((n, i) => dnItems.push([dnUI.chips[n.id], DN.chips + i * DN.chipStep]));
    dn.on((t) => {
      show(ckStatic, t > DN.toChip - 0.05);
      for (const [el, tin] of dnItems) {
        applyVis(el, vis(t, tin, ED.open + 0.02, { sp: SP.ui, dy: 14, blur: 7, ds: el === dnUI.glow ? 0 : -0.04, dOut: 0.12 }));
      }
    });
    UI.NEXT.forEach((n, i) => cue(DN.chips + i * DN.chipStep, "pop", { note: 2 + i, gain: 0.45, x: -0.35 + i * 0.23 }));
    cue(DN.title, "whoosh", { gain: 0.2, dur: 0.2, x: 0 });

    // Edit PDF chip
    const editChipFace = UI.pillFace(UI.NEXT[0]);
    tile.go(DN.toChip, { rect: dn.box(dnUI.chips.edit), r: 22, fill: "#ffffff", border: "#e7e2ee", bw: 1, shadow: 0.35, face: { el: editChipFace, anchor: "c" }, sp: { w: 14, z: 0.84 } });
    cue(DN.toChip + 0.1, "whoosh", { gain: 0.25, dur: 0.22, x: -0.2 });
    moveTo(DN.toChip - 0.15, at(dn.box(dnUI.chips.edit), 0.6, 0.62), { w: 7, z: 1 });
    click(DN.click, -0.25);
    tile.press(DN.click);

    // ---------------------------------------------------------------- PDF editor
    const ed = new Group("editor", 0, 0, { z: 10 });
    const edUI = UI.editor(ed.el, V);
    const edBox = centre(ed, edUI.root, P.x, P.y + (V ? -20 : 0));
    ed.el.style.borderRadius = "18px";
    const pageNode = edUI.page.pg;
    // the chip opens into the page: the tile is a window onto a copy of the page laid at its world box
    const pageCopy = UI.page(null, pageNode.offsetWidth);
    pageCopy.pg.style.position = "absolute";
    pageCopy.pg.style.boxShadow = "none";
    const pageBox = ed.box(pageNode);
    frame.go(ED.open + 0.04, V ? inflate(edBox, 0) : edBox, { w: 11, z: 0.9 }, V ? 24 : 18);
    if (V) frame.life(null, ED.open + 0.1, { dOut: 0.25 });
    ed.life(ED.chrome, AI.open + 0.06, { sp: { w: 16, z: 1 }, dy: 0, blur: 6, ds: 0.03, dOut: 0.16 });
    const pageFace = { el: pageCopy.pg, anchor: "world", world: pageBox, cut: true, hold: 0.5 };
    tile.go(ED.open + 0.02, { rect: pageBox, r: 4, fill: "#ffffff", border: null, bw: 0, shadow: 0.0, face: pageFace, faceIn: 0.0, sp: { w: 10, z: 0.92 } });
    cue(ED.open + 0.05, "whoosh", { gain: 0.6, dur: 0.45, x: 0 });
    // camera: the page fills the frame, then pull back to reveal the editor
    cam.to(ED.open - 0.02, Camera.fit(inflate(ed.box(pageNode)(ED.pull), 10), V ? L.full : { x: 160, y: 40, w: 1600, h: 1000 }, 1.0), { w: 7, z: 1 });
    cam.to(ED.pull, Camera.fit(inflate(edBox, pad(20)), L.ui), { w: 5.5, z: 1 });

    // editing: Type tool, the Status field, the signature
    const toolT = UI.toolFaceIcon("type", V ? 19 : 18);
    const toolS = UI.toolFaceIcon("signature", V ? 19 : 18);
    tile.go(ED.tool, { rect: ed.box(edUI.tools.type), r: V ? 19 : 9, fill: "#7c3aed", shadow: 0.5, face: { el: toolT, anchor: "c" }, faceIn: 0.12, sp: { w: 13, z: 0.86 } });
    cue(ED.tool + 0.18, "tick", { gain: 0.6, x: -0.3 });
    const fieldBox = ed.box(edUI.page.field);
    const typed = h("div", "abs", edUI.page.field, { left: 10 * edUI.page.k + "px", top: 0, bottom: 0, display: "flex", alignItems: "center", fontSize: 17 * edUI.page.k + "px", fontWeight: 600, color: "#1e1b4b", whiteSpace: "nowrap" });
    const typedTxt = h("span", "", typed);
    const caret = h("span", "", typed, { display: "inline-block", width: Math.max(1.5, 2 * edUI.page.k) + "px", height: "1.15em", background: "#7c3aed", marginLeft: "2px" });
    const WORD = "Approved";
    for (let i = 0; i < WORD.length; i++) cue(ED.type + i * ED.charStep, "key", { gain: 0.75, i, x: 0.05 * i - 0.1 });
    ed.on((t) => {
      const n = clamp(Math.floor((t - ED.type) / ED.charStep) + 1, 0, WORD.length);
      typedTxt.textContent = t >= ED.type ? WORD.slice(0, n) : "";
      const blinkOn = t < ED.fieldClick ? false : t < ED.type + WORD.length * ED.charStep + 0.05 ? true : Math.floor((t - ED.type) * 2.4) % 2 === 0;
      caret.style.opacity = blinkOn && t < ED.toSign ? 1 : 0;
      edUI.page.field.style.boxShadow = t > ED.fieldClick && t < ED.toSign + 0.2 ? `0 0 0 ${3 * edUI.page.k}px rgba(124,58,237,0.25)` : "";
    });
    moveTo(ED.tool + 0.05, at(fieldBox, 0.32, 0.55), { w: 6.5, z: 1 });
    click(ED.fieldClick, 0.0);
    const pb = ed.box(pageNode)(ED.push), eb = ed.box(ed.el)(ED.push), sb = ed.box(edUI.page.sigArea)(ED.push);
    const pushRect = { x: pb.x - 70, y: eb.y - 6, w: pb.w + 140, h: sb.y + sb.h + 60 - (eb.y - 6) };
    cam.to(ED.push, Camera.fit(V ? inflate(ed.box(pageNode)(ED.push), -10) : pushRect, L.ui), { w: 3.2, z: 1 });

    // signature: drawn with the pen, speed varying along the stroke
    const sigSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const sigK = edUI.page.k;
    sigSvg.setAttribute("viewBox", "0 0 250 70");
    sigSvg.setAttribute("width", 250 * sigK);
    sigSvg.setAttribute("height", 70 * sigK);
    sigSvg.style.position = "absolute"; sigSvg.style.left = "0"; sigSvg.style.top = "0"; sigSvg.style.overflow = "visible";
    sigSvg.innerHTML = '<path d="M14 48 C 22 22, 34 12, 38 26 C 41 38, 30 54, 26 50 C 22 45, 40 30, 52 36 C 60 40, 56 52, 64 50 C 74 47, 78 30, 84 34 C 90 38, 84 52, 92 50 C 102 47, 106 28, 114 32 C 120 36, 112 54, 124 50 C 140 44, 150 22, 158 30 C 164 37, 152 56, 166 52 C 184 46, 204 34, 236 38" fill="none" stroke="#1e1b4b" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" pathLength="1000" stroke-dasharray="1000" stroke-dashoffset="1000"/>';
    edUI.page.sigArea.appendChild(sigSvg);
    const sigPath = sigSvg.querySelector("path");
    const sigProg = (t) => { const k = clamp((t - ED.sign) / (ED.signEnd - ED.sign)); return k + 0.06 * Math.sin(k * Math.PI * 6) * (1 - k) * k * 4; };
    ed.on((t) => sigPath.setAttribute("stroke-dashoffset", (1000 * (1 - clamp(sigProg(t)))).toFixed(1)));
    const sigBox = ed.box(edUI.page.sigArea);
    tile.go(ED.toSign, { rect: ed.box(edUI.tools.signature), face: { el: toolS, anchor: "c" }, faceIn: 0.1, sp: { w: 14, z: 0.86 }, lead: V ? "r" : "r" });
    cue(ED.toSign + 0.15, "tick", { gain: 0.55, x: 0.1 });
    // pen follows the stroke
    const sigPt = (t) => {
      const r = sigBox(t);
      const len = clamp(sigProg(t)) * sigPath.getTotalLength();
      const p = sigPath.getPointAtLength(len);
      return { x: r.x + (p.x / 250) * r.w, y: r.y + (p.y / 70) * r.h };
    };
    moveTo(ED.toSign + 0.12, (t) => sigPt(Math.max(t, ED.sign)), { w: 9, z: 1 });
    cursor.click(ED.sign);
    {
      // the pen sound follows the stroke speed: export it with the cue
      const env = [];
      for (let t = ED.sign; t <= ED.signEnd + 1e-6; t += 0.01) { const a = sigPt(t), b = sigPt(t - 0.01); env.push(+(Math.hypot(a.x - b.x, a.y - b.y) / 0.01).toFixed(1)); }
      cue(ED.sign, "pen", { gain: 0.8, dur: ED.signEnd - ED.sign, x: 0, env, envRate: 100 });
    }
    // Save
    const saveFace = UI.saveFace();
    tile.go(ED.toSave + 0.25, { rect: ed.box(edUI.save), r: 12, fill: "#7c3aed", shadow: 0.6, face: { el: saveFace, anchor: "c" }, faceIn: 0.1, sp: { w: 12, z: 0.84 } });
    cue(ED.toSave + 0.4, "whoosh", { gain: 0.25, dur: 0.25, x: 0.5 });
    cam.to(ED.toSave + 0.1, Camera.fit(inflate(edBox, pad(20)), L.ui), { w: 5, z: 1 });
    moveTo(ED.signEnd + 0.02, at(ed.box(edUI.save), 0.6, 0.6), { w: 9, z: 1 });
    click(ED.save, 0.5);
    tile.press(ED.save, 0.06);
    // the static Save button is hidden while the tile is on it
    ed.on((t) => { edUI.save.style.visibility = t > ED.toSave + 0.25 ? "hidden" : ""; });
    // caption: Edit. Fill. Sign.
    {
      const lines = V
        ? [[{ text: "Edit.", at: ED.edit }, { text: "Fill.", at: ED.fill }, { text: "Sign.", at: ED.sign }]]
        : [[{ text: "Edit.", at: ED.edit }], [{ text: "Fill.", at: ED.fill }], [{ text: "Sign.", at: ED.sign }]];
      caption(null, ED.edit, ED.captionOut, { raw: lines });
      cue(ED.edit, "whoosh", { gain: 0.3, dur: 0.25, x: -0.6 });
    }

    // ---------------------------------------------------------------- Ask your PDF
    const aiG = new Group("ai", 0, 0, { z: 10 });
    const aiUI = UI.aiPanel(aiG.el, V);
    const aiBox = centre(aiG, aiUI.root, P.x, P.y);
    aiG.el.classList.add("card");
    aiG.el.style.borderRadius = "24px";
    aiG.xf(panOut);
    const aiCopy = UI.aiPanel(null, V);
    const aiState = (ui, t) => {
      const pressed = t > AI.click;
      const s = ui.chips.Summarize;
      s.style.borderColor = pressed ? "#8b5cf6" : "";
      s.style.color = pressed ? "#6d28d9" : "";
      s.style.background = pressed ? "#f5f3ff" : "#fff";
      applyVis(ui.empty, vis(t, null, AI.bubble, { dOut: 0.12 }));
      applyVis(ui.bubble, vis(t, AI.bubble + 0.04, null, { sp: SP.ui, dy: 12, ds: -0.04 }));
      applyVis(ui.think, vis(t, AI.think, null, { sp: SP.ui, dy: 12 }));
      ui.dots.forEach((d, i) => {
        const ph = (t - AI.think) * 2 * Math.PI / 0.9 - i * 1.05;
        d.style.transform = `translateY(${(t > AI.think ? -3 * Math.max(0, Math.sin(ph)) : 0).toFixed(2)}px)`;
        d.style.opacity = t > AI.think ? (0.45 + 0.55 * Math.max(0, Math.sin(ph))).toFixed(3) : 0.5;
      });
    };
    const aiFace = { el: aiCopy.root, anchor: "c", w: aiBox.w, h: aiBox.h, draw: (t) => aiState(aiCopy, t), sp: SP.uiSoft };
    tile.go(AI.open, { rect: aiBox, r: 24, fill: "#ffffff", border: "#e7e2ee", bw: 1, shadow: 0.5, face: aiFace, faceIn: 0.12, sp: { w: 10, z: 0.88 } });
    cue(AI.open + 0.02, "whoosh", { gain: 0.5, dur: 0.4, x: 0.3 });
    cam.to(AI.open, Camera.fit(inflate(aiBox, pad(30)), L.ui), { w: 6.5, z: 1 });
    aiG.on((t) => aiState(aiUI, t));
    show(aiG.el, false);
    aiG.life(AI.collapse - 0.04, null, { sp: { w: 60, z: 1 }, dy: 0, blur: 0 });
    aiG.on((t) => show(aiG.el, t > AI.collapse - 0.04 && t < SL.pan + 1.0));
    moveTo(AI.open + 0.1, (t) => toWorld({ x: V ? W * 0.72 : W * 0.86, y: V ? H * 0.62 : H * 0.8 }, cam.at(t)), { w: 5, z: 1 });
    moveTo(AI.click - 0.55, at(aiG.box(aiUI.chips.Summarize), 0.55, 0.62), { w: 8, z: 1 });
    click(AI.click, 0.1);
    cue(AI.bubble + 0.05, "pop", { note: 4, gain: 0.5, x: 0.4 });
    for (let i = 0; i < 3; i++) cue(AI.think + 0.1 + i * 0.15, "blip", { note: i, gain: 0.25, x: -0.1 });
    caption(V ? ["Ask your PDF."] : ["Ask your", "PDF."], AI.caption, AI.captionOut);
    cue(AI.caption, "whoosh", { gain: 0.3, dur: 0.25, x: -0.6 });
    // collapse into the tile's own violet form, which rides through the pan
    const midHat = hatFace(V ? 78 : 64);
    const homeSmall = V ? 150 : 128;
    const tileFly = sq({ x: aiBox.x + aiBox.w / 2, y: aiBox.y + aiBox.h / 2 }, homeSmall);
    tile.go(AI.collapse, { rect: tileFly, r: homeSmall * 0.25, fill: "#7c3aed", border: null, bw: 0, shadow: 0.85, face: { ...midHat, anchor: "c" }, faceIn: 0.12, sp: { w: 12, z: 0.86 } });
    cue(AI.collapse + 0.05, "whoosh", { gain: 0.35, dur: 0.3, x: 0 });
    cursor.move(AI.collapse, offscreen(V ? W * 0.5 : W * 0.55, H + 120), { w: 6, z: 1 });

    // ---------------------------------------------------------------- SLIDES (after the pan)
    FILM.pan.to(SL.pan, 1, { w: 8.2, z: 1 });
    cue(SL.pan, "whip", { gain: 1, dur: 0.5, x: V ? 0 : -0.6 });
    caption(null, SL.title, SL.titleOut, { raw: V ? [[{ text: "your", cls: "grad-text" }, { text: "slides.", cls: "grad-text" }]] : [[{ text: "your", cls: "grad-text" }], [{ text: "slides.", cls: "grad-text" }]], fs: L.act.fs, x: L.act.x, y: L.act.y, anchor: L.act.anchor, align: L.act.align, lh: 1.0 });
    const frame2 = new Frame();
    const pp = new Group("pptx", 0, 0, { z: 10 });
    const ppUI = UI.pptxCard(pp.el, V);
    const ppBox = centre(pp, ppUI.root, P.x, P.y + (V ? 40 : 0));
    pp.xf(panIn);
    frame2.init(ppBox, 24).xf(panIn);
    frame2.life(SL.card - 0.1, SL.click + 0.08, { sp: { w: 60, z: 1 }, dy: 0, blur: 0, dOut: 0.14, dsOut: -0.04 });
    pp.life(SL.card - 0.1, SL.click + 0.06, { sp: { w: 60, z: 1 }, dy: 0, blur: 0, dOut: 0.12 });
    pp.on((t) => { ppUI.edit.style.visibility = "hidden"; });
    cam.to(SL.pan, Camera.fit(inflate(ppBox, pad(30)), L.uiAct), { w: 6, z: 1 });
    const edPpFace = UI.editPptxFace(ppUI.edit.offsetWidth, ppUI.edit.offsetHeight);
    tile.go(SL.toEdit, { rect: pp.box(ppUI.edit), r: 16, fill: "#ffffff", border: "#e7e2ee", bw: 1, shadow: 0.35, face: { el: edPpFace, anchor: "c" }, faceIn: 0.1, sp: { w: 12, z: 0.84 } });
    cue(SL.toEdit + 0.15, "pop", { note: 1, gain: 0.55, x: 0.3 });
    moveTo(SL.toEdit - 0.15, at(pp.box(ppUI.edit), 0.6, 0.66), { w: 6, z: 1 });
    click(SL.click, 0.3);
    tile.press(SL.click);

    // Edit PPTX
    const pe = new Group("pptxEditor", 0, 0, { z: 10 });
    const peUI = UI.pptxEditor(pe.el, V);
    const peBox = centre(pe, peUI.root, P.x, P.y + (V ? 60 : 0));
    // vertical: the stacked slides sit under the act title, so they clear out just before it rises
    pe.life(SL.editor, VD.title + (V ? -0.14 : 0.04), { sp: { w: 16, z: 1 }, dy: 0, blur: 6, ds: 0.03, dOut: 0.16 });
    const bandNode = V ? peUI.thumbs[0].band : peUI.band;
    const bandBox = pe.box(bandNode);
    const bandF = UI.bandFace(peUI.k, bandNode.offsetWidth, bandNode.offsetHeight);
    const bandFace = { el: bandF.f, anchor: "c", w: bandNode.offsetWidth, h: bandNode.offsetHeight, draw: (t) => {
      const sel = t > SL.select && t < SL.type1;
      bandF.sel.style.opacity = sel ? 1 : 0;
      bandF.d4.style.visibility = t < SL.type1 ? "" : "hidden";
      bandF.d1.style.visibility = t < SL.type1 ? "hidden" : "";
      const blink = t > SL.type1 ? Math.floor((t - SL.type1) * 2.4) % 2 === 0 : false;
      bandF.caret.style.opacity = blink || (t > SL.type1 && t < SL.type1 + 0.4) ? 1 : 0;
      if (t > SL.toPdf) bandF.caret.style.opacity = 0;
    } };
    tile.go(SL.band, { rect: bandBox, r: V ? 13 : 14, fill: "#7c3aed", border: null, bw: 0, shadow: 0.4, face: bandFace, faceIn: 0.2, sp: { w: 10, z: 0.88 } });
    cue(SL.band + 0.05, "whoosh", { gain: 0.5, dur: 0.4, x: 0.2 });
    if (V) {
      // vertical: the stacked slides get their own moves (title edit, the drag, then the PDF button)
      const topBar = pe.box(peUI.top)(SL.click + 1), th = peUI.thumbs.map((x) => pe.box(x.th)(SL.click + 1));
      const span = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
      cam.to(SL.click, Camera.fit(inflate(span(topBar, th[0]), 16), L.ui), { w: 6, z: 1 });
      cam.to(SL.dragPress - 0.3, Camera.fit(inflate(span(th[1], th[2]), 16), L.ui), { w: 6, z: 1 });
      cam.to(SL.toPdf - 0.1, Camera.fit(inflate(span(topBar, th[1]), 16), L.ui), { w: 6, z: 1 });
    } else cam.to(SL.click, Camera.fit(inflate(peBox, pad(16)), L.uiAct), { w: 6, z: 1 });
    // the title edit lands everywhere it shows
    const titleNodes = [peUI.thumbs[0].band];
    if (!V) titleNodes.push(peUI.band);
    pe.on((t) => {
      for (const n of titleNodes) n.firstChild.nodeValue = t > SL.type1 + 0.06 ? "Q1 Plan" : "Q4 Plan";
      bandNode.style.visibility = t < SL.toPdf + 0.05 ? "hidden" : "";
    });
    const qDigit = (t) => { const r = bandBox(t); return { x: r.x + (44 + 34 * 0.72) * peUI.k + 6, y: r.y + r.h * 0.6 }; };
    moveTo(SL.select - 0.3, qDigit, { w: 8, z: 1 });
    click(SL.select, 0.1);
    cursor.click(SL.select + 0.12);
    cue(SL.select + 0.12, "click", { gain: 0.6, x: 0.1 });
    cue(SL.type1, "key", { gain: 0.9, i: 3, x: 0.1 });
    caption(V ? ["Edit slides."] : ["Edit slides."], SL.caption1, SL.captionOut, { raw: V ? [[{ text: "Edit", at: SL.caption1 }, { text: "slides.", at: SL.caption1 + 0.09 }], [{ text: "Save", at: SL.caption2 }, { text: "as", at: SL.caption2 + 0.09 }, { text: "PDF.", at: SL.caption2 + 0.18 }]] : [[{ text: "Edit", at: SL.caption1 }, { text: "slides.", at: SL.caption1 + 0.09 }], [{ text: "Save", at: SL.caption2 }, { text: "as", at: SL.caption2 + 0.09 }, { text: "PDF.", at: SL.caption2 + 0.18 }]] });
    cue(SL.caption1, "whoosh", { gain: 0.3, dur: 0.25, x: -0.6 });

    // drag slide 3 up to second place: the top edge leads, the bottom follows
    {
      const th = peUI.thumbs;
      const pitch = V ? 230 : 100;
      const top3 = new Seq(0).to(SL.dragMove, -pitch, { w: 17, z: 0.9 }).to(SL.dragRelease, -pitch, SP.ui);
      const bot3 = new Seq(0).to(SL.dragMove + 0.02, -pitch, { w: 9.5, z: 1 });
      const shift2 = new Seq(0).to(SL.dragMove + 0.16, pitch, { w: 15, z: 0.82 });
      const lift = new Seq(0).to(SL.dragPress, 1, SP.pop).to(SL.dragRelease, 0, SP.ui);
      const h3 = th[2].th.offsetHeight;
      pe.on((t) => {
        const tt = top3.at(t), bb = bot3.at(t), l = lift.at(t);
        const stretch = (h3 + (bb - tt)) / h3;
        th[2].th.style.transform = `translateY(${tt.toFixed(2)}px) scale(${(1 + 0.04 * l).toFixed(4)}, ${(stretch * (1 + 0.04 * l)).toFixed(4)})`;
        th[2].th.style.transformOrigin = "50% 0";
        th[2].th.style.zIndex = 3;
        th[2].th.style.boxShadow = `0 ${(16 * l).toFixed(1)}px ${(30 * l).toFixed(1)}px -10px rgba(46,16,101,${(0.35 * l).toFixed(3)})`;
        th[1].th.style.transform = `translateY(${shift2.at(t).toFixed(2)}px)`;
        const swapped = t > SL.dragMove + 0.25;
        th[2].badge.textContent = swapped ? "2" : "3";
        th[1].badge.textContent = swapped ? "3" : "2";
      });
      const thumbBox = pe.box(th[2].th);
      const grip = (t) => { const r = thumbBox(t); return { x: r.x + r.w * 0.55, y: r.y + r.h * 0.5 + top3.at(t) * (pe.state(t).s) }; };
      moveTo(SL.type1 + 0.15, (t) => { const r = thumbBox(t); return { x: r.x + r.w * 0.55, y: r.y + r.h * 0.5 }; }, { w: 8, z: 1 });
      moveTo(SL.dragPress - 0.02, grip, { w: 30, z: 1 });
      cursor.click(SL.dragPress);
      cue(SL.dragPress, "click", { gain: 0.6, x: -0.4 });
      cue(SL.dragMove + 0.05, "drag", { gain: 0.6, dur: 0.45, x: -0.4 });
      cue(SL.dragRelease, "drop", { gain: 0.55, x: -0.4 });
    }

    // Save as PDF
    const pdfFace = UI.pdfBtnFace();
    tile.go(SL.toPdf, { rect: pe.box(peUI.pdfBtn), r: 12, fill: "#7c3aed", shadow: 0.6, face: { el: pdfFace, anchor: "c" }, faceIn: 0.1, sp: { w: 12, z: 0.84 } });
    cue(SL.toPdf + 0.2, "whoosh", { gain: 0.3, dur: 0.25, x: 0.5 });
    pe.on((t) => { peUI.pdfBtn.style.visibility = t > SL.toPdf ? "hidden" : ""; });
    moveTo(SL.dragRelease + 0.1, at(pe.box(peUI.pdfBtn), 0.6, 0.62), { w: 7, z: 1 });
    click(SL.pdfClick, 0.5);
    tile.press(SL.pdfClick);
    const ck2 = UI.doneFace("PDF", 15);
    ck2.draw = (t) => ck2._path.setAttribute("stroke-dashoffset", (100 * (1 - smooth((t - SL.check - 0.05) / 0.22))).toFixed(2));
    tile.go(SL.check, { rect: pe.box(peUI.pdfBtn), fill: "#10b981", shadow: 0.3, face: { el: ck2, anchor: "c", sp: SP.pop }, faceIn: 0.04, sp: SP.pop });
    cue(SL.check, "chime", { note: "success", gain: 0.8, x: 0.5 });

    // ---------------------------------------------------------------- VIDEOS
    caption(null, VD.title, VD.titleOut, { raw: V ? [[{ text: "your", cls: "grad-text" }, { text: "videos.", cls: "grad-text" }]] : [[{ text: "your", cls: "grad-text" }], [{ text: "videos.", cls: "grad-text" }]], fs: L.act.fs, x: L.act.x, y: L.act.y, anchor: L.act.anchor, align: L.act.align, lh: 1.0 });
    cue(VD.title, "whoosh", { gain: 0.4, dur: 0.3, x: -0.6 });
    const frame3 = new Frame();
    const md = new Group("media", 0, 0, { z: 10 });
    const mdUI = UI.mediaCard(md.el, V);
    const mdBox = centre(md, mdUI.root, P.x, P.y + (V ? 60 : 0));
    frame3.init(md.box(mdUI.field)(VD.card + 0.5), 16);
    frame3.go(VD.card, mdBox, { w: 13, z: 0.86 }, 24);
    frame3.life(VD.card - 0.02, PR.upgrade + 0.04, { sp: { w: 40, z: 1 }, dy: 0, blur: 0, dOut: 0.16, dsOut: -0.03 });
    md.life(VD.card, PR.upgrade + 0.02, { sp: { w: 40, z: 1 }, dy: 0, blur: 0, dOut: 0.12 });
    const lf = UI.linkFace(mdUI.field.offsetWidth, 58);
    const linkStatic = UI.linkFace(mdUI.field.offsetWidth, 58);
    mdUI.field.appendChild(linkStatic.f);
    linkStatic.f.classList.add("field");
    linkStatic.f.style.border = "2px solid #8b5cf6";
    const platform = (t) => (t < VD.tiktok ? 0 : t < VD.insta ? 1 : 2);
    const linkState = (ui, t) => {
      const p = platform(t);
      ui.ph.style.opacity = t < VD.link ? 0.7 : 0;
      ui.links.forEach((el, i) => {
        const tin = i === 0 ? VD.link : i === 1 ? VD.tiktok : VD.insta;
        const tout = i === 0 ? VD.tiktok : i === 1 ? VD.insta : null;
        applyVis(el, vis(t, tin, tout, { sp: SP.ui, dy: 8, blur: 6, dOut: 0.08 }));
      });
      ui.paste.style.background = t > VD.paste && t < VD.paste + 0.25 ? "#ede9fe" : "";
      void p;
    };
    const linkFace = { el: lf.f, anchor: "c", w: mdUI.field.offsetWidth, h: 58, draw: (t) => linkState(lf, t) };
    md.on((t) => { linkState(linkStatic, t); show(linkStatic.f, t > VD.toMp4 - 0.05); });
    tile.go(VD.field, { rect: md.box(mdUI.field), r: 16, fill: "#ffffff", border: "#8b5cf6", bw: 2, shadow: 0.4, face: linkFace, faceIn: 0.15, sp: { w: 11, z: 0.86 } });
    cue(VD.field + 0.05, "whoosh", { gain: 0.45, dur: 0.35, x: 0 });
    cam.to(VD.field - 0.05, Camera.fit(inflate(mdBox, pad(26)), L.uiAct), { w: 6, z: 1 });
    const pasteBox = (t) => { const r = md.box(mdUI.field)(t); return { x: r.x + r.w - 62, y: r.y + r.h / 2 }; };
    moveTo(VD.field + 0.1, pasteBox, { w: 7, z: 1 });
    click(VD.paste, 0.4);
    cue(VD.link, "paste", { gain: 0.7, x: 0.1 });
    // platform label: X, then TikTok, then Instagram (plain text names)
    const eyebrows = ["X (Twitter)", "TikTok", "Instagram"].map((s) => h("div", "abs", mdUI.eyebrow, { left: 0, top: 0 }, s));
    md.on((t) => {
      eyebrows.forEach((el, i) => {
        const tin = i === 0 ? VD.eyebrow : i === 1 ? VD.tiktok : VD.insta;
        const tout = i === 0 ? VD.tiktok : i === 1 ? VD.insta : null;
        applyVis(el, vis(t, tin, tout, { sp: SP.ui, dy: 8, blur: 6, dOut: 0.08 }));
      });
      applyVis(mdUI.mp4, vis(t, VD.buttons, null, { sp: SP.ui, dy: 14, ds: -0.05 }));
      applyVis(mdUI.mp3, vis(t, VD.buttons + 0.125, null, { sp: SP.ui, dy: 14, ds: -0.05 }));
      applyVis(mdUI.root.firstChild, vis(t, VD.card + 0.05, null, { sp: SP.ui, dy: 10 }));
      if (t > VD.toMp4 - 0.05) show(mdUI.mp4, false);
    });
    [VD.tiktok, VD.insta].forEach((tt) => cue(tt, "tick", { gain: 0.7, x: -0.2 }));
    cue(VD.eyebrow, "tick", { gain: 0.6, x: -0.2 });
    cue(VD.buttons, "pop", { note: 1, gain: 0.5, x: -0.2 });
    cue(VD.buttons + 0.125, "pop", { note: 2, gain: 0.5, x: 0.2 });
    caption(["MP4 or MP3."], VD.caption, VD.captionOut);
    const printLines = V ? [["Only download videos you have permission to use."]] : [["Only download videos you"], ["have permission to use."]];
    {
      const pr = new Caption(printLines.map((l) => l[0].split(" ").map((w) => ({ text: w }))), { size: V ? 27 : 28, tin: VD.print, tout: VD.captionOut, align: L.cap.align, stagger: 0.012, lh: 1.35, sp: SP.text });
      pr.el.classList.add("small-print");
      pr.el.classList.remove("display");
      if (V) pr.place(L.cap.x, L.cap.y + 52, "bc"); else pr.place(L.cap.x + 4, L.cap.y + 80, "tl");
    }
    // MP4
    const mp4F = UI.mp4Face();
    tile.go(VD.toMp4, { rect: md.box(mdUI.mp4), r: 16, fill: "#7c3aed", border: null, bw: 0, shadow: 0.6, face: { el: mp4F, anchor: "c" }, faceIn: 0.12, sp: { w: 13, z: 0.84 }, lead: "b" });
    cue(VD.toMp4 + 0.15, "whoosh", { gain: 0.25, dur: 0.22, x: -0.2 });
    moveTo(VD.toMp4 - 0.1, at(md.box(mdUI.mp4), 0.6, 0.62), { w: 8, z: 1 });
    click(VD.click, -0.2);
    tile.press(VD.click);
    const ck3 = UI.doneFace("MP4", 16);
    ck3.draw = (t) => ck3._path.setAttribute("stroke-dashoffset", (100 * (1 - smooth((t - VD.check - 0.05) / 0.22))).toFixed(2));
    tile.go(VD.check, { rect: md.box(mdUI.mp4), fill: "#10b981", shadow: 0.3, face: { el: ck3, anchor: "c", sp: SP.pop }, faceIn: 0.04, sp: SP.pop });
    cue(VD.check, "chime", { note: "success", gain: 0.8, x: -0.2 });

    // ---------------------------------------------------------------- PRICING (half-time)
    const prG = new Group("pricing", 0, 0, { z: 10 });
    const prRoot = h("div", "abs", prG.el, { left: 0, top: 0 });
    const cardW = V ? 420 : 400, cardH = V ? 400 : 380, gapP = V ? 0 : 28;
    let proUI, freeEl, teamEl, freeUI, teamUI;
    if (!V) {
      prRoot.style.width = cardW * 3 + gapP * 2 + "px";
      prRoot.style.height = cardH + "px";
      freeEl = h("div", "abs card", prRoot, { left: 0, top: 0, width: cardW + "px", height: cardH + "px" });
      freeUI = UI.planCard(freeEl, UI.PLANS[0], V);
      teamEl = h("div", "abs card", prRoot, { left: 2 * (cardW + gapP) + "px", top: 0, width: cardW + "px", height: cardH + "px" });
      teamUI = UI.planCard(teamEl, UI.PLANS[2], V);
    } else {
      prRoot.style.width = cardW + "px";
      prRoot.style.height = cardH + 192 + "px";
      freeEl = h("div", "abs", prRoot, { left: 0, top: 0 });
      freeUI = UI.planPill(freeEl, UI.PLANS[0]);
      teamEl = h("div", "abs", prRoot, { left: 0, top: cardH + 96 + 32 + "px" });
      teamUI = UI.planPill(teamEl, UI.PLANS[2]);
      freeEl.style.left = (cardW - freeUI.root.offsetWidth) / 2 + "px";
      teamEl.style.left = (cardW - teamUI.root.offsetWidth) / 2 + "px";
    }
    const proSlot = h("div", "abs", prRoot, { left: V ? 0 : cardW + gapP + "px", top: V ? "96px" : 0, width: cardW + "px", height: cardH + "px" });
    const prBox = centre(prG, prRoot, P.x, P.y + (V ? 40 : 30));
    const proCopy = h("div", "", null, { width: cardW + "px", height: cardH + "px", position: "relative" });
    proUI = UI.planCard(proCopy, UI.PLANS[1], V);
    proUI.root.style.position = "absolute";
    const ring = h("div", "abs", proCopy, { inset: "0", borderRadius: "24px", padding: "1.5px", WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite: "xor", maskComposite: "exclude" });
    // the price cards' odometers roll up and stop on the real prices
    const roll = (o, v, t0, t1) => (t) => { const k = clamp((t - t0) / (t1 - t0)); const e = 1 - Math.pow(1 - k, 3); o.set(Math.round(e * v)); };
    const rollPro = roll(proUI.odo, 49, PR.roll, PR.rollEnd - 0.1);
    const rollTeam = roll(teamUI.odo, 199, PR.roll + 0.1, PR.rollEnd);
    freeUI.odo.set(0);
    const proFace = { el: proCopy, anchor: "c", w: cardW, h: cardH, sp: SP.uiSoft, draw: (t) => {
      rollPro(t);
      ring.style.background = `conic-gradient(from ${(140 + (t - PR.open) * 40).toFixed(2)}deg, #7c3aed, #e879f9, #fbbf24, #7c3aed)`;
      ring.style.opacity = clamp((t - PR.open - 0.2) / 0.4).toFixed(3);
      if (proUI.popEl) applyVis(proUI.popEl, vis(t, PR.popular, null, { sp: SP.pop, dy: 10, ds: -0.3 }));
      proUI.featEls.forEach((f, i) => applyVis(f, vis(t, PR.feats + i * 0.125, null, { sp: SP.ui, dy: 10 })));
    } };
    if (proUI.popEl) { proUI.popEl.style.zIndex = 3; proCopy.style.overflow = "visible"; }
    const upF = UI.upgradeFace();
    const proCta = (t) => { const r = prG.box(proSlot)(t); return { x: r.x + 32, y: r.y + cardH - 34 - 48, w: cardW - 64, h: 48 }; };
    tile.go(PR.upgrade, { rect: proCta, r: 12, fill: "#7c3aed", border: null, bw: 0, shadow: 0.6, face: { el: upF, anchor: "c" }, faceIn: 0.12, sp: { w: 11, z: 0.86 } });
    cue(PR.upgrade + 0.05, "whoosh", { gain: 0.4, dur: 0.3, x: 0 });
    tile.go(PR.open, { rect: prG.box(proSlot), r: 24, fill: "#ffffff", border: "#e9d5ff", bw: 1, shadow: 0.55, face: proFace, faceIn: 0.1, sp: { w: 10, z: 0.86 }, lead: "t" });
    cue(PR.open + 0.05, "whoosh", { gain: 0.45, dur: 0.4, x: 0 });
    tile.el.style.overflow = "hidden";
    // the "Most popular" pill hangs over the card's top edge: draw it outside the tile's clip
    const popOut = UI.planCard(h("div", "", null), UI.PLANS[1], V).popEl;
    if (popOut) {
      const holder = new Group("popular", 0, 0, { z: 60 });
      holder.el.appendChild(popOut);
      const slotBox = prG.box(proSlot);
      holder.on((t) => {
        const r = slotBox(t);
        popOut.style.left = r.x + 32 - holder.x + "px";
        popOut.style.top = r.y - 15 - holder.y + "px";
        applyVis(popOut, vis(t, PR.popular, EN.collapse - 0.02, { sp: SP.pop, dy: 10, ds: -0.3, dOut: 0.08 }));
      });
      if (proUI.popEl) proUI.popEl.remove();
      cue(PR.popular, "pop", { note: 4, gain: 0.7, x: 0 });
    }
    // Free and Team arrive from behind the Pro card
    const sideIn = (el, dir, tin) => (t) => {
      const v = vis(t, tin, PR.sideOut, { sp: SP.ui, dy: 0, blur: 8, dOut: 0.14 });
      const e = stepR(t - tin, { w: 15, z: 0.86 });
      const off = (1 - e) * (V ? 120 : 220) * dir;
      if (!show(el, v.o > 0.002)) return;
      el.style.opacity = v.o.toFixed(3);
      el.style.filter = v.b > 0.05 ? `blur(${v.b.toFixed(2)}px)` : "";
      el.style.transform = V ? `translateY(${(-off).toFixed(2)}px) scale(${(0.96 + 0.04 * clamp(e)).toFixed(4)})` : `translateX(${(-off).toFixed(2)}px) scale(${(0.96 + 0.04 * clamp(e)).toFixed(4)})`;
    };
    const sideFree = sideIn(freeEl, -1, PR.side), sideTeam = sideIn(teamEl, 1, PR.side + 0.125);
    prG.on((t) => {
      sideFree(t); sideTeam(t); rollTeam(t);
      if (!V) {
        teamUI.featEls.forEach((f, i) => applyVis(f, vis(t, i === 1 ? PR.seats : PR.feats, null, { sp: SP.ui, dy: 10 })));
        freeUI.featEls.forEach((f) => applyVis(f, vis(t, PR.feats, null, { sp: SP.ui, dy: 10 })));
      } else if (teamUI.extra) applyVis(teamUI.extra, vis(t, PR.seats, null, { sp: SP.ui, dy: 8 }));
    });
    show(prG.el, true);
    cue(PR.side, "pop", { note: 0, gain: 0.5, x: V ? 0 : -0.6 });
    cue(PR.side + 0.125, "pop", { note: 2, gain: 0.5, x: V ? 0 : 0.6 });
    cue(PR.seats, "pop", { note: 3, gain: 0.4, x: V ? 0 : 0.6 });
    // odometer ticks only while the digits move
    {
      let lastP = -1, lastT = -1;
      for (let t = PR.roll; t <= PR.rollEnd + 0.01; t += 1 / 240) {
        const kp = clamp((t - PR.roll) / (PR.rollEnd - 0.1 - PR.roll)), ep = Math.round((1 - Math.pow(1 - kp, 3)) * 49);
        const kt = clamp((t - PR.roll - 0.1) / (PR.rollEnd - PR.roll - 0.1)), et = Math.round((1 - Math.pow(1 - kt, 3)) * 199);
        const v = ep * 1000 + et;
        if (v !== lastP && t - lastT > 0.045) { cue(t, "odo", { gain: 0.35, x: 0 }); lastT = t; }
        lastP = v;
      }
    }
    cam.to(PR.upgrade - 0.05, Camera.fit(inflate(prBox, pad(30)), L.price), { w: 4.5, z: 1 });
    caption(["Start free."], PR.caption, PR.captionOut, V ? {} : { x: 960, y: 158, anchor: "cc", align: "center", fs: 92 });
    cue(PR.caption, "whoosh", { gain: 0.3, dur: 0.25, x: 0 });
    const startFreeBtn = V ? freeEl : freeUI.cta;
    moveTo(PR.upgrade + 0.2, (t) => { const r = (V ? prG.box(freeEl) : prG.box(freeUI.cta))(t); return { x: r.x + r.w * 0.62, y: r.y + r.h * 0.6 }; }, { w: 3.2, z: 1 });
    void startFreeBtn;
    moveTo(PR.cursorOut, offscreen(V ? W * 0.75 : W * 0.7, H + 140), { w: 5, z: 1 });

    // ---------------------------------------------------------------- END: the card becomes the logo
    const endHat = hatFace(T0 * 0.52);
    const cone = endHat.svg.querySelector(".cone"), coneLine = endHat.svg.querySelector(".cone-line"), brim = endHat.svg.querySelector(".brim");
    const twEnd = starTwinkle(endHat.svg, EN.twinkle);
    endHat.draw = (t) => {
      const k = smooth((t - EN.hat) / 0.32);
      coneLine.setAttribute("opacity", t < EN.hat + 0.5 ? (k < 1 ? 1 : 1 - smooth((t - EN.hat - 0.32) / 0.16)).toFixed(3) : "0");
      coneLine.setAttribute("stroke-dashoffset", (100 * (1 - k)).toFixed(2));
      cone.setAttribute("opacity", smooth((t - EN.hat - 0.18) / 0.22).toFixed(3));
      brim.setAttribute("opacity", (0.35 * smooth((t - EN.hat - 0.24) / 0.2)).toFixed(3));
      const st = stepR(t - (EN.hat + 0.32), { w: 22, z: 0.7 });
      const g = endHat.svg.querySelector(".star");
      if (t < EN.twinkle) g.setAttribute("transform", `translate(12 9.6) scale(${clamp(st, 0, 2).toFixed(4)}) translate(-12 -9.6)`);
      else twEnd(t);
    };
    tile.go(EN.collapse, { rect: tileHome, r: T0 * 0.25, fill: "#7c3aed", border: null, bw: 0, shadow: 0.85, face: { ...endHat, anchor: "c", blur: 0, ds: 0, dy: 0 }, faceIn: 0.06, sp: { w: 10, z: 0.88 } });
    tile.sheen(EN.twinkle - 0.05, 0.75);
    cam.to(EN.collapse, cam0, { w: 5.5, z: 1 });
    cue(EN.collapse, "impact", { gain: 1, x: 0 });
    cue(EN.twinkle, "chime", { note: "star", gain: 0.9, x: V ? 0 : -0.3 });
    cue(EN.word, "whoosh", { gain: 0.35, dur: 0.3, x: 0.2 });
    cue(EN.underline, "shimmer", { gain: 0.4, dur: 0.5, x: 0 });

    // beat life after the drop: a slight push on each bar (never in-and-out)
    for (let b = 12; b < 30; b += 2) cam.punch(b, 0.012, 0.6);

    FILM.layout = { P, tileHome, chBox, brBox, cpBox, dnBox, edBox, aiBox, ppBox, peBox, mdBox, prBox };
  });
})();
