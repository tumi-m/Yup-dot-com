import type { ResolvingMetadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import Link from "next/link";
import { BUSINESS, SECURITY_EMAIL } from "@/lib/business";
import { LegalPage, Section } from "@/components/legal/LegalPage";

// Its own title and description on shared links too, not the home page's.
export function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return pageMetadata(
    {
      title: "Security",
      description: "How your files, account and payments are protected, how we test it, and how to report a security problem.",
      path: "/security",
    },
    parent
  );
}

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
            attacker would.
          </li>
          <li>
            Every build stops if a secret key would reach the browser, and every week an automatic check tests the
            live site from outside: our scripts, private pages and database, with only what any visitor has.
          </li>
          <li>
            Our pages only run our own scripts, so code slipped into a page can&apos;t run. Everything travels over
            HTTPS, and other sites can&apos;t embed our pages.
          </li>
        </ul>
      </Section>

      <Section id="report" title="Report a problem">
        <p>
          Found a vulnerability? Email{" "}
          <a href={`mailto:${SECURITY_EMAIL}?subject=${encodeURIComponent("Security report")}`}>{SECURITY_EMAIL}</a> with
          the steps to reproduce it. We reply within 3 working days. Please don&apos;t access other people&apos;s data
          or disrupt the service while testing. This address is also in{" "}
          <a href="/.well-known/security.txt">security.txt</a>.
        </p>
        <p>
          More detail is in our <Link href="/privacy#security">privacy policy</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
