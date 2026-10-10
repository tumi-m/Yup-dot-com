/**
 * Business details for the legal pages (lib/business.ts), plus the sitemap
 * and robots rules that go with them.
 */
import { resolveBusiness, telHref, DEFAULT_BUSINESS_NAME, LEGAL_UPDATED } from "../lib/business.ts";
import sitemapModule from "../app/sitemap.ts";
import robotsModule from "../app/robots.ts";

// The app files are CommonJS to tsx here, so the default export may arrive wrapped.
type Fn<T> = () => T;
const unwrap = <T,>(m: unknown): Fn<T> => (typeof m === "function" ? m : (m as { default: unknown }).default) as Fn<T>;
const sitemap = unwrap<ReturnType<typeof sitemapModule>>(sitemapModule);
const robots = unwrap<ReturnType<typeof robotsModule>>(robotsModule);

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const FULL = {
  NEXT_PUBLIC_BUSINESS_NAME: "PDF Wizard",
  NEXT_PUBLIC_LEGAL_NAME: "Tumelo Malebo",
  NEXT_PUBLIC_CONTACT_EMAIL: "hello@pdfwizard.example",
  NEXT_PUBLIC_CONTACT_PHONE: "+27 82 123 4567",
  NEXT_PUBLIC_BUSINESS_ADDRESS: "1 Example Street, Johannesburg, 2001",
};

// Production: nothing set → only the trading name, no placeholders.
{
  const b = resolveBusiness({}, false);
  check("prod, unset: default trading name", b.name === DEFAULT_BUSINESS_NAME && b.name === "PDF Wizard");
  check("prod, unset: details left out", b.legalName === null && b.email === null && b.phone === null && b.address === null, b);
  check("prod, unset: no placeholders", b.placeholders.length === 0);
}

// Development: missing details become obvious placeholders.
{
  const b = resolveBusiness({}, true);
  check("dev, unset: four placeholders", b.placeholders.sort().join() === "address,email,legalName,phone", b.placeholders);
  check("dev, unset: legal name placeholder names its variable", b.legalName === "[NEXT_PUBLIC_LEGAL_NAME]");
  check("dev, unset: address placeholder names its variable", b.address === "[NEXT_PUBLIC_BUSINESS_ADDRESS]");
  check("dev, unset: email placeholder is a reserved example domain", b.email === "contact@example.com");
  const partial = resolveBusiness({ NEXT_PUBLIC_LEGAL_NAME: "Tumelo Malebo" }, true);
  check("dev, partly set: real values are not placeholders", partial.legalName === "Tumelo Malebo" && !partial.placeholders.includes("legalName"));
}

// Everything set: values pass through (trimmed), in either mode.
{
  for (const dev of [false, true]) {
    const b = resolveBusiness(FULL, dev);
    check(`${dev ? "dev" : "prod"}, set: values kept`, b.legalName === "Tumelo Malebo" && b.email === FULL.NEXT_PUBLIC_CONTACT_EMAIL && b.phone === FULL.NEXT_PUBLIC_CONTACT_PHONE && b.address === FULL.NEXT_PUBLIC_BUSINESS_ADDRESS && b.placeholders.length === 0, b);
  }
  const spaced = resolveBusiness({ NEXT_PUBLIC_LEGAL_NAME: "  Tumelo \n Malebo ", NEXT_PUBLIC_BUSINESS_NAME: "  " }, false);
  check("whitespace collapsed and trimmed", spaced.legalName === "Tumelo Malebo");
  check("blank business name falls back to the default", spaced.name === "PDF Wizard");
  check("business name can be overridden", resolveBusiness({ NEXT_PUBLIC_BUSINESS_NAME: "Wizard Docs" }, false).name === "Wizard Docs");
}

// Validation: a bad value is treated as unset, never shown.
{
  check("invalid email dropped in prod", resolveBusiness({ NEXT_PUBLIC_CONTACT_EMAIL: "not-an-email" }, false).email === null);
  check("email with markup dropped", resolveBusiness({ NEXT_PUBLIC_CONTACT_EMAIL: '"><script>@x.com' }, false).email === null);
  check("invalid email → placeholder in dev", resolveBusiness({ NEXT_PUBLIC_CONTACT_EMAIL: "nope" }, true).placeholders.includes("email"));
  check("phone with letters dropped", resolveBusiness({ NEXT_PUBLIC_CONTACT_PHONE: "call me" }, false).phone === null);
  check("too-short phone dropped", resolveBusiness({ NEXT_PUBLIC_CONTACT_PHONE: "12345" }, false).phone === null);
  check("SA phone formats kept", resolveBusiness({ NEXT_PUBLIC_CONTACT_PHONE: "(011) 555-0100" }, false).phone === "(011) 555-0100");
  check("long values are capped", (resolveBusiness({ NEXT_PUBLIC_BUSINESS_ADDRESS: "x".repeat(1000) }, false).address ?? "").length === 300);
}

check("tel: link keeps + and digits", telHref("+27 82 123 4567") === "tel:+27821234567");
check("tel: link drops punctuation", telHref("(011) 555-0100") === "tel:0115550100");
check("legal date is ISO", /^\d{4}-\d{2}-\d{2}$/.test(LEGAL_UPDATED) && !Number.isNaN(Date.parse(LEGAL_UPDATED)));

// Sitemap and robots.
{
  const urls = sitemap().map((e) => new URL(e.url).pathname);
  for (const p of ["/privacy", "/terms", "/refunds", "/contact"]) check(`sitemap lists ${p}`, urls.includes(p), urls);
  check("sitemap has no private routes", !urls.some((p) => /^\/(api|auth|dashboard|edit|editor|settings)(\/|$)/.test(p)));
  const rules = robots().rules;
  const disallow = (Array.isArray(rules) ? rules[0] : rules).disallow as string[];
  for (const p of ["/api/", "/auth/", "/dashboard", "/edit/", "/editor", "/settings"]) {
    check(`robots disallows ${p}`, disallow.includes(p), disallow);
  }
  check("robots keeps the legal pages crawlable", !disallow.some((d) => ["/privacy", "/terms", "/refunds", "/contact"].some((p) => p.startsWith(d))));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
