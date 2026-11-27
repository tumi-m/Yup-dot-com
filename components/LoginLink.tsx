"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { returnLoginHref } from "@/components/auth-redirect";

/**
 * "Log in" that comes back to this page (see returnLoginHref). The query is
 * read after load, as the auth forms do, so static pages stay static.
 */
export function useLoginHref(explicit?: string): string {
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(window.location.search), [pathname]);
  return explicit ?? returnLoginHref(pathname, search);
}

export function LoginLink({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Link href={useLoginHref()} className={className}>
      {children}
    </Link>
  );
}
