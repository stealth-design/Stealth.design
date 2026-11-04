"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { SearchCommand } from "@/components/search-command";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The header: small and dim, so the eye goes past it to the screens.
 * The current section is the only lit link.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-8 px-5 md:px-8">
        <Link href="/" aria-label="UX Disrupt — home" className="text-lit transition-opacity hover:opacity-70">
          <Logo size={18} />
        </Link>

        <nav className="hidden items-center gap-6 md:flex" aria-label="Sections">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={cn(
                "text-[13px] transition-colors",
                isActive(item.href) ? "text-lit" : "text-dim hover:text-lit",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SearchCommand />
          <Sheet>
            <SheetTrigger asChild>
              <button
                type="button"
                className="flex size-8 items-center justify-center text-dim hover:text-lit md:hidden"
                aria-label="Open menu"
              >
                <Menu className="size-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 border-l-border bg-background">
              <SheetHeader>
                <SheetTitle>
                  <Logo size={18} />
                </SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-4" aria-label="Sections">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn("py-2 text-[15px]", isActive(item.href) ? "text-lit" : "text-dim")}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
