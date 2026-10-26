/** Which redirects the live check follows to the site's main address (scripts/lib/site-redirect.mjs). */
import { mainAddress } from "../scripts/lib/site-redirect.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

check("bare domain to www", mainAddress("https://pdfwizard.xyz", "https://www.pdfwizard.xyz/") === "https://www.pdfwizard.xyz");
check("www to bare domain", mainAddress("https://www.pdfwizard.xyz", "https://pdfwizard.xyz/dashboard") === "https://pdfwizard.xyz");
check("case doesn't matter", mainAddress("https://PDFWizard.xyz", "https://WWW.pdfwizard.xyz") === "https://www.pdfwizard.xyz");
check("a relative redirect stays put", mainAddress("https://pdfwizard.xyz", "/login") === null);
check("another site is not followed", mainAddress("https://pdfwizard.xyz", "https://evil.example/") === null);
check("a look-alike is not followed", mainAddress("https://pdfwizard.xyz", "https://www.pdfwizard.xyz.evil.example/") === null);
check("a subdomain other than www is not followed", mainAddress("https://pdfwizard.xyz", "https://app.pdfwizard.xyz/") === null);
check("http is not followed from https", mainAddress("https://pdfwizard.xyz", "http://www.pdfwizard.xyz/") === null);
check("a different port is not followed", mainAddress("https://pdfwizard.xyz", "https://www.pdfwizard.xyz:8443/") === null);
check("no location", mainAddress("https://pdfwizard.xyz", null) === null);
check("a broken location", mainAddress("https://pdfwizard.xyz", "http://[::1") === null);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll redirect checks passed.");
