import Link from "next/link";
import { CATEGORY_LABELS, TOOLS } from "@/lib/tools";
import { WizardWordmark } from "@/components/WizardLogo";
import { groupOf, TOOL_GROUPS } from "@/components/tool-filter";
import { CookieSettingsButton } from "@/components/analytics/CookieSettingsButton";
import { BUSINESS } from "@/lib/business";
import { GA_ID } from "@/lib/analytics";

const LINK = "rounded transition-colors hover:text-foreground";

const BOTTOM_LINKS = [
  { href: "/tools", label: "All tools" },
  { href: "/pricing", label: "Pricing" },
  { href: "/login", label: "Log in" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/refunds", label: "Refunds" },
  { href: "/contact", label: "Contact" },
];

/**
 * Below md the footer lists categories (each opens the filtered catalogue)
 * rather than all tools; from md up it lists every tool.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="container py-10 md:py-14">
        <div className="grid gap-8 md:grid-cols-4 xl:grid-cols-[1.2fr_repeat(7,1fr)]">
          <div>
            <Link href="/" className="inline-flex h-11 items-center rounded-lg text-lg">
              <WizardWordmark />
            </Link>
          </div>

          <ul className="grid grid-cols-2 gap-x-4 text-sm text-muted-foreground md:hidden">
            {TOOL_GROUPS.map((g) => (
              <li key={g}>
                <Link href={`/tools?c=${g}`} className={`flex h-11 items-center ${LINK}`}>
                  {CATEGORY_LABELS[g]}
                </Link>
              </li>
            ))}
          </ul>

          {TOOL_GROUPS.map((g) => (
            <div key={g} className="hidden md:block">
              <p className="mb-3 text-sm font-semibold">{CATEGORY_LABELS[g]}</p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {TOOLS.filter((t) => groupOf(t.category) === g).map((t) => (
                  <li key={t.slug}>
                    <Link href={`/tools/${t.slug}`} className={`inline-block py-1 pointer-coarse:py-3 ${LINK}`}>
                      {t.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-border">
        <div className="container flex flex-col items-center justify-between gap-2 py-4 text-sm text-muted-foreground lg:flex-row">
          <p>© {new Date().getFullYear()} {BUSINESS.name}</p>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap justify-center">
              {BOTTOM_LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`flex h-11 items-center px-2 ${LINK}`}>
                    {l.label}
                  </Link>
                </li>
              ))}
              {GA_ID && (
                <li>
                  <CookieSettingsButton className={`flex h-11 items-center px-2 ${LINK}`} />
                </li>
              )}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
