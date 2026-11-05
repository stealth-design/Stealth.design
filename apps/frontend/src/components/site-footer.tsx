import Link from "next/link";
import { Wordmark } from "@/components/logo";
import { NAV } from "@/lib/nav";

/**
 * The footer, on the page grid: the one sentence, the sections, and the
 * attribution statement.
 *
 * The attribution is the one piece of copy here that is not negotiable —
 * every screenshot is someone else's product shown for reference, and saying
 * so plainly is part of behaving properly rather than part of the design.
 */
/** The section links. Off for launch, like the header's. */
const SHOW_NAV = false;

export function SiteFooter() {
  return (
    <footer className="mt-32 bg-ink text-ink-foreground md:mt-40">
      <div className="page-grid gap-y-12 pt-16 pb-10 md:pt-20">
        <div className="col-span-full md:col-span-4">
          <Link
            href="/"
            aria-label="Stealth.design home"
            className="inline-block hover:opacity-70"
          >
            <Wordmark height="clamp(3.5rem, 7vw, 6.5rem)" />
          </Link>
          <p className="t-lead mt-6 text-balance">
            The best first impressions on the web.
          </p>
          <p className="mt-4 text-[15px] font-light">
            Curated by{" "}
            <a
              href={process.env.STUDIO_STEALTH_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-nav underline-offset-4 hover:underline"
            >
              Studio Stealth
            </a>
          </p>
        </div>

        {SHOW_NAV ? (
          <nav
            className="col-span-2 flex flex-col gap-3 md:col-span-2 md:col-start-6"
            aria-label="Footer"
          >
            <p className="t-label mb-2 opacity-50">Explore</p>
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[15px] font-light hover:opacity-60"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}

        <div className="col-span-full space-y-4 text-[15px] leading-relaxed font-light opacity-70 md:col-span-4 md:col-start-9">
          <p className="t-label mb-2 opacity-70">About</p>
          <p>
            Every website shown here belongs to the people who made it. Names,
            logos and screenshots belong to their owners.
          </p>
        </div>

        <div className="t-label col-span-full flex flex-wrap justify-between gap-3 border-t border-ink-foreground/15 pt-6 opacity-50">
          <span>Stealth.design · Website inspiration</span>
          <span>© {new Date().getFullYear()} Stealth.design</span>
        </div>
      </div>
    </footer>
  );
}
