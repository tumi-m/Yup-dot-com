import type { Metadata } from "next";
import Link from "next/link";
import { BUSINESS } from "@/lib/business";
import { ContactList, EmailLink, LegalPage, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Refund and cancellation policy",
  description: "Cancel anytime. How cancellations, pay-once plans and refunds work, and how long refunds take.",
  alternates: { canonical: "/refunds" },
};

const S = {
  cancel: "Cancelling a subscription",
  once: "Pay-once plans",
  delivery: "When paid features start",
  refunds: "Refunds",
  ask: "How to ask for a refund",
  timing: "When you get your money",
  rights: "Your rights",
  contact: "Contact",
} as const;

export default function RefundsPage() {
  const b = BUSINESS;
  return (
    <LegalPage
      title="Refunds and cancellation"
      lead={<p>Cancel anytime. Here&apos;s how cancelling and refunds work.</p>}
      toc={Object.entries(S)}
    >
      <Section id="cancel" title={S.cancel}>
        <ul>
          <li>Monthly Pro and Team subscriptions renew automatically each month on your card.</li>
          <li>
            Cancel anytime: <Link href="/settings/billing">Billing</Link> → Manage subscription → Cancel, on
            Paystack&apos;s page. The &quot;Manage subscription&quot; link in Paystack&apos;s emails works too, or ask us.
          </li>
          <li>
            You keep your plan until the end of the month you&apos;ve paid for. It then doesn&apos;t renew, and your
            account moves to Free. There&apos;s no cancellation fee.
          </li>
        </ul>
      </Section>

      <Section id="once" title={S.once}>
        <p>
          Paying once for 1 month or 1 year gives you the plan until that date. It never renews, so there&apos;s nothing
          to cancel.
        </p>
      </Section>

      <Section id="delivery" title={S.delivery}>
        <p>
          Paid features are digital and switch on as soon as your payment clears, usually within a minute. Your plan
          shows on the Billing page. If it doesn&apos;t, contact us with your payment reference.
        </p>
      </Section>

      <Section id="refunds" title={S.refunds}>
        <ul>
          <li>
            <strong>Changed your mind?</strong> Within 7 days of your first payment for a plan, if you haven&apos;t used
            any paid feature, we refund it in full.
          </li>
          <li>
            <strong>Charged twice, or after you cancelled?</strong> We refund the extra charge in full.
          </li>
          <li>
            <strong>Something didn&apos;t work?</strong> If a paid feature failed and we couldn&apos;t fix it, we refund
            the affected payment.
          </li>
          <li>
            Otherwise, once you&apos;ve used paid features, payments (including pay-once plans) aren&apos;t refundable,
            and we don&apos;t refund part of a month or the unused part of a year, except where the law requires it.
          </li>
        </ul>
      </Section>

      <Section id="ask" title={S.ask}>
        <p>
          {b.email ? (
            <>
              Email <EmailLink subject="Refund request" />
            </>
          ) : (
            "Contact us"
          )}{" "}
          from your account&apos;s email address with the date and amount, or the payment reference from your Paystack
          receipt, and why you&apos;re asking. We reply within 2 working days.
        </p>
      </Section>

      <Section id="timing" title={S.timing}>
        <ul>
          <li>We send approved refunds through Paystack within 5 working days of approving them.</li>
          <li>
            Refunds go back to the card or account you paid with. Your bank decides when it shows: card refunds usually
            appear within 5 to 10 working days.
          </li>
          <li>
            If a refund can&apos;t go back the way you paid (for example some EFT, Capitec Pay or Scan to Pay payments),
            we&apos;ll ask for your bank details and pay it by EFT.
          </li>
        </ul>
      </Section>

      <Section id="rights" title={S.rights}>
        <p>
          This policy doesn&apos;t limit your rights under the Consumer Protection Act or the Electronic Communications
          and Transactions Act. See also our <Link href="/terms">Terms of service</Link>.
        </p>
      </Section>

      <Section id="contact" title={S.contact}>
        <ContactList subject="Refund request" />
      </Section>
    </LegalPage>
  );
}
