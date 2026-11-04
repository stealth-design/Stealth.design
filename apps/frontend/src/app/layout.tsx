import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";
import "./globals.css";

/**
 * Geist for words, Geist Mono for numbers. Self-hosted by `next/font` at
 * build time, so the CSP's `font-src 'self'` still holds.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "UX Disrupt — a design research library", template: "%s — UX Disrupt" },
  description:
    "UX Disrupt is a reference library of captured product interfaces, organised by pattern, page type and product.",
  applicationName: "UX Disrupt",
  // Deliberate for this build. See `robots.ts` for the reasoning.
  robots: { index: false, follow: false },
};

/** The public shell. Dark, always: see `globals.css`. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("dark", geist.variable, geistMono.variable)}>
      {/* Browser extensions (ColorZilla, Grammarly, password managers) write
          attributes onto <body> before React hydrates. This ignores attribute
          differences on this one element only — not its children. */}
      <body className="flex min-h-dvh flex-col" suppressHydrationWarning>
        <Providers>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
