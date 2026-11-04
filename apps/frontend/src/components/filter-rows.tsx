import Link from "next/link";
import { Filters, type FilterOption } from "@/components/gallery";

export interface FilterRow {
  readonly label: string;
  readonly options: readonly FilterOption[];
}

/**
 * Filter groups as rows on the page grid: the group's name in mono on the
 * first two columns, its tags from the third. A hairline between rows, and a
 * way out of every filter at once when any is on.
 */
export function FilterRows({
  rows,
  clearHref,
  activeCount,
}: {
  rows: readonly FilterRow[];
  clearHref: string;
  activeCount: number;
}) {
  const shown = rows.filter((row) => row.options.length > 0);
  if (shown.length === 0) return null;
  return (
    <div className="mb-16 md:mb-20">
      {shown.map((row) => (
        <div key={row.label} className="page-grid gap-y-3 border-t py-5">
          <p className="t-label col-span-full pt-2.5 text-muted-foreground md:col-span-2">
            {row.label}
          </p>
          <div className="col-span-full md:col-span-10 md:col-start-3">
            <Filters options={row.options} />
          </div>
        </div>
      ))}
      <div className="page-grid border-t pt-5">
        {activeCount > 0 ? (
          <p className="t-label col-span-full md:col-span-10 md:col-start-3">
            <Link
              href={clearHref}
              className="underline underline-offset-4 hover:opacity-60"
            >
              Clear {activeCount === 1 ? "1 filter" : `${activeCount} filters`}
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
