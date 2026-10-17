import {
  cssEase,
  cssMs,
  DUR,
  EASE_IN,
  EASE_IN_OUT,
  EASE_OUT,
  ENTER,
  EXIT,
  POP_IN,
  progressTranslate,
  SHAKE_T,
  SPRING,
  SPRING_LAYOUT,
  SPRING_POP,
  STAGGER,
  STAGGER_CAP,
  staggerDelay,
  SUCCESS,
  SUCCESS_CARD_T,
} from "../components/motion/tokens.ts";
import {
  filterTools,
  groupOf,
  parsePill,
  pillLabel,
  rovingIndex,
  TOOL_GROUPS,
  TOOL_PILLS,
} from "../components/tool-filter.ts";
import { isNavActive } from "../components/nav-utils.ts";
import { needsScrollIntoView, reservedHeight, RESERVE_MAX } from "../components/motion/focus.ts";
import { safeRedirect } from "../components/auth-redirect.ts";
import { TOOLS } from "../lib/tools.tsx";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Motion tokens
check("stagger starts at 0", staggerDelay(0) === 0);
check("stagger steps by STAGGER", near(staggerDelay(3), 3 * STAGGER));
check("stagger caps at STAGGER_CAP", near(staggerDelay(40), STAGGER_CAP * STAGGER) && staggerDelay(40) === staggerDelay(STAGGER_CAP));
check("stagger custom step", near(staggerDelay(20, 0.025), STAGGER_CAP * 0.025));
check("stagger ignores negatives", staggerDelay(-2) === 0);
check("exits are never slower than entrances", DUR.fast <= DUR.base && DUR.tap < DUR.fast);
check("duration scale", DUR.tap === 0.1 && DUR.fast === 0.15 && DUR.base === 0.24 && DUR.slow === 0.4 && DUR.hero === 0.6, DUR);
check("a list's whole stagger fits in one entrance", staggerDelay(1000) <= DUR.base + 1e-9, staggerDelay(1000));
check("exits are at most 70% of their entrance", EXIT.transition.duration <= ENTER.animate.transition.duration * 0.7 && POP_IN.exit.transition.duration <= POP_IN.animate.transition.duration * 0.7);
check("a wait-mode swap (exit then enter) costs at most 0.4s", EXIT.transition.duration + ENTER.animate.transition.duration <= 0.4);
check("exits accelerate away (ease-in, no lingering)", EXIT.transition.ease === EASE_IN && EASE_IN[0] > 0 && EASE_IN[2] === 1 && EASE_IN[3] === 1);
check("entrances decelerate", ENTER.animate.transition.ease === EASE_OUT && EASE_OUT[1] === 1);
check("on-screen moves ease both ways", EASE_IN_OUT[1] === 0 && EASE_IN_OUT[3] === 1);
check("press and layout springs settle without bounce", SPRING.damping / (2 * Math.sqrt(SPRING.stiffness)) > 0.7 && SPRING_LAYOUT.damping / (2 * Math.sqrt(SPRING_LAYOUT.stiffness)) > 0.85);
check("the pop spring overshoots a little", SPRING_POP.damping / (2 * Math.sqrt(SPRING_POP.stiffness)) > 0.5 && SPRING_POP.damping / (2 * Math.sqrt(SPRING_POP.stiffness)) < 0.7);
check("error shake stays within 0.3-0.4s", SHAKE_T.duration >= 0.3 && SHAKE_T.duration <= 0.4 && SHAKE_T.ease === EASE_IN_OUT);
check("success: Download is interactive by 0.45s", SUCCESS.actions + DUR.base <= 0.45);
check("success: whole stagger under 0.5s before the upsell", Math.max(SUCCESS.title, SUCCESS.check, SUCCESS.stats, SUCCESS.actions, SUCCESS.next) < 0.5 && SUCCESS.upsell >= 0.6);
check("success card is a slow, page-level change", SUCCESS_CARD_T.duration === DUR.slow && SUCCESS_CARD_T.opacity.duration === DUR.base);
check("css ease", cssEase(EASE_OUT) === "cubic-bezier(0.22, 1, 0.36, 1)" && cssEase(EASE_IN) === "cubic-bezier(0.4, 0, 1, 1)");
check("css ms", cssMs(DUR.base) === "240ms" && cssMs(DUR.fast) === "150ms" && cssMs(0.1) === "100ms");
check("progress: full bar at 1", progressTranslate(1) === "translateX(0.00%)");
check("progress: half way", progressTranslate(0.5) === "translateX(-50.00%)");
check("progress: never quite empty", progressTranslate(0) === "translateX(-96.00%)" && progressTranslate(-1) === progressTranslate(0));
check("progress: the gradient counter-slides by the same amount", progressTranslate(0.3, -1) === "translateX(70.00%)" && progressTranslate(1, -1) === "translateX(0.00%)");
check("result in view: under the sticky header scrolls", needsScrollIntoView(40, 900) && needsScrollIntoView(-300, 900));
check("result in view: comfortably placed stays put", !needsScrollIntoView(120, 900) && !needsScrollIntoView(360, 900));
check("result in view: low on the screen scrolls", needsScrollIntoView(361, 900));
check("reserve: keeps the current height", reservedHeight(500, 900) === 500);
check("reserve: at least the floor", reservedHeight(300, 900, 0.7) === 630);
check("reserve: never more than most of a screen", reservedHeight(2000, 900) === Math.round(900 * RESERVE_MAX) && reservedHeight(100, 900, 1) === Math.round(900 * RESERVE_MAX));
check("progress: clamps and survives NaN", progressTranslate(7) === progressTranslate(1) && progressTranslate(NaN) === progressTranslate(0));

// Category pills: Optimize folds into Organize
check("8 pills, no optimize", TOOL_PILLS.length === 8 && !TOOL_PILLS.includes("optimize" as never), TOOL_PILLS);
check("optimize → organize", groupOf("optimize") === "organize");
check("every tool lands in a group", TOOLS.every((t) => TOOL_GROUPS.includes(groupOf(t.category))));
const organize = filterTools(TOOLS, "organize", "");
check("Compress PDF shows under Organize", organize.some((t) => t.slug === "compress-pdf"), organize.map((t) => t.slug));
check("every group has 2+ tools", TOOL_GROUPS.every((g) => filterTools(TOOLS, g, "").length >= 2));
check("groups partition all tools", TOOL_GROUPS.reduce((n, g) => n + filterTools(TOOLS, g, "").length, 0) === TOOLS.length);
check("all = everything", filterTools(TOOLS, "all", "  ").length === TOOLS.length);
check("search is case-insensitive", filterTools(TOOLS, "all", "MERGE").some((t) => t.slug === "merge-pdf"));
check("search within a category", filterTools(TOOLS, "media", "mp3").every((t) => groupOf(t.category) === "media") && filterTools(TOOLS, "media", "mp3").length > 0);
check("no match is empty", filterTools(TOOLS, "all", "zzzz").length === 0);
check("labels", pillLabel("all") === "All" && pillLabel("media") === "Video & Audio");

// ?c= deep links
check("?c=media", parsePill("media") === "media");
check("?c=optimize maps to organize", parsePill("optimize") === "organize");
check("unknown ?c= → all", parsePill("nope") === "all" && parsePill(null) === "all" && parsePill("") === "all");
check("?c=__proto__ → all", parsePill("__proto__") === "all");

// Roving focus
check("right wraps", rovingIndex("ArrowRight", 7, 8) === 0);
check("left wraps", rovingIndex("ArrowLeft", 0, 8) === 7);
check("down = next", rovingIndex("ArrowDown", 2, 8) === 3);
check("home / end", rovingIndex("Home", 5, 8) === 0 && rovingIndex("End", 1, 8) === 7);
check("other keys ignored", rovingIndex("Tab", 1, 8) === null && rovingIndex("a", 1, 8) === null);
check("empty group", rovingIndex("ArrowRight", 0, 0) === null);

// Nav active state
check("/tools active on /tools", isNavActive("/tools", "/tools"));
check("/tools active on a tool page", isNavActive("/tools/merge-pdf", "/tools"));
check("/tools not active on /toolsy", !isNavActive("/toolsy", "/tools"));
check("/pricing not active on /tools", !isNavActive("/tools", "/pricing"));
check("home only on /", isNavActive("/", "/") && !isNavActive("/tools", "/"));
check("null pathname", !isNavActive(null, "/tools"));

// Post-login redirect stays on this site
check("default", safeRedirect(null) === "/dashboard" && safeRedirect("") === "/dashboard");
check("same-site path kept", safeRedirect("/pricing") === "/pricing");
check("path with query kept", safeRedirect("/tools/merge-pdf?handoff=1") === "/tools/merge-pdf?handoff=1");
check("protocol-relative rejected", safeRedirect("//evil.com") === "/dashboard");
check("backslash trick rejected", safeRedirect("/\\evil.com") === "/dashboard");
check("absolute URL rejected", safeRedirect("https://evil.com/x") === "/dashboard");
check("javascript: rejected", safeRedirect("javascript:alert(1)") === "/dashboard");
check("tab trick rejected", safeRedirect("/\t/evil.com") === "/dashboard");
check("custom fallback", safeRedirect("nope", "/") === "/");

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
