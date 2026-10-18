/**
 * /.well-known/security.txt (RFC 9116): the fields a researcher's tools look
 * for, from the site URL and the security address, with an Expires that
 * stays under a year away.
 */
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.xyz/";
import { securityTxt } from "../lib/security-txt.ts";

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

const route = await import("../app/.well-known/security.txt/route.ts");
const res = route.GET();
const body = await res.text();
check("the route serves it as plain text", res.headers.get("content-type")?.startsWith("text/plain") === true && body.startsWith("Contact: mailto:security@pdfwizard.xyz\n"), body);
check("from the configured site URL", body.includes("Canonical: https://pdfwizard.xyz/.well-known/security.txt"), body);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
