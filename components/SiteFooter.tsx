import Link from "next/link";
import { CATEGORY_LABELS, TOOLS, type ToolCategory } from "@/lib/tools";
import { WizardWordmark } from "@/components/WizardLogo";

const COLUMNS: ToolCategory[] = ["organize", "convert", "extract", "security", "edit", "media"];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="container grid gap-10 py-14 md:grid-cols-3 lg:grid-cols-[1.2fr_repeat(6,1fr)]">
        <div>
          <Link href="/" className="text-lg">
            <WizardWordmark />
          </Link>
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">
            A complete PDF toolkit that runs in your browser. Fast, free, and private.
          </p>
        </div>
        {COLUMNS.map((cat) => (
          <div key={cat}>
            <p className="mb-3 text-sm font-semibold">{CATEGORY_LABELS[cat]}</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {TOOLS.filter((t) => t.category === cat || (cat === "organize" && t.category === "optimize")).map((t) => (
                <li key={t.slug}>
                  <Link href={`/tools/${t.slug}`} className="transition-colors hover:text-foreground">
                    {t.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="container flex flex-col items-center justify-between gap-3 py-6 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} PDF Wizard. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="/tools" className="hover:text-foreground">All tools</Link>
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link href="/login" className="hover:text-foreground">Log in</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
