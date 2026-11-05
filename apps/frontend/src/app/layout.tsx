import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter_Tight } from "next/font/google";
import { Providers } from "@/components/providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";
import "./globals.css";

/**
 * Two faces: one grotesk for everything, one mono for annotation. Both are
 * self-hosted by `next/font` at build time, so the CSP's `font-src 'self'`
 * still holds.
 *
 * Inter Tight stands in for a licensed grotesk (Founders Grotesk is the
 * reference): tight caps, a light weight that reads well large. Swapping it
 * is one line here once a licence is in hand.
 */
const grotesk = Inter_Tight({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-grotesk",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-mono-face",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Stealth.design | Website inspiration",
    template: "%s | Stealth.design",
  },
  description:
    "The best first impressions on the web. Find ideas, then visit the real site.",
  applicationName: "Stealth.design",
  // Deliberate for this build. See `robots.ts` for the reasoning.
  robots: { index: false, follow: false },
};

/** The public shell: header, page, footer. */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("dark", grotesk.variable, mono.variable)}
    >
      <body className="min-h-dvh" suppressHydrationWarning>
        <Providers>
          <SiteHeader />
          <main>{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
