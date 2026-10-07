import { staggerDelay, STAGGER, STAGGER_CAP, DUR } from "../components/motion/tokens.ts";
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
check("stagger custom step", near(staggerDelay(20, 0.025), 12 * 0.025));
check("stagger ignores negatives", staggerDelay(-2) === 0);
check("exits are never slower than entrances", DUR.fast <= DUR.base && DUR.tap < DUR.fast);

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
