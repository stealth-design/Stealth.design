import Link from "next/link";
import { NAV } from "@/lib/nav";

/**
 * The footer: one line of attribution and the sections, at the lowest light.
 *
 * The attribution is the one piece of copy here that is not negotiable —
 * every screenshot is someone else's product shown for reference, and saying
 * so plainly is part of behaving properly rather than part of the design.
 */
export function SiteFooter() {
  return (
    <footer className="mt-32">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6 px-5 py-10 text-[12px] text-faint md:flex-row md:items-start md:justify-between md:px-8">
        <p className="max-w-xl leading-relaxed">
          Every interface shown belongs to the company that made it, reproduced for reference and
          study. Entries are published by people after review; nothing appears automatically.
        </p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="transition-colors hover:text-lit">
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
