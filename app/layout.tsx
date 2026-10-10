import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { siteUrl } from "@/lib/site";
import { GA_ID, consentBootstrapScript } from "@/lib/analytics";
import { MotionProvider } from "@/components/motion/primitives";
import { SkipLink } from "@/components/SkipLink";
import { Analytics } from "@/components/analytics/Analytics";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "PDF Wizard: cast spells on your PDFs",
    template: "%s | PDF Wizard",
  },
  description:
    "Edit and convert PDFs and slides in your browser. Save videos as MP4 or MP3. Free, no sign-up.",
  keywords: [
    "PDF editor",
    "merge PDF",
    "split PDF",
    "compress PDF",
    "PDF to JPG",
    "sign PDF",
    "watermark PDF",
    "PPTX to PDF",
    "Google Slides to PDF",
  ],
  openGraph: {
    title: "PDF Wizard: cast spells on your PDFs",
    description:
      "A complete PDF toolkit: merge, split, compress, convert, edit, and sign. Free and private.",
    type: "website",
  },
  verification: siteVerification(),
};

/** Search Console and Bing Webmaster Tools meta tags, only when set. */
function siteVerification(): Metadata["verification"] {
  const google = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim();
  const bing = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION?.trim();
  if (!google && !bing) return undefined;
  return {
    ...(google ? { google } : {}),
    ...(bing ? { other: { "msvalidate.01": bing } } : {}),
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen font-sans">
        {GA_ID && (
          // Consent Mode defaults (all denied) before any Google tag can load.
          <Script id="consent-default" strategy="beforeInteractive">
            {consentBootstrapScript()}
          </Script>
        )}
        <SkipLink />
        {GA_ID && <Analytics gaId={GA_ID} />}
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
