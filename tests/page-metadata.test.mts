// Shared links to /pricing, /tools and the legal pages showed the home page's
// title and description (og: and twitter: tags): a page that sets only a
// title and description inherits the root openGraph as it is. Each page now
// sets its own, keeping the site's shared-link image.
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { ResolvingMetadata } from "next";
import { pageMetadata } from "../lib/page-metadata.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const IMAGE = { url: "https://pdfwizard.test/opengraph-image?abc", width: 1200, height: 630 };
const parent = Promise.resolve({ openGraph: { images: [IMAGE] } }) as unknown as ResolvingMetadata;
type OpenGraph = { title?: string; description?: string; url?: string; type?: string; images?: unknown[] };

{
  const md = await pageMetadata({ title: "Pricing", description: "Free to start.", path: "/pricing" }, parent);
  const og = md.openGraph as OpenGraph;
  check("og title and description are the page's", og.title === "Pricing" && og.description === "Free to start.", og);
  check("og url is the page's", og.url === "/pricing" && (md.alternates?.canonical as string) === "/pricing");
  check("the site's image is kept", JSON.stringify(og.images) === JSON.stringify([IMAGE]), og.images);
  check("og type stays website", og.type === "website");
}

// Every page the bug named, through its own generateMetadata.
for (const path of ["/pricing", "/tools", "/privacy", "/terms", "/refunds", "/security", "/contact"]) {
  const page = await import(`../app${path}/page.tsx`);
  const md = await page.generateMetadata({}, parent);
  const og = md.openGraph as OpenGraph;
  check(`${path}: shared links use the page's own title and description`,
    !!md.title && og.title === md.title && og.description === md.description && og.url === path &&
      !/cast spells|A complete PDF toolkit/.test(`${og.title} ${og.description}`), { title: md.title, og });
}

// No public page sets a description without its shared-link one.
const pages: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (name === "page.tsx") pages.push(p);
  }
};
walk(new URL("../app", import.meta.url).pathname);
const bare = pages.filter((p) => {
  const src = readFileSync(p, "utf8");
  const m = src.match(/export const metadata[^=]*=\s*\{([\s\S]*?)\n\};/);
  return m && /\bdescription:/.test(m[1]) && !/openGraph/.test(m[1]);
});
check("no page sets a description without openGraph", bare.length === 0, bare);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll page metadata checks passed.");
