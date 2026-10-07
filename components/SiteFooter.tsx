import Link from "next/link";
import { CATEGORY_LABELS, TOOLS } from "@/lib/tools";
import { WizardWordmark } from "@/components/WizardLogo";
import { groupOf, TOOL_GROUPS } from "@/components/tool-filter";

const LINK = "rounded transition-colors hover:text-foreground";

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
        <div className="container flex flex-col items-center justify-between gap-2 py-4 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} PDF Wizard</p>
          <div className="flex gap-2">
            <Link href="/tools" className={`flex h-11 items-center px-2 ${LINK}`}>All tools</Link>
            <Link href="/pricing" className={`flex h-11 items-center px-2 ${LINK}`}>Pricing</Link>
            <Link href="/login" className={`flex h-11 items-center px-2 ${LINK}`}>Log in</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
