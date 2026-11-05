"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/logo";
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
 * The section links, desktop and phone. Off for launch: the header is the
 * wordmark alone. Search is off too: `SearchCommand` is kept and goes back
 * at the far end to bring it back.
 */
const SHOW_NAV = false;

/** The header: no bar, just the page, and the wordmark top-left. */
export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const anyActive = NAV.some((item) => isActive(item.href));

  return (
    <header className="relative z-40 bg-background text-foreground">
      <div className="page-grid h-16 items-center md:h-20">
        <Link
          href="/"
          aria-label="Stealth.design home"
          className="col-span-2 flex items-center hover:opacity-70 md:col-span-4"
        >
          <Wordmark height={22} />
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
        ) : null}

        {SHOW_NAV ? (
          <div className="col-span-1 flex items-center justify-end md:col-span-4">
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
          </div>
        ) : null}
      </div>
    </header>
  );
}
