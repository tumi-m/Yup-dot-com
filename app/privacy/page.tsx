import type { ResolvingMetadata } from "next";
import { HTML_TO_PDF_ENABLED } from "@/lib/web-pdf";
import { pageMetadata } from "@/lib/page-metadata";
import Link from "next/link";
import { BUSINESS } from "@/lib/business";
import { GA_ID } from "@/lib/analytics";
import { OFFICE_ENABLED } from "@/lib/office";
import { ContactList, EmailLink, Fill, LegalPage, Section } from "@/components/legal/LegalPage";
import { CookieSettingsButton } from "@/components/analytics/CookieSettingsButton";

// Its own title and description on shared links too, not the home page's.
export function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return pageMetadata(
    {
      title: "Privacy policy",
      description: "What we collect, why, who we share it with, and your rights under POPIA and GDPR.",
      path: "/privacy",
    },
    parent
  );
}

const S = {
  summary: "In short",
  who: "Who we are",
  collect: "What we collect and why",
  browser: "Files you open in the browser",
  basis: "Legal grounds",
  share: "Who we share it with",
  transfers: "Transfers outside South Africa",
  keep: "How long we keep it",
  security: "Security",
  rights: "Your rights",
  cookies: "Cookies and browser storage",
  children: "Children",
  emails: "Emails",
  changes: "Changes to this policy",
  contact: "Contact and complaints",
} as const;

export default function PrivacyPage() {
  const b = BUSINESS;
  return (
    <LegalPage
      title="Privacy policy"
      lead={
        <p>
          What {b.name} collects, why, who sees it, and your rights. Written for South Africa&apos;s Protection of Personal
          Information Act (POPIA), and for visitors from the EU and UK (GDPR).
        </p>
      }
      toc={Object.entries(S)}
    >
      <Section id="summary" title={S.summary}>
        <ul>
          <li>Most tools run in your browser. Those files never reach us.</li>
          <li>We store files only in your cloud library, which needs an account.</li>
          <li>The AI assistant and Translate PDF send a document&apos;s text, not the file, to our AI provider.</li>
          <li>Paystack handles payments. We never see your card number.</li>
          <li>Analytics cookies stay off unless you accept them.</li>
          <li>We don&apos;t sell your personal information.</li>
        </ul>
      </Section>

      <Section id="who" title={S.who}>
        {b.legalName ? (
          <p>
            {b.name} is run by <Fill field="legalName">{b.legalName}</Fill> (&quot;we&quot;, &quot;us&quot;), the
            responsible party for your personal information under POPIA and the controller under GDPR.{" "}
            <Fill field="legalName">{b.legalName}</Fill> is also our Information Officer.
          </p>
        ) : (
          <p>
            {b.name} (&quot;we&quot;, &quot;us&quot;) is the responsible party for your personal information under POPIA
            and the controller under GDPR.
          </p>
        )}
        <ContactList subject="Privacy" />
      </Section>

      <Section id="collect" title={S.collect}>
        <h3>Your account</h3>
        <p>
          Your email address, your password (stored hashed by our sign-in provider; we can&apos;t read it), your name if
          you give it, your plan and when you signed up. We use these to create your account, sign you in and send
          account emails such as the sign-up confirmation and password resets. An account needs an email address and a
          password; without them we can&apos;t create one. You don&apos;t need an account to use the tools.
        </p>

        <h3>Your cloud library</h3>
        <p>
          When you&apos;re signed in, PDFs you upload to your dashboard or open in the editor are saved to your library,
          with their name, size and page count, so you can open them again on any device. Each library is private to its
          account.
        </p>

        <h3>Payments</h3>
        <p>
          Paystack collects your card or bank details on its own checkout page. We keep your Paystack customer and
          subscription codes, your plan, its status and renewal or end date, and payment references, and for a
          subscription a one-way fingerprint of the card authorization it started with (it can&apos;t be used to charge
          you; it tells your subscription apart from someone else&apos;s). Paystack keeps the full payment record. We use these to give you what you paid for, handle renewals, cancellations and refunds,
          and keep the records South African tax law requires.
        </p>

        <h3>Team seats</h3>
        <p>If you own a Team plan: the email addresses you add, so those people get your plan when they sign in.</p>

        <h3>Tester codes</h3>
        <p>If you use a tester code: which code you used and when, and when your free tester time ends.</p>

        <h3 id="ai">The AI assistant and Translate PDF</h3>
        <p>
          When you use Chat with PDF, your browser extracts the document&apos;s text and sends it, with the file name and
          your questions, to our server, which passes them to Ollama, our AI provider, to write the answer. We don&apos;t
          store the text, your questions or the answers. Don&apos;t use the assistant on documents you aren&apos;t
          allowed to share with a third party.
        </p>
        <p>
          When you use Translate PDF, your browser extracts the document&apos;s text and sends it, a page&apos;s worth at
          a time with the languages you chose, to our server, which passes it to Ollama to translate. The file and its
          name aren&apos;t sent. We don&apos;t store the text or the translations; the Word file and PDF are made in your
          browser. Don&apos;t translate documents you aren&apos;t allowed to share with a third party.
        </p>

        <h3>Video and Slides links</h3>
        <p>
          When you download a video or import Google Slides, the link you paste goes to our server. For YouTube, our
          download server fetches the video and deletes the file automatically soon after you download it. For X
          (Twitter), our server looks the post up through X&apos;s public embed service and, if that fails, the public
          FxTwitter or vxTwitter services. For TikTok and Instagram, our server opens the public post the way a
          logged-out visitor would and passes the video on to you. For Google Slides, our server downloads the deck
          from Google. We don&apos;t store the links or the videos, apart from short-lived technical logs. Video
          previews load their thumbnail straight from the site the video is on.
        </p>

        {HTML_TO_PDF_ENABLED && (
          <>
            <h3>Web pages saved as PDF</h3>
            <p>
              When you use HTML to PDF, the web address you enter, or the HTML you upload or paste, goes to our media
              server, which opens it in a browser with no cookies or sign-in, the way a signed-out visitor would, and
              makes the PDF. The site you name sees a visit from our server, not from you. The PDF is deleted from our
              server as soon as you download it, or after about two minutes. We don&apos;t store the address, the HTML
              or the PDF, apart from short-lived technical logs that don&apos;t include them.
            </p>
          </>
        )}

        <h3>Sample Finder</h3>
        <p>
          When you look up a song, the link or text you enter goes to our server. For a YouTube link, our server asks
          YouTube&apos;s public oEmbed service for the video&apos;s title, channel and thumbnail; for a TikTok link it
          opens the public post as described above. We then search MusicBrainz, run by the MetaBrainz Foundation, using
          only the artist and song title. Your IP address is never sent to MusicBrainz. We keep looked-up songs and their
          connections for up to 30 days, and each video&apos;s title and channel (and a TikTok&apos;s sound) for 7 days,
          never who looked them up, so repeat lookups are fast. Thumbnails load straight from YouTube or TikTok.
        </p>

        <h3>Daily limits</h3>
        <p>
          To apply daily limits (for example AI answers, characters translated, downloads and song lookups), we count uses per account or, for visitors
          without an account, per salted one-way hash of the IP address. The counters never hold a raw IP address. Old
          counters are cleared automatically, usually within 40 days.
        </p>

        <h3>Prices in your currency</h3>
        <p>
          We use the country your IP address points to, supplied by our host, to show estimated prices in your
          currency. We don&apos;t store it.
        </p>

        <h3>Analytics, only if you accept</h3>
        <p>
          If you accept analytics cookies, Google Analytics records how the site is used: pages visited, approximate
          location, device and browser, and events such as a finished tool, a download, a sign-up, or a purchase (plan,
          amount and payment reference). We never send it your files, document text, name or email address.
        </p>

        <h3>Browser extension</h3>
        <p>
          Our X (Twitter) extension adds a Download button to posts with a video. It collects nothing, stores nothing
          and sends nothing. When you click Download, it opens our site with that post&apos;s link, and the rest works as
          described on this page.
        </p>

        <h3>Messages to us</h3>
        <p>If you contact us, we keep your message and our reply so we can help you.</p>

        <h3>Technical logs</h3>
        <p>
          Like any website, our hosting providers record basic request data, such as IP address, browser and time, in
          short-lived logs used for security and fixing errors.
        </p>
      </Section>

      <Section id="browser" title={S.browser}>
        <p>
          The PDF and PowerPoint tools (merge, compress, convert, OCR, sign and the rest) and Compress Video run on your
          device. Files you open in them are not uploaded to us. Making a downloaded video smaller, or turning it into
          MP3, also happens on your device. The editor does the same when you&apos;re signed out, keeping your work in
          your browser&apos;s storage so it survives a reload (clearing your browser data removes it). When you&apos;re
          signed in, it saves to your cloud library.
        </p>
        {OFFICE_ENABLED && (
          <p>
            Word to PDF and Excel to PDF are the exception: they upload the file you choose to our conversion server, where
            it is converted and then deleted, together with the PDF, as soon as the PDF has been sent back to you (or at
            once if converting fails or you cancel). We don&apos;t keep, read or reuse it. Its name isn&apos;t sent:
            only its contents, its size and its type.
          </p>
        )}
      </Section>

      <Section id="basis" title={S.basis}>
        <p>We only use personal information when the law allows it (POPIA section 11, GDPR article 6):</p>
        <ul>
          <li>
            <strong>To provide the service you asked for</strong> (contract): your account, library, plan, AI answers
            and downloads.
          </li>
          <li>
            <strong>To meet legal duties</strong>: keeping payment records for tax.
          </li>
          <li>
            <strong>Legitimate interests</strong>: keeping the service secure, preventing abuse through daily limits,
            fixing errors and showing local prices. You can object to these.
          </li>
          <li>
            <strong>Your consent</strong>: analytics cookies. You can withdraw it at any time.
          </li>
        </ul>
      </Section>

      <Section id="share" title={S.share}>
        <p>
          These service providers (&quot;operators&quot; under POPIA, &quot;processors&quot; under GDPR) handle personal
          information for us, only to provide their service:
        </p>
        <ul>
          <li>
            <strong>Vercel</strong>: hosts the website and runs our server code.
          </li>
          <li>
            <strong>Supabase</strong>: accounts, sign-in, our database and cloud library storage.
          </li>
          <li>
            <strong>Paystack</strong>: payments, subscriptions and refunds.
          </li>
          <li>
            <strong>Ollama</strong>: AI assistant answers and Translate PDF translations (document text, questions and the
            chosen languages only).
          </li>
          <li>
            <strong>Google</strong>: Google Analytics, only if you accept analytics cookies; and YouTube, whose oEmbed
            service our server asks for a video&apos;s title (video links only).
          </li>
          <li>
            <strong>Our video download host</strong>: a cloud provider that runs our YouTube download server (video
            links only){OFFICE_ENABLED && " and our document conversion server (the Word or Excel file you convert, while it is converted)"}
            {HTML_TO_PDF_ENABLED ? "; it also turns web pages into PDFs (the address or HTML you give it)" : ""}.
          </li>
          <li>
            <strong>Our email provider</strong>: sends account emails such as sign-up confirmations.
          </li>
        </ul>
        <p>
          The Sample Finder also searches <strong>MusicBrainz</strong> (the MetaBrainz Foundation), an open music
          database. It gets artist and song titles only, from our server, so nothing about you.
        </p>
        <p>
          We also share information when the law requires it, or to protect our rights or someone&apos;s safety. We
          don&apos;t sell personal information.
        </p>
      </Section>

      <Section id="transfers" title={S.transfers}>
        <p>
          Several of these providers are based in, or store data in, other countries, including the United States. When
          personal information leaves South Africa, we rely on the provider&apos;s data protection terms, which bind it to
          protect the information to a standard similar to POPIA (section 72), or on your consent where that applies.
          Ask us if you want details about a provider.
        </p>
      </Section>

      <Section id="keep" title={S.keep}>
        <ul>
          <li>
            <strong>Account details</strong>: while your account is open. We delete them within 30 days of your account
            being closed, except what the law makes us keep.
          </li>
          <li>
            <strong>Library files</strong>: until you delete them or your account is closed.
          </li>
          <li>
            <strong>Payment records</strong>: five years after the payment (in Paystack and our accounts), as South
            African tax law requires.
          </li>
          <li>
            <strong>Team seat emails</strong>: until the owner removes them or the account is closed.
          </li>
          <li>
            <strong>Daily limit counters</strong>: usually up to 40 days.
          </li>
          {OFFICE_ENABLED && (
            <li>
              <strong>Word and Excel files you convert</strong>: only while they are converted; deleted with the PDF as soon
              as it is sent to you.
            </li>
          )}
          {HTML_TO_PDF_ENABLED && (
            <li>
              <strong>Web pages saved as PDF</strong>: the address or HTML, and the PDF, only in our server&apos;s memory
              while the PDF is made; deleted as soon as it is sent to you, or after about two minutes if it isn&apos;t.
              The name of an HTML file you upload stays in your browser.
            </li>
          )}
          <li>
            <strong>Sample Finder cache</strong>: songs looked up and their connections, up to 30 days; the title and
            channel of videos read (and a TikTok&apos;s sound), 7 days; never who asked.
          </li>
          <li>
            <strong>Messages to us</strong>: as long as we need them to help you, and no more than two years.
          </li>
          <li>
            <strong>Analytics</strong>: no more than 14 months in Google Analytics.
          </li>
        </ul>
      </Section>

      <Section id="security" title={S.security}>
        <p>
          Everything travels over HTTPS. Database rules let each account reach only its own records and files, library
          files are private, secret keys stay on the server, and card numbers never reach our systems. No system is
          perfectly secure, though. If a breach affects your personal information, we&apos;ll tell you and the
          Information Regulator as soon as reasonably possible, as POPIA requires.
        </p>
      </Section>

      <Section id="rights" title={S.rights}>
        <p>You can ask us to:</p>
        <ul>
          <li>confirm whether we hold personal information about you, and give you a copy;</li>
          <li>correct or update it;</li>
          <li>delete it, or close your account;</li>
          <li>stop or limit using it, or object to how we use it;</li>
          <li>withdraw consent you gave, such as for analytics;</li>
          <li>give you your data in a format you can take elsewhere (GDPR).</li>
        </ul>
        <p>
          {b.email ? (
            <>
              Email <EmailLink subject="Privacy request" /> from the address on your account and say what you want.{" "}
            </>
          ) : (
            <>Contact us and say what you want. </>
          )}
          We may ask you to confirm who you are. It&apos;s free, and we&apos;ll reply within 30 days. You can delete
          library files yourself at any time from your{" "}
          <Link href="/dashboard">dashboard</Link>.
        </p>
      </Section>

      <Section id="cookies" title={S.cookies}>
        <h3>Always on (needed for the site to work)</h3>
        <ul>
          <li>
            <strong>sb-…-auth-token</strong> cookies (Supabase) keep you signed in. They last 30 days after your last
            visit and are removed when you sign out.
          </li>
          <li>
            <strong>pw-email-link</strong> (a cookie) holds the link from a sign-up or password reset email, for up to an hour,
            until you press Continue.
          </li>
          <li>
            <strong>pdfw-tester-code</strong> (browser storage, that tab only) keeps the code from a tester link until
            you use it.
          </li>
          <li>
            <strong>pdfw-consent</strong> (browser storage) remembers your cookie choice.
          </li>
          <li>
            <strong>pw-usage</strong> (browser storage) counts today&apos;s tasks, so we don&apos;t show you the same tip
            twice.
          </li>
          <li>
            <strong>pdf-wizard</strong> (browser database) holds files you&apos;re editing without an account and files
            passed between tools. It stays on your device.
          </li>
          <li>
            <strong>pdf-wizard:sent</strong> (browser storage, that tab only) lets a tool you were sent to from the
            home page start by itself. It&apos;s cleared when the tool opens.
          </li>
          <li>
            <strong>pw.media.smaller</strong> (browser storage) remembers whether you chose Smaller file for video
            downloads.
          </li>
          <li>
            <strong>pw.editor.shortcuts</strong> (browser storage) remembers whether the editor&apos;s one-key shortcuts
            are on.
          </li>
          <li>
            <strong>pdfw-web-pdf-options</strong> (browser storage) remembers the page size, margins and other options
            you last chose in HTML to PDF.
          </li>
        </ul>
        {GA_ID ? (
          <>
            <h3>Analytics (only if you accept)</h3>
            <ul>
              <li>
                <strong>_ga</strong> and <strong>_ga_{GA_ID.slice(2)}</strong> cookies (Google Analytics) tell visits
                apart. They last up to two years.
              </li>
              <li>
                <strong>pdfw-ga-purchases</strong> (browser storage) stops a purchase being counted twice.
              </li>
            </ul>
            <p>Declining or withdrawing consent deletes the Google Analytics cookies.</p>
            <p>
              <CookieSettingsButton className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground" />
            </p>
          </>
        ) : (
          <p>We don&apos;t use analytics or advertising cookies.</p>
        )}
      </Section>

      <Section id="children" title={S.children}>
        <p>
          {b.name} isn&apos;t meant for anyone under 18 without a parent&apos;s or guardian&apos;s permission. We
          don&apos;t knowingly collect children&apos;s personal information. If you think a child has given us some,
          contact us and we&apos;ll delete it.
        </p>
      </Section>

      <Section id="emails" title={S.emails}>
        <p>
          We email you only about your account and payments, such as sign-up confirmations and password resets. Paystack
          sends payment receipts and subscription notices. We won&apos;t send you marketing emails unless you opt in.
        </p>
      </Section>

      <Section id="changes" title={S.changes}>
        <p>
          When we change this policy, we update the date at the top. For important changes, we&apos;ll tell account
          holders by email or on the site before they apply.
        </p>
      </Section>

      <Section id="contact" title={S.contact}>
        <p>Questions and requests:</p>
        <ContactList subject="Privacy" />
        <p>
          If you&apos;re unhappy with how we handled your information, please tell us first. You can also complain to
          South Africa&apos;s Information Regulator at{" "}
          <a href="https://inforegulator.org.za" rel="noopener noreferrer">
            inforegulator.org.za
          </a>{" "}
          or{" "}
          <a href="mailto:POPIAComplaints@inforegulator.org.za">POPIAComplaints@inforegulator.org.za</a>. In the EU or
          UK, you can complain to your local data protection authority.
        </p>
      </Section>
    </LegalPage>
  );
}
