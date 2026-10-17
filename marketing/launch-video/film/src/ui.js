/*
 * ui.js: the app's screens rebuilt in HTML/CSS from the screenshots and the
 * repo's own tokens (app/globals.css, Tailwind classes in components/), so they
 * stay sharp under the camera and can morph. Icons are Lucide (see icons.js).
 */
(function () {
  "use strict";

  const px = (n) => n + "px";

  /** Icon square: tinted rounded square holding a Lucide icon. */
  function ico(parent, name, tint, size = 44, isz = 20, radius = 12) {
    const b = h("div", "ico " + tint, parent, { width: px(size), height: px(size), borderRadius: px(radius) });
    icon(name, isz, 2, b);
    return b;
  }

  /** The PDF Wizard hat (components/WizardLogo.tsx), drawn in white with the yellow star. */
  function hat(size, parent) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("class", "svg");
    s.innerHTML =
      '<path class="brim" d="M3 19.5c0-1 4-2 9-2s9 1 9 2-4 2-9 2-9-1-9-2Z" fill="#fff" opacity="0.35"/>' +
      '<path class="cone" d="M12 2.2c.5 0 .8.3 1 .8l5.4 14.4c.2.5-.2 1-.8 1.1-1.4.3-3.4.5-5.6.5s-4.2-.2-5.6-.5c-.6-.1-1-.6-.8-1.1L11 3c.2-.5.5-.8 1-.8Z" fill="#fff"/>' +
      '<path class="cone-line" d="M12 2.2c.5 0 .8.3 1 .8l5.4 14.4c.2.5-.2 1-.8 1.1-1.4.3-3.4.5-5.6.5s-4.2-.2-5.6-.5c-.6-.1-1-.6-.8-1.1L11 3c.2-.5.5-.8 1-.8Z" fill="none" stroke="#fff" stroke-width="0.9" stroke-linejoin="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0" opacity="0"/>' +
      '<g class="star"><path d="M12 7.4l.7 1.6 1.7.2-1.3 1.2.4 1.7-1.5-.9-1.5.9.4-1.7-1.3-1.2 1.7-.2.7-1.6Z" fill="#fde047"/></g>';
    if (parent) parent.appendChild(s);
    return s;
  }

  // ------------------------------------------------------------------ chooser
  const CHOICES = [
    { id: "pdf", label: "PDF", icon: "file-text", tint: "t-violet" },
    { id: "pptx", label: "PowerPoint", icon: "presentation", tint: "t-orange" },
    { id: "slides", label: "Google Slides", icon: "gallery-horizontal-end", tint: "t-amber" },
    { id: "media", label: "Video & audio", icon: "clapperboard", tint: "t-rose" },
  ];

  function optFace(c, w, hgt, fs = 14, isz = 44) {
    const f = h("div", "col", null, { width: px(w), height: px(hgt), justifyContent: "center", gap: "10px", fontSize: px(fs), fontWeight: 600 });
    ico(f, c.icon, c.tint, isz, Math.round(isz * 0.45), Math.round(isz * 0.27));
    h("div", "", f, null, c.label);
    return f;
  }

  /** "What are you working on?" contents (no frame: the frame morphs separately). */
  function chooser(parent, mobile) {
    const W0 = mobile ? 400 : 660;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), padding: mobile ? "18px 16px 16px" : "18px 16px 16px" });
    const title = h("p", "", root, { fontSize: px(mobile ? 15 : 14), fontWeight: 600, padding: "4px 4px 12px" }, "What are you working on?");
    const grid = h("div", "", root, { display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: "8px" });
    const opts = {};
    for (const c of CHOICES) {
      const o = h("div", "opt col", grid, { height: px(mobile ? 104 : 107) });
      ico(o, c.icon, c.tint, 44, 20, 12);
      h("div", "", o, null, c.label);
      opts[c.id] = o;
    }
    const drop = h("p", "row muted", root, { justifyContent: "center", gap: "6px", fontSize: "12px", paddingTop: "12px" });
    icon("cloud-upload", 14, 2, drop);
    h("span", "", drop, null, "or drop a file");
    return { root, title, grid, opts, drop, w: W0 };
  }

  // ------------------------------------------------------------------ PDF branch
  const PDF_TOOLS = [
    { id: "edit", label: "Edit PDF", icon: "pen-line", tint: "t-teal" },
    { id: "sign", label: "Fill & Sign", icon: "signature", tint: "t-cyan" },
    { id: "compress", label: "Compress PDF", icon: "minimize-2", tint: "t-emerald" },
    { id: "word", label: "PDF to Word", icon: "file-text", tint: "t-blue" },
    { id: "pptx", label: "PDF to PPTX", icon: "file-sliders", tint: "t-orange8" },
    { id: "ai", label: "AI Assistant", icon: "messages-square", tint: "t-ai" },
    { id: "ocr", label: "OCR PDF", icon: "scan-text", tint: "t-indigo" },
    { id: "split", label: "Split PDF", icon: "scissors", tint: "t-fuchsia" },
    { id: "protect", label: "Protect PDF", icon: "lock", tint: "t-red" },
  ];

  function branchHeader(parent, label, iconName, tint) {
    const hd = h("div", "row", parent, { gap: "12px", padding: "2px 2px 14px" });
    ico(hd, iconName, tint, 40, 20, 12);
    h("div", "", hd, { fontSize: "16px", fontWeight: 600, flex: "1" }, label);
    const ch = h("div", "row muted", hd, { gap: "6px", fontSize: "14px", fontWeight: 500, paddingRight: "8px" });
    icon("arrow-left", 16, 2, ch);
    h("span", "", ch, null, "Change");
    return hd;
  }

  function fileChipFace(name, iconName, w, hgt = 52) {
    const f = h("div", "filechip row", null, { width: px(w), height: px(hgt) });
    h("span", "", f, { color: "#7c3aed", display: "flex" }).appendChild(icon(iconName, 18, 2));
    h("span", "", f, { fontWeight: 600, flex: "1" }, name);
    h("span", "muted", f, { display: "flex" }).appendChild(icon("x", 16, 2));
    f.style.background = "transparent";
    return f;
  }

  function toolFace(tl, w, hgt, mobile) {
    const f = h("div", "tool col", null, { width: px(w), height: px(hgt), border: "none", background: "transparent", fontSize: px(mobile ? 12 : 12.5) });
    ico(f, tl.icon, tl.tint, 32, 16, 9);
    h("div", "", f, null, tl.label);
    return f;
  }

  function pdfBranch(parent, mobile) {
    const W0 = mobile ? 400 : 660;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), padding: "16px" });
    const header = branchHeader(root, "PDF", "file-text", "t-violet");
    const chip = h("div", "filechip row", root, { height: "52px" });
    h("span", "", chip, { color: "#7c3aed", display: "flex" }).appendChild(icon("file-text", 18, 2));
    h("span", "", chip, { fontWeight: 600, flex: "1" }, "proposal.pdf");
    h("span", "muted", chip, { display: "flex" }).appendChild(icon("x", 16, 2));
    const grid = h("div", "", root, { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginTop: "12px" });
    const tools = {};
    for (const tl of PDF_TOOLS) {
      const c = h("div", "tool col", grid, { height: px(mobile ? 96 : 83) });
      ico(c, tl.icon, tl.tint, 32, 16, 9);
      h("div", "", c, null, tl.label);
      tools[tl.id] = c;
    }
    return { root, header, chip, grid, tools, w: W0 };
  }

  // ------------------------------------------------------------------ Compress
  function compressPanel(parent, mobile) {
    const W0 = mobile ? 400 : 560;
    const root = h("div", "abs col", parent, { left: 0, top: 0, width: px(W0), padding: "30px 24px 30px" });
    const ic = ico(root, "minimize-2", "t-emerald", 60, 28, 16);
    ic.style.boxShadow = "0 10px 20px -8px rgba(16, 185, 129, 0.35)";
    h("div", "", root, { fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginTop: "16px" }, "Compress PDF");
    h("div", "muted", root, { fontSize: "16px", marginTop: "6px" }, "Make a PDF smaller.");
    const chip = h("div", "row", root, { width: "100%", height: "60px", marginTop: "24px", gap: "12px", padding: "0 16px", border: "1px solid var(--line)", borderRadius: "12px", fontSize: "15px" });
    h("span", "", chip, { color: "#7c3aed", display: "flex" }).appendChild(icon("file", 20, 2));
    h("span", "", chip, { fontWeight: 600, flex: "1" }, "proposal.pdf");
    h("span", "muted", chip, { display: "flex" }).appendChild(icon("x", 16, 2));
    const btn = h("div", "", root, { width: "208px", height: "52px", marginTop: "24px" });
    const bar = h("div", "", root, { width: px(mobile ? 320 : 400), height: "10px", marginTop: "-31px" });
    const casting = h("div", "row muted", root, { gap: "6px", fontSize: "15px", marginTop: "14px", height: "20px" });
    h("span", "", casting, { color: "#8b5cf6", display: "flex" }).appendChild(icon("sparkles", 15, 2));
    h("span", "", casting, null, "Casting...");
    return { root, chip, btn, bar, casting, w: W0 };
  }

  function castFace() {
    const f = h("div", "btn", null, { color: "#fff", fontSize: "17px", gap: "9px" });
    icon("sparkles", 18, 2, f);
    h("span", "", f, null, "Cast spell");
    return f;
  }

  // ------------------------------------------------------------------ Done
  const NEXT = [
    { id: "edit", label: "Edit PDF", icon: "pen-line", tint: "t-teal" },
    { id: "protect", label: "Protect PDF", icon: "lock", tint: "t-red" },
    { id: "sign", label: "Fill & Sign", icon: "signature", tint: "t-cyan" },
    { id: "word", label: "PDF to Word", icon: "file-text", tint: "t-blue" },
  ];

  function pillFace(n) {
    const f = h("div", "pill", null, { border: "none", background: "transparent" });
    ico(f, n.icon, n.tint, 28, 14, 999);
    h("span", "", f, null, n.label);
    return f;
  }

  function donePanel(parent, mobile) {
    const W0 = mobile ? 400 : 640;
    const root = h("div", "abs col", parent, { left: 0, top: 0, width: px(W0), padding: "36px 24px 34px" });
    const glow = h("div", "abs", root, { left: 0, top: 0, right: 0, height: "190px", borderRadius: "24px 24px 0 0", background: "linear-gradient(180deg, rgba(16, 185, 129, 0.13), rgba(16, 185, 129, 0))" });
    const check = h("div", "", root, { width: "68px", height: "68px", position: "relative" });
    const title = h("div", "", root, { fontSize: "26px", fontWeight: 700, letterSpacing: "-0.01em", marginTop: "20px", position: "relative" }, "Spell complete");
    // the result line (ToolWorkbench): output size and the saving, measured by running the
    // app's Compress PDF on the demo proposal.pdf (2.0 MB, two photos). The timer chip is left out.
    const stats = h("div", "row", root, { gap: "8px", marginTop: "14px", position: "relative", justifyContent: "center" });
    const fileStat = h("span", "stat", stats, null, "1 file · 120.8 KB");
    const smaller = h("span", "stat good", stats);
    icon("trending-down", 15, 2.2, smaller);
    h("span", "", smaller, null, "94% smaller");
    const btns = h("div", "row", root, { gap: "12px", marginTop: "24px", position: "relative" });
    const dl = h("div", "btn primary", btns, { width: "176px", height: "48px", fontSize: "17px" });
    icon("download", 18, 2, dl); h("span", "", dl, null, "Download");
    const so = h("div", "btn outline", btns, { width: "148px", height: "48px", fontSize: "17px" });
    icon("rotate-ccw", 17, 2, so); h("span", "", so, null, "Start over");
    const nextLbl = h("div", "eyebrow", root, { marginTop: "28px", position: "relative" }, "Next");
    const row = h("div", "", root, { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px", marginTop: "14px", position: "relative", width: mobile ? "330px" : "auto" });
    const chips = {};
    for (const n of NEXT) {
      const c = h("div", "pill", row);
      ico(c, n.icon, n.tint, 28, 14, 999);
      h("span", "", c, null, n.label);
      chips[n.id] = c;
    }
    return { root, glow, check, title, stats, fileStat, smaller, btns, dl, so, nextLbl, row, chips, w: W0 };
  }

  function checkFace(size = 68, sw = 3) {
    const f = h("div", "", null, { width: px(size), height: px(size), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" });
    const s = icon("check", Math.round(size * 0.47), sw, f);
    const p = s.querySelector("path, polyline");
    p.setAttribute("pathLength", "100");
    p.setAttribute("stroke-dasharray", "100");
    f._path = p;
    return f;
  }

  /** A button in its done state: a check that draws itself, then the label. */
  function doneFace(label, fs) {
    const f = h("div", "btn", null, { color: "#fff", fontSize: px(fs), gap: "8px" });
    const s = icon("check", fs + 3, 2.6, f);
    const p = s.querySelector("path, polyline");
    p.setAttribute("pathLength", "100");
    p.setAttribute("stroke-dasharray", "100");
    f._path = p;
    h("span", "", f, null, label);
    return f;
  }

  // ------------------------------------------------------------------ PDF editor
  const EDIT_TOOLS = [
    ["mouse-pointer-2"], ["type", "sticky-note"], ["highlighter", "underline", "strikethrough"], ["pen", "eraser"],
    ["square", "circle", "minus", "arrow-up-right"], ["image", "signature", "link-2"], ["text-cursor-input", "square-check", "circle-dot"],
  ];

  /** The document page: violet header band, grey line blocks for the body (no placeholder text). */
  function page(parent, w, opts = {}) {
    const k = w / 520;
    const pg = h("div", "abs", parent, { left: 0, top: 0, width: px(w), height: px(Math.round(w * 1.294)), background: "#fff", borderRadius: px(4 * k), boxShadow: "0 12px 30px -10px rgba(46, 16, 101, 0.22), 0 0 0 1px rgba(46, 16, 101, 0.06)", overflow: "hidden" });
    const band = h("div", "", pg, { height: px(62 * k), background: "#7c3aed", color: "#fff", fontSize: px(26 * k), fontWeight: 700, display: "flex", alignItems: "center", paddingLeft: px(44 * k) }, "Project Proposal");
    h("div", "", pg, { fontSize: px(19 * k), fontWeight: 700, margin: `${px(30 * k)} ${px(44 * k)} ${px(14 * k)}` }, "Section 1");
    const ln = h("div", "lines", pg, { margin: `0 ${px(44 * k)}`, gap: px(11 * k) });
    const widths = [0.92, 0.84, 0.97, 0.88, 0.62];
    for (const wd of widths) h("i", "", ln, { width: `${wd * 100}%`, height: px(8 * k) });
    const fieldRow = h("div", "row", pg, { margin: `${px(30 * k)} ${px(44 * k)} 0`, gap: px(12 * k) });
    h("div", "", fieldRow, { fontSize: px(15 * k), fontWeight: 600, width: px(70 * k) }, "Status");
    const field = h("div", "", fieldRow, { flex: "1", height: px(40 * k), border: `${Math.max(1, 1.5 * k)}px solid #c4b5fd`, background: "#f5f3ff", borderRadius: px(6 * k), position: "relative" });
    const ln2 = h("div", "lines", pg, { margin: `${px(30 * k)} ${px(44 * k)} 0`, gap: px(11 * k) });
    for (const wd of [0.9, 0.76]) h("i", "", ln2, { width: `${wd * 100}%`, height: px(8 * k) });
    const sigRow = h("div", "", pg, { margin: `${px(26 * k)} ${px(44 * k)} 0`, width: px(250 * k), position: "relative" });
    const sigArea = h("div", "", sigRow, { height: px(66 * k), position: "relative" });
    h("div", "", sigRow, { height: px(1.5 * k), background: "#94a3b8" });
    h("div", "muted", sigRow, { fontSize: px(12.5 * k), marginTop: px(6 * k), fontWeight: 500 }, "Signature");
    return { pg, band, field, sigArea, k };
  }

  function editor(parent, mobile) {
    if (mobile) return editorMobile(parent);
    const W0 = 940, H0 = 690;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), height: px(H0), borderRadius: "18px", overflow: "hidden", background: "#fff" });
    const top = h("div", "row", root, { height: "56px", padding: "0 12px 0 16px", gap: "14px", borderBottom: "1px solid var(--line)" });
    h("span", "", top, { display: "flex" }).appendChild(icon("arrow-left", 19, 2));
    h("span", "", top, { display: "flex" }).appendChild(icon("panel-left", 19, 2));
    h("div", "", top, { fontSize: "17px", fontWeight: 600 }, "proposal");
    h("span", "badge", top, { background: "#e0f2fe", color: "#075985", fontSize: "11.5px", padding: "3px 9px" }, "On this device");
    h("div", "", top, { flex: "1" });
    h("span", "muted", top, { display: "flex", opacity: 0.6 }).appendChild(icon("undo-2", 18, 2));
    h("span", "muted", top, { display: "flex", opacity: 0.6 }).appendChild(icon("redo-2", 18, 2));
    const merge = h("div", "row", top, { gap: "7px", fontSize: "15px", fontWeight: 500, padding: "0 6px" });
    icon("file-plus-2", 17, 2, merge); h("span", "", merge, null, "Merge");
    const dl = h("div", "btn outline", top, { height: "40px", padding: "0 14px", fontSize: "15px", fontWeight: 500 });
    icon("download", 17, 2, dl); h("span", "", dl, null, "Download");
    const save = h("div", "btn primary", top, { height: "40px", width: "92px", fontSize: "15px" });
    icon("save", 17, 2, save); h("span", "", save, null, "Save");
    const bar = h("div", "row", root, { height: "50px", padding: "0 12px", gap: "4px", borderBottom: "1px solid var(--line)" });
    const tools = {};
    EDIT_TOOLS.forEach((grp, gi) => {
      if (gi) h("div", "", bar, { width: "1px", height: "22px", background: "var(--line)", margin: "0 6px" });
      for (const n of grp) {
        const b = h("div", "ico", bar, { width: "34px", height: "34px", borderRadius: "9px", color: "#334155" });
        icon(n, 18, 2, b);
        tools[n] = b;
      }
    });
    const canvas = h("div", "abs", root, { left: 0, top: "106px", right: 0, bottom: 0, background: "#f6f4fa" });
    const pw = 540;
    const pgWrap = h("div", "abs", canvas, { left: px((W0 - pw) / 2), top: "24px", width: px(pw) });
    const pgi = page(pgWrap, pw);
    pgWrap.style.height = pgi.pg.style.height;
    return { root, top, save, tools, canvas, pgWrap, page: pgi, w: W0, h: H0 };
  }

  function editorMobile(parent) {
    const W0 = 420, pw = 420;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0) });
    const top = h("div", "row", root, { height: "52px", gap: "10px", padding: "0 4px" });
    h("div", "", top, { fontSize: "17px", fontWeight: 600 }, "proposal");
    h("span", "badge", top, { background: "#e0f2fe", color: "#075985", fontSize: "11.5px", padding: "3px 9px" }, "On this device");
    h("div", "", top, { flex: "1" });
    const save = h("div", "btn primary", top, { height: "40px", width: "92px", fontSize: "15px" });
    icon("save", 17, 2, save); h("span", "", save, null, "Save");
    const pgWrap = h("div", "", root, { position: "relative", width: px(pw), marginTop: "10px" });
    const pgi = page(pgWrap, pw);
    pgi.pg.style.position = "relative";
    const bar = h("div", "row", root, { position: "absolute", left: "50%", bottom: "26px", transform: "translateX(-50%)", height: "52px", padding: "0 8px", gap: "4px", background: "#fff", borderRadius: "999px", boxShadow: "0 14px 30px -10px rgba(46, 16, 101, 0.3), 0 0 0 1px rgba(46, 16, 101, 0.06)" });
    const tools = {};
    for (const n of ["mouse-pointer-2", "type", "highlighter", "pen", "signature", "text-cursor-input"]) {
      const b = h("div", "ico", bar, { width: "38px", height: "38px", borderRadius: "999px", color: "#334155" });
      icon(n, 19, 2, b);
      tools[n] = b;
    }
    // centre the floating bar by its measured width, not a transform (tool boxes are read from offsets)
    if (bar.offsetWidth) { bar.style.transform = ""; bar.style.left = px((W0 - bar.offsetWidth) / 2); }
    return { root, top, save, tools, pgWrap, page: pgi, bar, w: W0 };
  }

  function toolFaceIcon(name, size = 18) {
    const f = h("div", "", null, { color: "#fff", display: "flex" });
    icon(name, size, 2, f);
    return f;
  }

  function saveFace() {
    const f = h("div", "btn", null, { color: "#fff", fontSize: "15px", gap: "8px" });
    icon("save", 17, 2, f); h("span", "", f, null, "Save");
    return f;
  }

  // ------------------------------------------------------------------ Ask your PDF
  /**
   * The answer the film streams for the made-up demo proposal. The app cites pages inline,
   * "(p. 2)", as its chat instructions ask for.
   */
  const AI_ANSWER = "A plan to rebuild the company website, covering the scope, timeline and budget (p. 2).";

  function aiPanel(parent, mobile) {
    const W0 = mobile ? 420 : 600, H0 = mobile ? 470 : 470;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), height: px(H0), borderRadius: "24px", overflow: "hidden" });
    const hd = h("div", "row", root, { height: "62px", gap: "12px", padding: "0 20px", background: "rgba(244, 242, 248, 0.6)", borderBottom: "1px solid var(--line)" });
    h("span", "", hd, { color: "#7c3aed", display: "flex" }).appendChild(icon("file-text", 20, 2));
    h("div", "", hd, { fontSize: "15px", fontWeight: 600, flex: "1" }, "proposal.pdf");
    const np = h("div", "row", hd, { gap: "7px", fontSize: "14px", fontWeight: 500 });
    icon("rotate-ccw", 15, 2, np); h("span", "", np, null, "New PDF");
    const body = h("div", "abs col", root, { left: 0, right: 0, top: "62px", bottom: "68px", justifyContent: "center", padding: "0 20px" });
    const empty = h("div", "col", body, { gap: "0" });
    h("div", "", empty, { fontSize: "18px", fontWeight: 700 }, "What would you like to know?");
    const cite = h("div", "muted", empty, { fontSize: "15px", marginTop: "6px" }, "Answers cite the pages they come from.");
    const chipsRow = h("div", "", empty, { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px", marginTop: "20px" });
    const chips = {};
    for (const s of ["Summarize", "Key numbers and dates", "Action items"]) {
      chips[s] = h("div", "", chipsRow, { border: "1px solid var(--line)", borderRadius: "999px", padding: "7px 15px", fontSize: "14.5px", background: "#fff" }, s);
    }
    const thread = h("div", "abs", root, { left: "20px", right: "20px", top: "86px" });
    const bubble = h("div", "", thread, { marginLeft: "auto", width: "max-content", background: "#7c3aed", color: "#fff", borderRadius: "16px 16px 6px 16px", padding: "10px 16px", fontSize: "15px" }, "Summarize");
    // the reply bubble: thinking dots, then the answer streams in and the bubble grows to fit
    const think = h("div", "", thread, { marginTop: "14px", position: "relative", background: "var(--wash)", borderRadius: "16px 16px 16px 6px", overflow: "hidden" });
    const dotRow = h("div", "row abs", think, { left: "16px", top: "15px", gap: "6px" });
    const dots = [0, 1, 2].map(() => h("span", "", dotRow, { width: "8px", height: "8px", borderRadius: "50%", background: "rgba(124, 58, 237, 0.6)", display: "block" }));
    const ansMax = Math.round((W0 - 40) * 0.85) - 32;
    const ans = h("div", "abs", think, { left: "16px", top: "10px", width: px(ansMax), fontSize: "15px", lineHeight: "24px", whiteSpace: "normal", color: "var(--ink)" });
    const words = AI_ANSWER.split(" ").map((w, i) => { if (i) ans.appendChild(document.createTextNode(" ")); return h("span", "", ans, null, w); });
    const form = h("div", "abs row", root, { left: 0, right: 0, bottom: 0, height: "68px", gap: "8px", padding: "0 12px", borderTop: "1px solid var(--line)" });
    h("div", "muted", form, { flex: "1", height: "44px", border: "1px solid var(--line)", borderRadius: "12px", display: "flex", alignItems: "center", padding: "0 14px", fontSize: "14.5px", opacity: 0.85 }, "Ask anything about this PDF…");
    const send = h("div", "ico", form, { width: "44px", height: "44px", borderRadius: "12px", background: "#c4b5fd", color: "#fff" });
    icon("arrow-up", 18, 2, send);
    /** Sizes of the reply bubble: thinking (dots) and with the whole answer (measured once laid out). */
    const sizes = () => {
      if (!think._m && ans.offsetWidth) {
        let w = 0;
        const r0 = ans.getBoundingClientRect();
        for (const s of words) { const r = s.getBoundingClientRect(); w = Math.max(w, r.right - r0.left); }
        const k = r0.width / ans.offsetWidth || 1;
        think._m = { w0: 16 + 3 * 8 + 2 * 6 + 16, h0: 38, w1: Math.ceil(w / k) + 32 + 2, h1: ans.offsetHeight + 20 };
      }
      return think._m;
    };
    return { root, empty, cite, chips, thread, bubble, think, dots, dotRow, ans, words, sizes, w: W0, h: H0 };
  }

  // ------------------------------------------------------------------ PowerPoint branch
  function pptxCard(parent, mobile) {
    const W0 = mobile ? 400 : 660;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), padding: "16px" });
    branchHeader(root, "PowerPoint", "presentation", "t-orange");
    const chip = h("div", "filechip row", root, { height: "52px" });
    h("span", "", chip, { color: "#7c3aed", display: "flex" }).appendChild(icon("presentation", 18, 2));
    h("span", "", chip, { fontWeight: 600, flex: "1" }, "q4-plan.pptx");
    h("span", "muted", chip, { display: "flex" }).appendChild(icon("x", 16, 2));
    const row = h("div", "", root, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "12px" });
    const toPdf = h("div", "opt col", row, { height: "96px", gap: "10px" });
    ico(toPdf, "presentation", "t-orange", 36, 18, 10); h("div", "", toPdf, null, "PPTX to PDF");
    const edit = h("div", "opt col", row, { height: "96px", gap: "10px" });
    ico(edit, "pencil-ruler", "t-rose", 36, 18, 10); h("div", "", edit, null, "Edit PPTX");
    return { root, chip, toPdf, edit, w: W0 };
  }

  function editPptxFace(w, hgt) {
    const f = h("div", "col", null, { width: px(w), height: px(hgt), justifyContent: "center", gap: "10px", fontSize: "14px", fontWeight: 600 });
    ico(f, "pencil-ruler", "t-rose", 36, 18, 10);
    h("div", "", f, null, "Edit PPTX");
    return f;
  }

  // ------------------------------------------------------------------ Edit PPTX
  // "What we ship" starts out of place, so dragging it up puts the deck in order
  const SLIDES = [
    { title: "Q4 Plan", lines: [0.66, 0.52, 0.6, 0.38] },
    { title: "Thank you", lines: [0.45] },
    { title: "What we ship", lines: [0.7, 0.55, 0.6] },
  ];

  function slideBody(parent, s, k, titleText) {
    const band = h("div", "", parent, { height: px(70 * k), background: "#7c3aed", color: "#fff", fontWeight: 700, fontSize: px(34 * k), letterSpacing: "-0.01em", display: "flex", alignItems: "center", paddingLeft: px(44 * k), whiteSpace: "nowrap" }, titleText ?? s.title);
    const ln = h("div", "lines", parent, { margin: `${px(46 * k)} ${px(44 * k)} 0`, gap: px(16 * k) });
    for (const wd of s.lines) h("i", "", ln, { width: `${wd * 100}%`, height: px(13 * k), borderRadius: px(7 * k) });
    return band;
  }

  function pptxEditor(parent, mobile) {
    if (mobile) return pptxEditorMobile(parent);
    const W0 = 960, H0 = 600;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), height: px(H0) });
    const top = h("div", "row card", root, { height: "58px", gap: "12px", padding: "0 10px 0 16px", borderRadius: "16px", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" });
    h("span", "", top, { color: "#7c3aed", display: "flex" }).appendChild(icon("presentation", 20, 2));
    h("div", "", top, { fontSize: "16px", fontWeight: 600, flex: "1" }, "q4-plan.pptx");
    h("span", "muted", top, { display: "flex", opacity: 0.6 }).appendChild(icon("undo-2", 18, 2));
    h("span", "muted", top, { display: "flex", opacity: 0.6 }).appendChild(icon("redo-2", 18, 2));
    h("div", "", top, { width: "1px", height: "24px", background: "var(--line)" });
    const pptxBtn = h("div", "btn outline", top, { height: "40px", padding: "0 14px", fontSize: "15px" });
    icon("download", 17, 2, pptxBtn); h("span", "", pptxBtn, null, "PPTX");
    const pdfBtn = h("div", "btn primary", top, { height: "40px", width: "82px", fontSize: "15px" });
    icon("file-down", 17, 2, pdfBtn); h("span", "", pdfBtn, null, "PDF");
    h("span", "", top, { display: "flex", padding: "0 6px" }).appendChild(icon("x", 18, 2));
    const side = h("div", "abs card", root, { left: 0, top: "76px", width: "172px", height: px(H0 - 76), borderRadius: "16px", background: "#fbfaff" });
    const thumbs = SLIDES.map((s, i) => {
      const th = h("div", "abs thumb", side, { left: "12px", top: px(12 + i * 100), width: "146px", height: "84px" });
      const body = h("div", "", th, { width: "520px", transform: `scale(${146 / 520})`, transformOrigin: "0 0" });
      const band = slideBody(body, s, 1);
      const badge = h("div", "abs", th, { left: "6px", bottom: "6px", width: "20px", height: "20px", borderRadius: "50%", background: i === 0 ? "#7c3aed" : "#64748b", color: "#fff", fontSize: "11px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }, String(i + 1));
      return { th, band, badge, i };
    });
    const main = h("div", "abs card", root, { left: "190px", top: "76px", width: px(W0 - 190), height: px(H0 - 76), borderRadius: "16px", overflow: "hidden" });
    const slide = h("div", "abs", main, { left: 0, top: 0, right: 0, bottom: 0 });
    const k = (W0 - 190) / 520 * 0.62;
    const band = slideBody(slide, SLIDES[0], k);
    return { root, top, pdfBtn, side, thumbs, main, band, k, w: W0, h: H0 };
  }

  const PITCH_V = 140;
  function pptxEditorMobile(parent) {
    const W0 = 420;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0) });
    const top = h("div", "row card", root, { height: "56px", gap: "10px", padding: "0 8px 0 14px", borderRadius: "16px" });
    h("span", "", top, { color: "#7c3aed", display: "flex" }).appendChild(icon("presentation", 19, 2));
    h("div", "", top, { fontSize: "16px", fontWeight: 600, flex: "1" }, "q4-plan.pptx");
    const pdfBtn = h("div", "btn primary", top, { height: "40px", width: "82px", fontSize: "15px" });
    icon("file-down", 17, 2, pdfBtn); h("span", "", pdfBtn, null, "PDF");
    // compact slide cards, so the whole list stays in frame while one is dragged
    const stack = h("div", "", root, { position: "relative", height: px(2 * PITCH_V + 128), marginTop: "14px" });
    const k = 420 / 520 * 0.8;
    const thumbs = SLIDES.map((s, i) => {
      const th = h("div", "abs thumb", stack, { left: 0, top: px(i * PITCH_V), width: "420px", height: "128px", borderRadius: "14px", boxShadow: "0 8px 20px -10px rgba(46,16,101,0.18)" });
      const band = slideBody(th, s, k);
      const badge = h("div", "abs", th, { left: "10px", bottom: "10px", width: "24px", height: "24px", borderRadius: "50%", background: i === 0 ? "#7c3aed" : "#64748b", color: "#fff", fontSize: "12px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }, String(i + 1));
      return { th, band, badge, i };
    });
    return { root, top, pdfBtn, thumbs, band: thumbs[0].band, k, stack, pitch: PITCH_V, w: W0 };
  }

  function bandFace(k, w, hgt) {
    const f = h("div", "", null, { width: px(w), height: px(hgt), color: "#fff", fontWeight: 700, fontSize: px(34 * k), letterSpacing: "-0.01em", display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: px(44 * k) });
    const q = h("span", "", f, null, "Q");
    const digit = h("span", "", f, { position: "relative", display: "inline-block" });
    const sel = h("span", "abs", digit, { left: "-2px", right: "-2px", top: "8%", bottom: "4%", background: "rgba(255,255,255,0.32)", borderRadius: "3px" });
    const d4 = h("span", "", digit, { position: "relative" }, "4");
    const d1 = h("span", "abs", digit, { left: 0, top: 0 }, "1");
    h("span", "", f, null, " Plan");
    const caret = h("span", "abs", digit, { right: px(-3 * k), top: "10%", bottom: "6%", width: px(Math.max(2, 3 * k)), background: "#fff", borderRadius: "1px" });
    return { f, sel, d4, d1, caret, q };
  }

  function pdfBtnFace() {
    const f = h("div", "btn", null, { color: "#fff", fontSize: "15px", gap: "8px" });
    icon("file-down", 17, 2, f); h("span", "", f, null, "PDF");
    return f;
  }

  // ------------------------------------------------------------------ Video & audio
  function mediaCard(parent, mobile) {
    const W0 = mobile ? 420 : 660;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), padding: "16px" });
    branchHeader(root, "Video & audio", "clapperboard", "t-rose");
    const field = h("div", "", root, { height: "58px" });
    const eyebrow = h("div", "eyebrow", root, { margin: "14px 4px 10px", height: "16px", position: "relative" });
    const btns = h("div", "", root, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" });
    const mp4 = h("div", "btn outline", btns, { height: "58px", borderRadius: "16px", fontSize: "16px" });
    icon("film", 18, 2, mp4); h("span", "", mp4, null, "MP4");
    const mp3 = h("div", "btn outline", btns, { height: "58px", borderRadius: "16px", fontSize: "16px" });
    icon("music-2", 18, 2, mp3); h("span", "", mp3, null, "MP3");
    return { root, field, eyebrow, btns, mp4, mp3, w: W0 };
  }

  function linkFace(w, hgt) {
    const f = h("div", "row", null, { width: px(w), height: px(hgt), padding: "0 7px 0 16px", gap: "10px", fontSize: "15.5px", justifyContent: "flex-start" });
    h("span", "muted", f, { display: "flex" }).appendChild(icon("link-2", 17, 2));
    const txt = h("div", "", f, { flex: "1", position: "relative", height: "22px", overflow: "hidden", WebkitMaskImage: "linear-gradient(90deg, #000 82%, transparent)", maskImage: "linear-gradient(90deg, #000 82%, transparent)" });
    const ph = h("div", "abs muted", txt, { left: 0, top: 0, opacity: 0.7 }, "Paste a link");
    // well-formed example links (lib/media.ts accepts each); the ids are placeholders
    const links = ["https://x.com/example/status/1234567890123456789", "https://www.tiktok.com/@example/video/7312345678901234567", "https://www.instagram.com/reel/C1a2B3c4D5e/"].map((s) => h("div", "abs", txt, { left: 0, top: 0, whiteSpace: "nowrap" }, s));
    const paste = h("div", "row", f, { height: "44px", gap: "7px", padding: "0 13px", borderRadius: "12px", background: "var(--wash)", fontSize: "14.5px", fontWeight: 500 });
    icon("clipboard-paste", 16, 2, paste); h("span", "", paste, null, "Paste");
    return { f, ph, links, paste };
  }

  function mp4Face() {
    const f = h("div", "btn", null, { color: "#fff", fontSize: "16px", gap: "8px" });
    icon("film", 18, 2, f); h("span", "", f, null, "MP4");
    return f;
  }

  // ------------------------------------------------------------------ Pricing
  const PLANS = [
    { id: "free", name: "Free", price: 0, feats: ["Every tool"], cta: "Start free" },
    { id: "pro", name: "Pro", price: 49, feats: ["Unlimited edits, no watermark", "Unlimited cloud storage"], cta: "Upgrade to Pro", pop: true },
    { id: "team", name: "Team", price: 199, feats: ["Everything in Pro", "5 seats"], cta: "Upgrade to Team" },
  ];

  /**
   * Price odometer: per-digit strips; a digit only moves while the one below carries.
   * Leading zeros are never shown: a higher digit's slot opens only once the value reaches it.
   */
  function odometer(parent, value, fs) {
    const digits = String(value).split("");
    const wrap = h("span", "odo", parent, { height: px(fs * 1.1), lineHeight: px(fs * 1.1) });
    const slots = digits.map((d) => {
      const slot = h("span", "slot", wrap, { height: px(fs * 1.1) });
      const ghost = h("span", "", slot, { visibility: "hidden" }, d);
      const strip = h("span", "strip", slot);
      for (let n = 0; n <= 10; n++) h("span", "", strip, { height: px(fs * 1.1) }, String(n % 10));
      return { slot, strip, ghost };
    });
    return {
      wrap,
      set(v) {
        const n = slots.length;
        slots.forEach((s, i) => {
          const p = n - 1 - i;
          const base = Math.pow(10, p);
          const open = p === 0 || v >= base;
          s.slot.style.width = open ? "" : "0px";
          s.slot.style.opacity = open ? "" : "0";
          const d = Math.floor(v / base) % 10 + Math.max(0, (v % base) - (base - 1));
          s.strip.style.transform = `translateY(${(-d * fs * 1.1).toFixed(2)}px)`;
        });
      },
    };
  }

  function planCard(parent, p, mobile) {
    const W0 = mobile ? 420 : 400;
    const root = h("div", "abs", parent, { left: 0, top: 0, width: px(W0), height: px(mobile ? 400 : 380), padding: "34px 32px 30px" });
    h("div", "", root, { fontSize: "19px", fontWeight: 600 }, p.name);
    const pr = h("div", "row", root, { alignItems: "baseline", marginTop: "14px", gap: "6px" });
    const num = h("span", "price-num row", pr, { fontSize: "40px" });
    h("span", "", num, null, "R");
    const odo = odometer(num, p.price, 40);
    h("span", "muted", pr, { fontSize: "17px" }, "/mo");
    const feats = h("div", "", root, { marginTop: "26px", display: "flex", flexDirection: "column", gap: "14px" });
    const featEls = p.feats.map((f) => {
      const r = h("div", "check-row", feats);
      h("span", "", r, { color: "#7c3aed", display: "flex" }).appendChild(icon("check", 17, 2.4));
      h("span", "", r, null, f);
      return r;
    });
    const cta = h("div", "btn " + (p.pop ? "primary" : "outline"), root, { position: "absolute", left: "32px", right: "32px", bottom: "34px", height: "48px", fontSize: "16px" }, p.cta);
    let popEl = null;
    if (p.pop) popEl = h("div", "abs badge", root, { left: "32px", top: "-15px", height: "30px", padding: "0 14px", background: "#7c3aed", color: "#fff", fontSize: "13.5px", fontWeight: 600, boxShadow: "0 6px 14px -4px rgba(124,58,237,0.45)" }, "Most popular");
    return { root, odo, featEls, cta, popEl, w: W0 };
  }

  function upgradeFace() {
    return h("div", "btn", null, { color: "#fff", fontSize: "16px" }, "Upgrade to Pro");
  }

  function planPill(parent, p) {
    const r = h("div", "abs row card", parent, { left: 0, top: 0, height: "64px", padding: "0 22px", gap: "12px", borderRadius: "999px", fontSize: "18px" });
    h("span", "", r, { fontWeight: 600 }, p.name);
    const num = h("span", "price-num row", r, { fontSize: "22px" });
    h("span", "", num, null, "R");
    const odo = odometer(num, p.price, 22);
    h("span", "muted", r, { fontSize: "15px", marginLeft: "-6px" }, "/mo");
    let extra = null;
    if (p.id === "team") { h("span", "", r, { width: "1px", height: "22px", background: "var(--line)" }); extra = h("span", "muted", r, { fontSize: "16px", fontWeight: 500, whiteSpace: "nowrap" }, "5 seats"); }
    return { root: r, odo, extra };
  }

  window.UI = {
    ico, hat, CHOICES, optFace, chooser, PDF_TOOLS, pdfBranch, fileChipFace, toolFace, compressPanel, castFace,
    NEXT, pillFace, donePanel, checkFace, doneFace, page, editor, toolFaceIcon, saveFace, aiPanel, pptxCard, editPptxFace,
    SLIDES, slideBody, pptxEditor, bandFace, pdfBtnFace, mediaCard, linkFace, mp4Face, PLANS, planCard, upgradeFace, planPill, odometer,
  };
})();
