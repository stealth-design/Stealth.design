import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted at build time, so the CSP's `font-src 'self'` still holds. The
// same faces as the public site: the CMS is the back room of the same house.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: "UX Disrupt CMS", template: "%s · UX Disrupt CMS" },
  description: "Design research content management and ingestion control centre.",
  // An internal tool should never be indexed, and this is cheaper and more
  // reliable than remembering to configure it at the edge.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The CMS is a dense desktop tool; zoom stays enabled for accessibility.
  colorScheme: "dark",
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      {/* Browser extensions (ColorZilla, Grammarly, password managers) write
          attributes onto <body> before React hydrates. This ignores attribute
          differences on this one element only — not its children. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
