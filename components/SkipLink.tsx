"use client";

/** First tab stop on every page: jumps past the header to the page's <main>. */
export function SkipLink() {
  return (
    <a
      href="#main"
      onClick={(e) => {
        const main = document.querySelector("main");
        if (!main) return;
        e.preventDefault();
        main.tabIndex = -1;
        main.focus();
      }}
      className="sr-only left-3 top-3 z-[60] rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-lg focus:not-sr-only focus:fixed focus:px-4 focus:py-3"
    >
      Skip to content
    </a>
  );
}
