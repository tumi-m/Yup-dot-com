"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WizardWordmark } from "@/components/WizardLogo";
import { DUR, EASE_IN, EASE_OUT, SPRING_LAYOUT, STAGGER } from "@/components/motion/tokens";
import { isNavActive } from "@/components/nav-utils";
import { cn } from "@/lib/utils";

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The sticky header shared by the marketing pages and the signed-in area. Its
 * height never changes; scrolling only firms up the background. Below md the
 * links move into an overlay sheet that closes on Escape, outside tap and
 * navigation.
 */
export function NavShell({
  homeHref = "/",
  links,
  actions,
  mobileActions,
  mobileTop,
}: {
  homeHref?: string;
  links: NavLink[];
  /** Right side, md and up. */
  actions: React.ReactNode;
  /** Bottom of the mobile sheet. */
  mobileActions: React.ReactNode;
  /** Top of the mobile sheet, above the links. */
  mobileTop?: React.ReactNode;
}) {
  const pathname = usePathname();
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const sheetId = useId();
  const headerRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 12));

  // Close on navigation and on Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    // Tabbing out of the menu closes it, so focus never sits behind the backdrop.
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Node | null;
      if (t && !headerRef.current?.contains(t) && !sheetRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  return (
    <>
      <header
        ref={headerRef}
        className={cn(
          "sticky top-0 z-40 w-full border-b transition-[background-color,border-color,box-shadow] duration-300",
          scrolled || open
            ? "border-border/70 bg-background/85 shadow-sm backdrop-blur-xl"
            : // At the top only the hero sky is beneath; blurring it every frame buys nothing.
            "border-transparent bg-background/40"
        )}
      >
        <div className="container flex h-16 items-center justify-between">
          <Link
            href={homeHref}
            className="flex h-11 items-center rounded-lg text-lg transition-transform duration-200 hover:scale-[1.03] motion-reduce:hover:scale-100"
            onClick={() => setOpen(false)}
          >
            <WizardWordmark />
          </Link>

          <nav aria-label="Main" className="hidden items-center gap-1 text-sm md:flex" onMouseLeave={() => setHovered(null)}>
            {links.map((l) => {
              const active = isNavActive(pathname, l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  onMouseEnter={() => setHovered(l.href)}
                  className={cn(
                    "relative flex h-10 items-center rounded-full px-4 transition-colors pointer-coarse:h-11",
                    active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {hovered === l.href && (
                    <motion.span layoutId="nav-hover" className="absolute inset-0 rounded-full bg-accent" transition={SPRING_LAYOUT} />
                  )}
                  <span className="relative">{l.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="hidden items-center gap-2 md:flex">{actions}</div>

          <button
            ref={menuButton}
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground hover:bg-accent md:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={sheetId}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={open ? "x" : "menu"}
                initial={{ rotate: -90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: 90, opacity: 0 }}
                transition={{ duration: DUR.tap }}
                className="block"
              >
                {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
      </header>

      {/* A sibling of the header: its backdrop-filter would trap a fixed child. */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="sheet"
            ref={sheetRef}
            className="fixed inset-x-0 bottom-0 top-16 z-30 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN } }}
            transition={{ duration: DUR.base, ease: EASE_OUT }}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="absolute inset-0 h-full w-full cursor-default bg-background/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.nav
              id={sheetId}
              aria-label="Menu"
              initial={{ y: -8 }}
              animate={{ y: 0 }}
              transition={{ duration: DUR.base, ease: EASE_OUT }}
              className="relative border-b border-border bg-background shadow-xl shadow-primary/5"
            >
              <div className="container flex flex-col gap-1 py-4">
                {mobileTop}
                {links.map((l, i) => {
                  const active = isNavActive(pathname, l.href);
                  return (
                    <motion.div
                      key={l.href}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: DUR.base, ease: EASE_OUT, delay: (i + 1) * STAGGER }}
                    >
                      <Link
                        href={l.href}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex h-11 items-center rounded-lg px-3 font-medium hover:bg-accent",
                          active && "bg-accent text-accent-foreground"
                        )}
                      >
                        {l.label}
                      </Link>
                    </motion.div>
                  );
                })}
                <motion.div
                  className="mt-2"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: DUR.base, ease: EASE_OUT, delay: (links.length + 1) * STAGGER }}
                >
                  {mobileActions}
                </motion.div>
              </div>
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

const LINKS: NavLink[] = [
  { href: "/tools", label: "Tools" },
  { href: "/pricing", label: "Pricing" },
];

export function MarketingNav({ isAuthed }: { isAuthed: boolean }) {
  return (
    <NavShell
      links={LINKS}
      actions={
        isAuthed ? (
          <Button asChild size="sm" className="pointer-coarse:h-11">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        ) : (
          <>
            <Button asChild variant="ghost" size="sm" className="pointer-coarse:h-11">
              <Link href="/login">Log in</Link>
            </Button>
            <Button asChild size="sm" className="shadow-md shadow-primary/25 pointer-coarse:h-11">
              <Link href="/tools">Start free</Link>
            </Button>
          </>
        )
      }
      mobileActions={
        isAuthed ? (
          <Button asChild className="h-11 w-full">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline" className="h-11">
              <Link href="/login">Log in</Link>
            </Button>
            <Button asChild className="h-11">
              <Link href="/tools">Start free</Link>
            </Button>
          </div>
        )
      }
    />
  );
}
