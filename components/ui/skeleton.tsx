import Link from "next/link";
import { WizardWordmark } from "@/components/WizardLogo";
import { cn } from "@/lib/utils";

/** A placeholder block with a slow sheen (still under reduced motion). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-2xl bg-[linear-gradient(90deg,hsl(var(--secondary)),hsl(var(--accent)),hsl(var(--secondary)))] bg-[length:200%_100%] motion-safe:animate-skeleton",
        className
      )}
    />
  );
}

/** A thin indeterminate bar pinned to the top while a page loads. */
export function TopProgress() {
  return (
    <div
      role="progressbar"
      aria-label="Loading"
      className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/10"
    >
      <div className="h-full w-2/5 bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400 motion-safe:animate-progress" />
    </div>
  );
}

/**
 * The header's shape, without motion or state, for loading and error screens.
 * `bare` drops the action placeholders.
 */
export function NavSkeleton({ bare = false }: { bare?: boolean }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-transparent bg-background/40">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="flex h-11 items-center rounded-lg text-lg">
          <WizardWordmark />
        </Link>
        {!bare && (
          <>
            <div className="hidden items-center gap-2 md:flex">
              <Skeleton className="h-9 w-16 rounded-lg" />
              <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
            <Skeleton className="h-11 w-11 rounded-lg md:hidden" />
          </>
        )}
      </div>
    </header>
  );
}

/** Editor routes: a toolbar and a page, so opening a document never blanks. */
export function EditorSkeleton() {
  return (
    <div className="flex min-h-screen flex-col bg-secondary/40">
      <TopProgress />
      <div className="flex h-14 items-center gap-2 border-b border-border bg-background px-4">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-6 w-40 rounded-md" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-9 w-20 rounded-lg" />
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </div>
      <main id="main" aria-busy="true" className="flex flex-1 justify-center p-6">
        <Skeleton className="aspect-[1/1.414] w-full max-w-xl rounded-md" />
      </main>
    </div>
  );
}
