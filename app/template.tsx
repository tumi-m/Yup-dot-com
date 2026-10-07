"use client";

import { useEffect } from "react";

// False until the first page has hydrated: the first paint never waits for an
// entrance, and only later client navigations fade their content in.
let navigated = false;

/**
 * Re-mounted on every navigation. Client navigations fade the new page's
 * <main> in with CSS (see .route-enter in globals.css); the header stays put.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const animate = navigated;
  useEffect(() => {
    navigated = true;
  }, []);
  return <div className={animate ? "route-enter" : undefined}>{children}</div>;
}
