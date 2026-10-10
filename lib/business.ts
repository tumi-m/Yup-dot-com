/**
 * Who runs the site, for the legal pages, the contact page and the footer.
 * Paystack's activation review and POPIA (section 18) both expect a name, an
 * email and a physical address on the site.
 *
 * Set in the environment (NEXT_PUBLIC_*, so inlined at build time; redeploy
 * after a change). In development a missing detail shows as an obvious
 * placeholder, so the gap is visible; in production it is left out.
 */

export interface BusinessEnv {
  NEXT_PUBLIC_BUSINESS_NAME?: string;
  NEXT_PUBLIC_LEGAL_NAME?: string;
  NEXT_PUBLIC_CONTACT_EMAIL?: string;
  NEXT_PUBLIC_CONTACT_PHONE?: string;
  NEXT_PUBLIC_BUSINESS_ADDRESS?: string;
}

export type BusinessDetail = "legalName" | "email" | "phone" | "address";

export interface Business {
  /** Trading name. Always set: "PDF Wizard" unless overridden. */
  name: string;
  /** The person or company legally responsible (POPIA's "responsible party"). */
  legalName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** Details showing a development placeholder. Always empty in production. */
  placeholders: BusinessDetail[];
}

export const DEFAULT_BUSINESS_NAME = "PDF Wizard";

const PLACEHOLDER: Record<BusinessDetail, string> = {
  legalName: "[NEXT_PUBLIC_LEGAL_NAME]",
  email: "contact@example.com",
  phone: "[NEXT_PUBLIC_CONTACT_PHONE]",
  address: "[NEXT_PUBLIC_BUSINESS_ADDRESS]",
};

/** Trimmed, single-spaced, at most `max` characters; empty → null. */
function clean(value: string | undefined, max = 200): string | null {
  const v = (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return v || null;
}

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

function cleanEmail(value: string | undefined): string | null {
  const v = clean(value, 254);
  return v && EMAIL_RE.test(v) ? v : null;
}

/** Digits, spaces, +, -, ( and ) only; at least 7 digits. */
function cleanPhone(value: string | undefined): string | null {
  const v = clean(value, 40);
  if (!v || !/^[+\d\s()-]+$/.test(v)) return null;
  return v.replace(/\D/g, "").length >= 7 ? v : null;
}

export function resolveBusiness(env: BusinessEnv, dev: boolean): Business {
  const found = {
    legalName: clean(env.NEXT_PUBLIC_LEGAL_NAME),
    email: cleanEmail(env.NEXT_PUBLIC_CONTACT_EMAIL),
    phone: cleanPhone(env.NEXT_PUBLIC_CONTACT_PHONE),
    address: clean(env.NEXT_PUBLIC_BUSINESS_ADDRESS, 300),
  };
  const placeholders: BusinessDetail[] = [];
  if (dev) {
    for (const key of Object.keys(found) as BusinessDetail[]) {
      if (!found[key]) {
        found[key] = PLACEHOLDER[key];
        placeholders.push(key);
      }
    }
  }
  return { name: clean(env.NEXT_PUBLIC_BUSINESS_NAME, 80) ?? DEFAULT_BUSINESS_NAME, ...found, placeholders };
}

/** "tel:" href for a display number: "+27 82 123 4567" → "tel:+27821234567". */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

// Each variable is named in full so Next.js inlines it into client bundles.
export const BUSINESS: Business = resolveBusiness(
  {
    NEXT_PUBLIC_BUSINESS_NAME: process.env.NEXT_PUBLIC_BUSINESS_NAME,
    NEXT_PUBLIC_LEGAL_NAME: process.env.NEXT_PUBLIC_LEGAL_NAME,
    NEXT_PUBLIC_CONTACT_EMAIL: process.env.NEXT_PUBLIC_CONTACT_EMAIL,
    NEXT_PUBLIC_CONTACT_PHONE: process.env.NEXT_PUBLIC_CONTACT_PHONE,
    NEXT_PUBLIC_BUSINESS_ADDRESS: process.env.NEXT_PUBLIC_BUSINESS_ADDRESS,
  },
  process.env.NODE_ENV === "development"
);

/** When the legal pages last changed (YYYY-MM-DD). Update it with every material change. */
export const LEGAL_UPDATED = "2026-10-10";
