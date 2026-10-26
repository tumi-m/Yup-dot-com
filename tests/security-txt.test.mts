/**
 * /.well-known/security.txt (RFC 9116): the fields a researcher's tools look
 * for, from the site URL and the security address, with an Expires that
 * stays under a year away.
 */
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.xyz/";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSiteUrl, securityEmail, securityTxt } from "../lib/security-txt.mjs";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const now = new Date("2026-10-18T15:30:00Z");
const txt = securityTxt({ site: "https://pdfwizard.xyz/", email: "security@pdfwizard.xyz", now });
const field = (name: string) => txt.split("\n").filter((l) => l.startsWith(name + ": ")).map((l) => l.slice(name.length + 2));
check("Contact is the security address", field("Contact")[0] === "mailto:security@pdfwizard.xyz", txt);
const expires = new Date(field("Expires")[0]);
const days = (expires.getTime() - now.getTime()) / 86_400_000;
check("Expires is about a year away, and under one", days > 330 && days < 365, String(days));
check("Expires is an RFC 3339 time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(field("Expires")[0]), field("Expires")[0]);
check("Canonical is where it's served", field("Canonical")[0] === "https://pdfwizard.xyz/.well-known/security.txt");
check("Policy is the security page", field("Policy")[0] === "https://pdfwizard.xyz/security");
check("each field once, and the file ends with a newline", ["Contact", "Expires", "Canonical", "Policy", "Preferred-Languages"].every((f) => field(f).length === 1) && txt.endsWith("\n"));

// Written into public/ before every build, so it is served as a static file.
const dir = mkdtempSync(join(tmpdir(), "security-txt-"));
const out = join(dir, ".well-known", "security.txt");
execFileSync(process.execPath, ["scripts/write-security-txt.mjs", out], {
  env: { PATH: process.env.PATH ?? "", NEXT_PUBLIC_SITE_URL: "https://pdfwizard.xyz/" },
});
const body = readFileSync(out, "utf8");
rmSync(dir, { recursive: true, force: true });
check("the build script writes it", body.startsWith("Contact: mailto:security@pdfwizard.xyz\n"), body);
check("from the configured site URL", body.includes("Canonical: https://pdfwizard.xyz/.well-known/security.txt"), body);
check("without NEXT_PUBLIC_SITE_URL, Vercel's production address", buildSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "pdfwizard.xyz" }) === "https://pdfwizard.xyz");
check("the security address can be changed, and a bad one is ignored",
  securityEmail({ NEXT_PUBLIC_SECURITY_EMAIL: "sec@example.com" }) === "sec@example.com" &&
    securityEmail({ NEXT_PUBLIC_SECURITY_EMAIL: "not an email" }) === "security@pdfwizard.xyz");

const legacy = (await import("../app/security.txt/route.ts")).GET();
check("/security.txt redirects there from a route (so it gets the security headers)",
  legacy.status === 308 && legacy.headers.get("location") === "/.well-known/security.txt");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
