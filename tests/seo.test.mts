/**
 * What search engines read: each tool page's description and structured
 * data, the sitemap (indexable pages only, no build date on every page), the
 * sign-in and signed-in pages kept out of results, tool names that match
 * between the card, the h1 and the title, and the workbench's main button
 * naming what it does.
 */
import { readFileSync } from "node:fs";
import type { ResolvingMetadata } from "next";

const { TOOLS, shownTools, getTool, metaDescription, staysOnDevice } = await import("../lib/tools.tsx");
const { toolJsonLd, siteJsonLd, jsonLdHtml } = await import("../lib/structured-data.ts");
const { panelSpec } = await import("../components/tools/panel-spec.tsx");
const { actionLabel } = await import("../components/tools/action-label.ts");
const { filterTools } = await import("../components/tool-filter.ts");
const sitemap = (await import("../app/sitemap.ts")).default;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail).slice(0, 400)})` : ""}`);
  if (!ok) failed++;
}

const ALL = shownTools({ youtube: true, office: true, html: true });

// Descriptions: long enough to say something, short enough not to be cut.
{
  const bad = ALL.map((t) => [t.slug, metaDescription(t)] as const).filter(([, d]) => d.length < 50 || d.length > 160);
  check("every tool's description is 50 to 160 characters", bad.length === 0, bad);
  const seen = new Set(ALL.map(metaDescription));
  check("and no two are the same", seen.size === ALL.length);
  const claims = ALL.filter((t) => /stay on your device/.test(metaDescription(t)));
  check("only tools that never upload say files stay on the device", claims.every(staysOnDevice) && claims.length > 0);
  for (const slug of ["chat-with-pdf", "translate-pdf", "word-to-pdf", "html-to-pdf", "edit-pdf", "sign-pdf", "x-to-mp4", "google-slides-to-pdf"]) {
    const t = ALL.find((x) => x.slug === slug)!;
    check(`${slug} doesn't promise the file stays put`, !staysOnDevice(t) && !/device/.test(metaDescription(t)), metaDescription(t));
  }
  const pro = ALL.find((t) => t.badge === "Pro")!;
  check("a Pro-only tool isn't called free", !/free/i.test(metaDescription(pro)), metaDescription(pro));
}

// The tool page's metadata uses it.
{
  const page = await import("../app/tools/[slug]/page.tsx");
  const parent = Promise.resolve({ openGraph: { images: [] } }) as unknown as ResolvingMetadata;
  const md = await page.generateMetadata({ params: Promise.resolve({ slug: "protect-pdf" }) }, parent);
  check("a tool page's description is the long one", md.description === metaDescription(getTool("protect-pdf")!), md.description);
}

// Structured data.
{
  const base = "https://pdfwizard.test";
  for (const t of ALL) {
    const html = jsonLdHtml(toolJsonLd(t, base));
    const data = JSON.parse(html) as { "@graph": Record<string, unknown>[] };
    const crumbs = data["@graph"].find((n) => n["@type"] === "BreadcrumbList") as { itemListElement: { position: number; name: string; item: string }[] };
    const app = data["@graph"].find((n) => n["@type"] === "WebApplication") as Record<string, unknown>;
    const ok =
      crumbs.itemListElement.map((c) => c.position).join() === "1,2,3" &&
      crumbs.itemListElement[1].item === `${base}/tools` &&
      crumbs.itemListElement[2].name === t.name &&
      crumbs.itemListElement[2].item === `${base}/tools/${t.slug}` &&
      app.name === t.name &&
      app.url === `${base}/tools/${t.slug}` &&
      app.description === metaDescription(t) &&
      // Pro-only tools carry no free offer.
      (t.badge === "Pro" ? !("offers" in app) : (app.offers as { price: string }).price === "0");
    if (!ok) check(`${t.slug}: breadcrumbs and app match the page`, false, data);
  }
  check("every tool page's structured data matches what it shows", true);
  const tricky = jsonLdHtml({ name: "</script><b>" });
  check("\"<\" can't close the script tag", !tricky.includes("<") && JSON.parse(tricky).name === "</script><b>");
  const site = siteJsonLd(base);
  check("the home page names the site", site["@type"] === "WebSite" && site.name === "PDF Wizard" && site.url === base);
}

// Sitemap.
{
  const entries = sitemap();
  const paths = entries.map((e) => new URL(e.url).pathname);
  check("no sign-in pages in the sitemap (they are noindex)", !paths.some((p) => /^\/(login|signup|forgot-password|redeem)$/.test(p)), paths);
  check("every shown tool is in it", TOOLS.every((t) => paths.includes(`/tools/${t.slug}`)));
  check("no page twice", new Set(paths).size === paths.length);
  const dated = entries.filter((e) => e.lastModified).map((e) => new URL(e.url).pathname);
  check("only the legal pages carry a date", dated.length > 0 && dated.every((p) => ["/privacy", "/terms", "/refunds", "/security", "/contact"].includes(p)), dated);
}

// Kept out of search results.
{
  const parent = Promise.resolve({ openGraph: { images: [] } }) as unknown as ResolvingMetadata;
  for (const path of ["/login", "/signup", "/forgot-password"]) {
    const page = await import(`../app${path}/page.tsx`);
    const md = await page.generateMetadata({}, parent);
    const robots = md.robots as { index?: boolean; follow?: boolean };
    const og = md.openGraph as { title?: string; description?: string };
    check(`${path}: noindex, no canonical link, own description on shared links`,
      robots?.index === false && robots.follow === true && !!md.description && og.title === md.title && og.description === md.description && !md.alternates?.canonical, md);
  }
  {
    const page = await import("../app/redeem/page.tsx");
    const md = await page.generateMetadata({}, parent);
    const robots = md.robots as { index?: boolean; follow?: boolean };
    const og = md.openGraph as { title?: string; description?: string };
    check("/redeem: noindex, no canonical link, its own title and description on a shared tester link",
      robots?.index === false && md.title === "Tester access" && !!md.description && og.title === md.title && og.description === md.description && !md.alternates?.canonical, md);
  }
  for (const file of ["dashboard/page.tsx", "settings/billing/page.tsx", "settings/password/page.tsx", "editor/[id]/page.tsx"]) {
    const src = readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8");
    check(`${file}: noindex`, /robots:\s*\{\s*index:\s*false/.test(src));
  }
}

// One name per tool: the card, the h1 and the start of the title agree.
{
  check("Chat with PDF is called that on its card and h1", getTool("chat-with-pdf")?.name === "Chat with PDF");
  check("…and is still found as AI Assistant", !!getTool("chat-with-pdf")?.aliases?.includes("AI Assistant"));
  const mismatched = ALL.filter((t) => t.title.includes(": ") && t.title.slice(0, t.title.indexOf(": ")) !== t.name);
  check("a title's part before the colon is the tool's name", mismatched.length === 0, mismatched.map((t) => `${t.name} / ${t.title}`));
  check("Fill & Sign PDF is called that on its card, h1 and title", getTool("sign-pdf")?.name === "Fill & Sign PDF" && getTool("sign-pdf")!.title.startsWith("Fill & Sign PDF: "));
  for (const q of ["sign pdf", "sign", "fill and sign"]) {
    const found = filterTools(ALL, "all", q).map((t) => t.slug);
    check(`search: '${q}' lists Fill & Sign PDF first`, found[0] === "sign-pdf", found.slice(0, 3));
  }
  check("Translate PDF says it gives a PDF too, for most languages", /Word file and, for most languages, a PDF/.test(getTool("translate-pdf")!.description));
  check("Sample Finder's description says what it does", /samples/.test(getTool("sample-finder")!.description));
}

// The workbench's button says what it does.
{
  const workbench = ALL.filter((t) => panelSpec(t).kind === "workbench");
  const generic = workbench.filter((t) => actionLabel(t.slug) === "Cast spell").map((t) => t.slug);
  check(`every workbench tool names its action (${workbench.length})`, workbench.length > 20 && generic.length === 0, generic);
  // OCR PDF can give a text file, not a searchable PDF: the button doesn't promise one.
  check("OCR PDF's button fits either output", actionLabel("ocr-pdf") === "Run OCR");
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll SEO checks passed.");
