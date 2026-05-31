import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://pdfwizard.app"),
  title: {
    default: "PDF Wizard — cast spells on your PDFs",
    template: "%s | PDF Wizard",
  },
  description:
    "Merge, split, compress, convert, edit, and sign PDFs right in your browser. A complete PDF toolkit — free, fast, and private.",
  keywords: [
    "PDF editor",
    "merge PDF",
    "split PDF",
    "compress PDF",
    "PDF to JPG",
    "sign PDF",
    "watermark PDF",
  ],
  openGraph: {
    title: "PDF Wizard — cast spells on your PDFs",
    description:
      "A complete PDF toolkit: merge, split, compress, convert, edit, and sign. Free and private.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
