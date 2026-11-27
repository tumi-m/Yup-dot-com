// After a Team plan ended, the Billing page hid the seat list, so the owner
// couldn't see or remove the member emails, which are kept and get Team
// again if the owner renews. The list now stays, for removing only.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamSeats } from "../components/BillingClient.tsx";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const render = (ended: boolean) =>
  renderToStaticMarkup(createElement(TeamSeats, { ownerEmail: "owner@x.co", initialMembers: ["carol@x.co"], seats: 5, ended }));

const ended = render(true);
check("ended: the member is listed", ended.includes("carol@x.co"));
check("ended: and can be removed", ended.includes('aria-label="Remove carol@x.co"'));
check("ended: no new members", !ended.includes('aria-label="Member email"'));
check("ended: says why the list is still here", /has ended/.test(ended) && /renew/.test(ended));

const active = render(false);
check("active: members can be added", active.includes('aria-label="Member email"') && active.includes("2 of 5 seats"));

// A long email pushed Remove out of the card at 320px: emails wrap now.
const long = "thandiwe.mokoena-vandermerwe@accounts.example-company.co.za";
const wide = renderToStaticMarkup(createElement(TeamSeats, { ownerEmail: long, initialMembers: [long], seats: 5 }));
check("long emails wrap inside the row", (wide.match(new RegExp(`<span class="min-w-0 break-all">${long.replace(/\./g, "\\.")}</span>`, "g")) ?? []).length === 2, wide);
check("and Remove keeps its size", /class="[^"]*shrink-0[^"]*"[^>]*aria-label="Remove /.test(wide));

const page = readFileSync(new URL("../app/settings/billing/page.tsx", import.meta.url), "utf8");
check("Billing's plan lines wrap a long owner email inside the card",
  /<div className="min-w-0">\s*<p className="text-2xl font-bold">\{planTitle\(billing\)\}<\/p>/.test(page) && /className="break-words text-sm text-muted-foreground"/.test(page));
const passwordPage = readFileSync(new URL("../app/settings/password/page.tsx", import.meta.url), "utf8");
check("so does the new password page's email", /For <span className="break-all">\{profile\.email\}<\/span>/.test(passwordPage));
check("Billing lists seats while members exist, whatever the plan",
  /\(ownsTeam \|\| members\.length > 0\) && \(/.test(page) && /ended=\{!ownsTeam\}/.test(page) &&
    !/ownsTeam && isAdminConfigured\(\)/.test(page));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll ended Team seat checks passed.");
