import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WizardWordmark } from "@/components/WizardLogo";

export function MarketingNav({ isAuthed }: { isAuthed: boolean }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="text-lg">
          <WizardWordmark />
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <Link href="/tools" className="hover:text-foreground">Tools</Link>
          <Link href="/#features" className="hover:text-foreground">Features</Link>
          <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
        </nav>
        <div className="flex items-center gap-2">
          {isAuthed ? (
            <Button asChild size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Log in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/signup">Get started</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
