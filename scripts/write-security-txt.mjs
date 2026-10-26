#!/usr/bin/env node
/**
 * Writes public/.well-known/security.txt before every build and dev start, so
 * it is served as a plain static file (Vercel refuses anything else at
 * /.well-known/). Its Expires is under a year away from the build; the
 * weekly Live check warns when a redeploy is due.
 *
 *   node scripts/write-security-txt.mjs [output path]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSiteUrl, securityEmail, securityTxt } from "../lib/security-txt.mjs";

const out = process.argv[2] ?? join(dirname(new URL(import.meta.url).pathname), "..", "public", ".well-known", "security.txt");
const site = buildSiteUrl();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, securityTxt({ site, email: securityEmail() }));
console.log(`security.txt written for ${site}.`);
