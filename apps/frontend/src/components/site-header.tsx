"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The full set of section links, desktop and phone. Off for launch; only
 * Screens is shown. Search is off too — `SearchCommand` is kept, and goes
 * back next to `ThemeToggle` to bring it back.
 */
const SHOW_NAV = false;

/**
 * Where the bar points: the three column lines the first fold is set on
 * (1, 5 and 9). Each gets a small notch under the bar, so the header and the
 * page below it read as one grid. On phones there is one column, so one notch.
 */
const NOTCHES = [
  "col-start-1",
  "hidden md:block md:col-start-5",
  "hidden md:block md:col-start-9",
];

/**
 * The header: a solid brand-red bar on the page grid. The wordmark sits on
 * column 1, Screens on column 5, the theme switch at the far end.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const anyActive = NAV.some((item) => isActive(item.href));

  return (
    <header className="sticky top-0 z-40 bg-nav text-nav-foreground">
      <div className="page-grid h-12 items-center">
        <Link
          href="/"
          aria-label="Stealth.design home"
          className="col-span-2 flex items-center md:col-span-4"
        >
          <Wordmark height={20} />
        </Link>

        {SHOW_NAV ? (
          <nav
            className="col-span-6 hidden grid-cols-6 gap-6 md:grid"
            aria-label="Sections"
          >
            {NAV.slice(0, 3).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={cn(
                  "t-nav col-span-2 w-fit transition-opacity",
                  anyActive && !isActive(item.href)
                    ? "opacity-60 hover:opacity-100"
                    : "hover:opacity-70",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : (
          <nav className="col-span-1 md:col-span-4" aria-label="Sections">
            <Link
              href="/screens"
              aria-current={isActive("/screens") ? "page" : undefined}
              className={cn(
                "t-nav relative w-fit transition-opacity hover:opacity-70",
                // The page you are on is underlined, not dimmed: one link has
                // nothing to be dimmed against.
                isActive("/screens") &&
                  "underline decoration-1 underline-offset-[6px]",
              )}
            >
              Screens
            </Link>
          </nav>
        )}

        <div className="col-span-1 flex items-center justify-end gap-1.5 md:col-span-4">
          <ThemeToggle className="text-nav-foreground hover:bg-white/10 hover:text-nav-foreground aria-expanded:bg-white/10 aria-expanded:text-nav-foreground dark:hover:bg-white/10" />
          {SHOW_NAV ? (
            <Sheet>
              <SheetTrigger asChild>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center md:hidden"
                  aria-label="Open menu"
                >
                  <Menu className="size-5" />
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-full max-w-sm">
                <SheetHeader>
                  <SheetTitle>
                    <Wordmark height={20} />
                  </SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col px-4" aria-label="Sections">
                  {NAV.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "border-b py-4 text-3xl font-semibold tracking-[-0.04em] uppercase",
                        !isActive(item.href) && "text-muted-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          ) : null}
        </div>
      </div>

      {/* The notches: drawn below the bar, pointing down at the columns. */}
      <div
        aria-hidden
        className="page-grid pointer-events-none absolute inset-x-0 top-full"
      >
        {NOTCHES.map((placement) => (
          <span
            key={placement}
            className={cn("col-span-1 row-start-1", placement)}
          >
            <span className="ml-3 block size-0 border-x-[9px] border-t-[9px] border-x-transparent border-t-nav" />
          </span>
        ))}
      </div>
    </header>
  );
}
