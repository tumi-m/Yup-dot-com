import type { Metadata } from "next";
import Link from "next/link";
import { BUSINESS } from "@/lib/business";
import { EmailLink, LegalPage, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Security",
  description: "How your files, account and payments are protected, how we test it, and how to report a security problem.",
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <LegalPage
      title="Security"
      updated={false}
      lead={<p>How {BUSINESS.name} protects your files and account, and how to report a problem.</p>}
    >
      <Section id="files" title="Your files">
        <ul>
          <li>Most tools run in your browser. Files you open in them are never uploaded.</li>
          <li>
            Your cloud library (only when you&apos;re signed in) is kept in private storage. Database rules let each
            account reach only its own documents and files.
          </li>
          <li>The AI assistant sends a document&apos;s text, not the file, and we don&apos;t store it.</li>
        </ul>
      </Section>

      <Section id="account" title="Your account and payments">
        <ul>
          <li>Passwords are handled by our sign-in provider and stored hashed. We can&apos;t read them.</li>
          <li>
            Paystack takes card details on its own page. We switch on a plan only after a payment notification signed
            by Paystack, or after checking the payment with Paystack ourselves.
          </li>
          <li>Plans can only be changed by our server, never from the browser.</li>
        </ul>
      </Section>

      <Section id="checks" title="How we check">
        <ul>
          <li>
            Every change runs automated tests that try to read or change another account&apos;s data, the way an
            attacker would, and a check that no secret key reaches the browser.
          </li>
          <li>Everything travels over HTTPS, and other sites can&apos;t embed our pages.</li>
        </ul>
      </Section>

      <Section id="report" title="Report a problem">
        <p>
          Found a vulnerability? Email <EmailLink subject="Security report" />
          {BUSINESS.email ? "" : <Link href="/contact">us</Link>} with the steps to reproduce it. We reply within 3
          working days. Please don&apos;t access other people&apos;s data or disrupt the service while testing.
        </p>
        <p>
          More detail is in our <Link href="/privacy#security">privacy policy</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
