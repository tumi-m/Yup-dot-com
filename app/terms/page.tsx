import type { Metadata } from "next";
import Link from "next/link";
import { BUSINESS } from "@/lib/business";
import { PLANS, TEAM_SEATS, formatPrice, prepaidPrice } from "@/lib/plans";
import { ContactList, EmailLink, Fill, LegalPage, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The rules for using PDF Wizard: accounts, acceptable use, plans, billing, renewal and cancellation.",
  alternates: { canonical: "/terms" },
};

const S = {
  service: "The service",
  account: "Your account",
  use: "Acceptable use",
  media: "Video and audio downloads",
  files: "Your files",
  ai: "The AI assistant",
  billing: "Plans, billing and renewal",
  cancel: "Cancelling and refunds",
  free: "Free use and limits",
  ip: "Our intellectual property",
  others: "Other services",
  availability: "Availability and changes",
  disclaimers: "Disclaimers",
  liability: "Limitation of liability",
  ending: "Suspension and closing accounts",
  copyright: "Copyright complaints",
  law: "Governing law",
  changes: "Changes to these terms",
  contact: "Contact",
} as const;

export default function TermsPage() {
  const b = BUSINESS;
  const pro = PLANS.pro;
  const team = PLANS.team;
  return (
    <LegalPage
      title="Terms of service"
      lead={
        <p>
          These terms are the agreement between you and{" "}
          {b.legalName ? (
            <>
              <Fill field="legalName">{b.legalName}</Fill>, trading as {b.name}
            </>
          ) : (
            b.name
          )}{" "}
          (&quot;we&quot;, &quot;us&quot;) for using {b.name}. By using the site, you accept them.
        </p>
      }
      toc={Object.entries(S)}
    >
      <Section id="service" title={S.service}>
        <p>
          {b.name} offers PDF and PowerPoint tools that run in your browser, a PDF editor, a cloud library for account
          holders, an AI assistant for PDFs, Google Slides downloads, and video and audio downloads from YouTube and X.
          Some features need an account or a paid plan.
        </p>
      </Section>

      <Section id="account" title={S.account}>
        <ul>
          <li>Use a real email address and keep your password safe. You&apos;re responsible for activity on your account.</li>
          <li>An account is for one person. Team plans have seats for others.</li>
          <li>You must be 18 or older, or have a parent&apos;s or guardian&apos;s permission.</li>
          <li>Tell us straight away if you think someone else is using your account.</li>
        </ul>
      </Section>

      <Section id="use" title={S.use}>
        <p>Don&apos;t use the service to:</p>
        <ul>
          <li>break the law, or process content you have no right to use;</li>
          <li>infringe copyright or other rights, including by downloading media you don&apos;t have permission to download;</li>
          <li>upload malware, or try to break, overload or get around our security, limits or payment checks;</li>
          <li>scrape, resell or offer the service as your own without our written permission;</li>
          <li>create or share content that is illegal, abusive, or exploits children.</li>
        </ul>
        <p>We may remove content, limit features or suspend accounts that break these rules.</p>
      </Section>

      <Section id="media" title={S.media}>
        <ul>
          <li>
            <strong>Only download videos and audio you own or have the right to download</strong>, such as your own
            uploads or content whose licence allows it.
          </li>
          <li>
            YouTube, X and other platforms have their own terms, which may forbid downloading. You&apos;re responsible
            for following them and copyright law.
          </li>
          <li>
            We don&apos;t host or check the content. We fetch it at your request and delete it from our servers soon
            after.
          </li>
          <li>Downloads depend on those platforms and may stop working without notice.</li>
        </ul>
      </Section>

      <Section id="files" title={S.files}>
        <p>
          Your files stay yours. Files you open in the browser tools never reach us. For files you save to your library
          or send to the AI assistant, you let us store and process them only to provide the service to you. Keep your
          own copies: don&apos;t treat the library as your only backup. Our{" "}
          <Link href="/privacy">Privacy policy</Link> explains how we handle personal information.
        </p>
      </Section>

      <Section id="ai" title={S.ai}>
        <p>
          Answers come from an AI model and can be wrong or incomplete. Check important facts against the document.
          Answers are not legal, medical, financial or other professional advice.
        </p>
      </Section>

      <Section id="billing" title={S.billing}>
        <ul>
          <li>
            Prices are in South African rand (ZAR), and Paystack processes payments on its own secure checkout. We never
            see or store your card number.
          </li>
          <li>
            Prices shown in other currencies are estimates. You pay the rand amount; your bank converts it and may
            charge fees.
          </li>
          <li>
            {pro.name} is {formatPrice(pro.priceMonthly)} a month. {team.name} is {formatPrice(team.priceMonthly)} a
            month for {TEAM_SEATS} people (you and {TEAM_SEATS - 1} others).
          </li>
          <li>
            <strong>Monthly subscriptions renew automatically</strong>: Paystack charges the same card every month until
            you cancel. Subscriptions are card only.
          </li>
          <li>
            <strong>Pay-once plans</strong> (1 month, or 1 year for the price of 10 months, such as{" "}
            {formatPrice(prepaidPrice("pro", 12))} for a year of {pro.name}) give you the plan until the end of the term
            and don&apos;t renew.
          </li>
          <li>If a renewal fails, your account moves to Free after a short grace period unless you update your card.</li>
          <li>
            We may change prices. We&apos;ll tell subscribers at least 30 days before a new price applies to their next
            renewal, so you can cancel first.
          </li>
        </ul>
      </Section>

      <Section id="cancel" title={S.cancel}>
        <p>
          Cancel anytime from the <Link href="/settings/billing">Billing</Link> page. You keep paid features until the
          end of the period you&apos;ve paid for. Refunds follow our <Link href="/refunds">Refund policy</Link>.
        </p>
      </Section>

      <Section id="free" title={S.free}>
        <p>
          The tools are free to use with limits, such as file size, batch size, edits, AI answers and downloads per day.
          The current limits are on the <Link href="/pricing">Pricing</Link> page. We may change free limits at any
          time.
        </p>
      </Section>

      <Section id="ip" title={S.ip}>
        <p>
          The site, its software and design, and the {b.name} name and logo belong to us or our licensors. You may use
          the service as offered, but not copy, modify or reverse-engineer it, except where the law allows.
        </p>
      </Section>

      <Section id="others" title={S.others}>
        <p>
          The service relies on other providers, including Paystack, Supabase, Vercel, Ollama and Google, and fetches
          content from sites such as YouTube, X and Google Slides at your request. We aren&apos;t responsible for their
          content, availability or terms.
        </p>
      </Section>

      <Section id="availability" title={S.availability}>
        <p>
          We work to keep the service running, but we don&apos;t promise it will always be available or error-free, or
          that every file will convert perfectly. We may change, add or remove features. If we remove a paid feature you
          rely on, you can ask for a refund of your unused paid time.
        </p>
      </Section>

      <Section id="disclaimers" title={S.disclaimers}>
        <p>
          Apart from what these terms promise and what the law requires, the service is provided &quot;as is&quot;.
          Check results before relying on them, especially for signed, legal or financial documents.
        </p>
      </Section>

      <Section id="liability" title={S.liability}>
        <p>
          As far as the law allows, we aren&apos;t liable for indirect or consequential loss, lost profits or lost data,
          and our total liability for any claim is limited to what you paid us in the 12 months before it. Nothing in
          these terms limits liability for gross negligence or fraud, or anything else the law, including the Consumer
          Protection Act, doesn&apos;t allow us to limit.
        </p>
      </Section>

      <Section id="ending" title={S.ending}>
        <p>
          You can stop using the service and ask us to close your account at any time. We may suspend or close an
          account that breaks these terms or the law, or to protect the service or other people. If we close your
          account when you haven&apos;t broken these terms, we&apos;ll refund your unused paid time.
        </p>
      </Section>

      <Section id="copyright" title={S.copyright}>
        <p>
          If you believe content handled through {b.name} infringes your copyright,{" "}
          {b.email ? (
            <>
              email <EmailLink subject="Copyright complaint" />
            </>
          ) : (
            "contact us"
          )}{" "}
          with your contact details, the work, where the infringing material is (for example its link), and a statement
          that the information is accurate and that you own the rights or may act for the owner. We&apos;ll respond
          promptly.
        </p>
      </Section>

      <Section id="law" title={S.law}>
        <p>
          These terms are governed by the law of the Republic of South Africa, and South African courts have
          jurisdiction. If you&apos;re a consumer, you keep your rights under the Consumer Protection Act and the
          Electronic Communications and Transactions Act, and any consumer rights where you live that can&apos;t be
          excluded.
        </p>
      </Section>

      <Section id="changes" title={S.changes}>
        <p>
          We may update these terms. We&apos;ll change the date at the top and, for important changes, tell account
          holders before they apply. If you keep using the service after that, the new terms apply. If you don&apos;t
          agree, stop using it and cancel any subscription.
        </p>
      </Section>

      <Section id="contact" title={S.contact}>
        <ContactList />
      </Section>
    </LegalPage>
  );
}
