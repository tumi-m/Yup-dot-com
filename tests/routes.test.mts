/**
 * scripts/routes.mjs lists every page and route in app/ as public or
 * private (pages) and public or closed (routes). The live check asks for
 * each one signed out. A page or route in neither list fails here, so a new
 * /admin or /account page can't ship without being checked, and every
 * private page must sit under a prefix the proxy guards.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLOSED_ROUTES, PRIVATE_PAGES, PUBLIC_PAGES, PUBLIC_ROUTES } from "../scripts/routes.mjs";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const app = new URL("../app", import.meta.url).pathname;
const found: { path: string; kind: "page" | "route" }[] = [];
(function walk(dir: string, url: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name.startsWith("_") || name.startsWith("@")) continue; // private folders, parallel slots
      walk(full, /^\(.*\)$/.test(name) ? url : `${url}/${name}`); // (group) folders add nothing to the URL
      continue;
    }
    const at = url || "/";
    if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name)) found.push({ path: at, kind: "page" });
    else if (/^route\.(ts|js)$/.test(name)) found.push({ path: at, kind: "route" });
    // Metadata files Next.js serves as routes.
    else if (/^(icon|apple-icon|opengraph-image|twitter-image)\.(svg|png|jpg|ico|tsx|ts|jsx|js)$/.test(name)) found.push({ path: `${url}/${name.replace(/\.(tsx|ts|jsx|js)$/, "")}`, kind: "route" });
    else if (/^(robots|sitemap|manifest)\.(ts|js)$/.test(name)) found.push({ path: `${url}/${name.replace(/\.(ts|js)$/, name.startsWith("manifest") ? ".webmanifest" : name.startsWith("robots") ? ".txt" : ".xml")}`, kind: "route" });
  }
})(app, "");

const pages = new Set([...PUBLIC_PAGES, ...PRIVATE_PAGES]);
const routes = new Set([...PUBLIC_ROUTES, ...CLOSED_ROUTES]);
const unlisted = found.filter((f) => !(f.kind === "page" ? pages : routes).has(f.path)).map((f) => `${f.kind} ${f.path}`);
check(`every page and route in app/ is listed in scripts/routes.mjs (${found.length})`, unlisted.length === 0, `add to scripts/routes.mjs: ${unlisted.join(", ")}`);
const stale = [...pages].filter((p) => !found.some((f) => f.kind === "page" && f.path === p)).concat([...routes].filter((r) => !found.some((f) => f.kind === "route" && f.path === r)));
check("and nothing listed is gone", stale.length === 0, stale.join(", "));
const twice = PUBLIC_PAGES.filter((p) => PRIVATE_PAGES.includes(p)).concat(PUBLIC_ROUTES.filter((r) => CLOSED_ROUTES.includes(r)));
check("no path is in two lists", twice.length === 0, twice.join(", "));

const middleware = readFileSync(new URL("../lib/supabase/middleware.ts", import.meta.url), "utf8");
const prefixes = [...(/PROTECTED_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(middleware)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const unguarded = PRIVATE_PAGES.filter((p) => !prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`)));
check("every private page is under a prefix the proxy sends to /login", prefixes.length > 0 && unguarded.length === 0, unguarded.join(", "));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
