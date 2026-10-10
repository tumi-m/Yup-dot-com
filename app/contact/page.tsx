import type { Metadata } from "next";
import { Clock, Mail, MapPin, Phone } from "lucide-react";
import { BUSINESS, telHref } from "@/lib/business";
import { Fill, LegalPage } from "@/components/legal/LegalPage";
import { ContactForm } from "@/components/legal/ContactForm";

export const metadata: Metadata = {
  title: "Contact",
  description: "Email, phone and address for PDF Wizard: support, billing, refunds, privacy and copyright.",
  alternates: { canonical: "/contact" },
};

const ROW = "flex items-start gap-3";
const ICON = "mt-1 h-4 w-4 shrink-0 text-primary";

export default function ContactPage() {
  const b = BUSINESS;
  const phonePlaceholder = b.placeholders.includes("phone");
  return (
    <LegalPage title="Contact" updated={false}>
      <ul className="!mt-8 !list-none space-y-3 !pl-0">
        {b.email && (
          <li className={ROW}>
            <Mail aria-hidden className={ICON} />
            <span>
              <span className="sr-only">Email: </span>
              <Fill field="email">
                <a href={`mailto:${b.email}`}>{b.email}</a>
              </Fill>
            </span>
          </li>
        )}
        {b.phone && (
          <li className={ROW}>
            <Phone aria-hidden className={ICON} />
            <span>
              <span className="sr-only">Phone: </span>
              <Fill field="phone">{phonePlaceholder ? b.phone : <a href={telHref(b.phone)}>{b.phone}</a>}</Fill>
            </span>
          </li>
        )}
        {b.address && (
          <li className={ROW}>
            <MapPin aria-hidden className={ICON} />
            <span>
              <span className="sr-only">Address: </span>
              {b.legalName && (
                <>
                  <Fill field="legalName">{b.legalName}</Fill>
                  {b.legalName !== b.name && <> t/a {b.name}</>},{" "}
                </>
              )}
              <Fill field="address">{b.address}</Fill>
            </span>
          </li>
        )}
        <li className={ROW}>
          <Clock aria-hidden className={ICON} />
          <span>We reply within 2 working days (Monday to Friday, South African time).</span>
        </li>
      </ul>

      {b.email && <ContactForm email={b.email} name={b.name} />}
    </LegalPage>
  );
}
