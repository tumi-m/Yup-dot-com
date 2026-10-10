import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { Starfield } from "@/components/landing/HeroScene";
import { getCurrentUser } from "@/lib/supabase/server";
import { BUSINESS, LEGAL_UPDATED, telHref, type BusinessDetail } from "@/lib/business";
import { formatBillingDate } from "@/lib/plans";

/**
 * Shared frame for /privacy, /terms, /refunds and /contact: the marketing
 * header and footer, a title, the date of the last change and, for long
 * pages, a list of sections.
 */
export async function LegalPage({
  title,
  lead,
  toc,
  updated = true,
  children,
}: {
  title: string;
  lead?: React.ReactNode;
  /** [id, heading] pairs, in page order. */
  toc?: [string, string][];
  updated?: boolean;
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main id="main" className="relative flex-1 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[320px] bg-gradient-to-b from-primary/10 to-transparent" />
        <Starfield className="h-[320px]" />
        <div className="container relative max-w-3xl py-14 sm:py-20">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
          {updated && (
            <p className="mt-3 text-sm text-muted-foreground">
              Last updated <time dateTime={LEGAL_UPDATED}>{formatBillingDate(`${LEGAL_UPDATED}T12:00:00Z`)}</time>
            </p>
          )}
          {lead && <div className="mt-6 text-lg leading-8">{lead}</div>}

          {toc && toc.length > 0 && (
            <nav aria-label="On this page" className="mt-8 rounded-2xl border border-border bg-card/80 p-4 sm:p-5">
              <p className="px-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">On this page</p>
              <ol className="mt-2 grid gap-x-4 text-sm sm:grid-cols-2">
                {toc.map(([id, heading]) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      className="flex min-h-11 items-center rounded-lg px-2 text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      {heading}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          <div className="legal mt-4">{children}</div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 id={id} className="scroll-mt-24">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * A business detail from the environment. In development a missing one shows
 * as a highlighted placeholder; in production the caller leaves it out.
 */
export function Fill({ field, children }: { field: BusinessDetail; children: React.ReactNode }) {
  if (!BUSINESS.placeholders.includes(field)) return <>{children}</>;
  return (
    <mark title="Development placeholder: set this in the environment" className="rounded bg-amber-200 px-1 text-amber-950">
      {children}
    </mark>
  );
}

/** The contact email as a link, or nothing when it isn't set. */
export function EmailLink({ subject }: { subject?: string }) {
  if (!BUSINESS.email) return null;
  const href = `mailto:${BUSINESS.email}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
  return (
    <Fill field="email">
      <a href={href}>{BUSINESS.email}</a>
    </Fill>
  );
}

export function PhoneLink() {
  if (!BUSINESS.phone) return null;
  return (
    <Fill field="phone">
      {BUSINESS.placeholders.includes("phone") ? BUSINESS.phone : <a href={telHref(BUSINESS.phone)}>{BUSINESS.phone}</a>}
    </Fill>
  );
}

/** Name, address, email and phone as a short list; missing lines are left out. */
export function ContactList({ subject }: { subject?: string }) {
  const b = BUSINESS;
  if (!b.legalName && !b.email && !b.phone && !b.address) return null;
  return (
    <ul>
      {b.legalName && (
        <li>
          Responsible person: <Fill field="legalName">{b.legalName}</Fill>
          {b.legalName !== b.name && <>, trading as {b.name}</>}
        </li>
      )}
      {b.email && (
        <li>
          Email: <EmailLink subject={subject} />
        </li>
      )}
      {b.phone && (
        <li>
          Phone: <PhoneLink />
        </li>
      )}
      {b.address && (
        <li>
          Address: <Fill field="address">{b.address}</Fill>
        </li>
      )}
    </ul>
  );
}
