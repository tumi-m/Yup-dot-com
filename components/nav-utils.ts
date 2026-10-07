/** A nav link is active on its own page and on any page beneath it. */
export function isNavActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
