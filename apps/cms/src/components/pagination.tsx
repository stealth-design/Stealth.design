import Link from "next/link";
import clsx from "clsx";

/**
 * Offset pagination with a total count.
 *
 * The CMS uses page numbers and a total rather than infinite scroll, because
 * an operator working a backlog needs to know how big it is and be able to say
 * "I got to page 4". The public API uses cursors instead, where deep paging is
 * machine-driven and stability matters more than knowing the total.
 */
export function Pagination({
  basePath,
  page,
  pageSize,
  total,
  searchParams,
}: {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
  searchParams: Record<string, string | undefined>;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) {
    return total > 0 ? (
      <p className="text-2xs text-ink-500">
        {total.toLocaleString("en-US")} {total === 1 ? "row" : "rows"}
      </p>
    ) : null;
  }

  const hrefFor = (target: number): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "page" || value === undefined) continue;
      params.set(key, value);
    }
    if (target > 1) params.set("page", String(target));
    const query = params.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
  };

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="flex items-center justify-between gap-3" aria-label="Pagination">
      <p className="text-2xs text-ink-500">
        {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")} of{" "}
        {total.toLocaleString("en-US")}
      </p>
      <div className="flex items-center gap-1">
        <PageLink href={hrefFor(page - 1)} disabled={page <= 1}>
          Previous
        </PageLink>
        <span className="px-1.5 text-2xs tabular-nums text-ink-600">
          {page} / {pageCount}
        </span>
        <PageLink href={hrefFor(page + 1)} disabled={page >= pageCount}>
          Next
        </PageLink>
      </div>
    </nav>
  );
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded-[4px] border border-ink-200 px-2 py-0.5 text-2xs text-ink-300">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={clsx(
        "rounded-[4px] border border-ink-300 bg-surface px-2 py-0.5 text-2xs text-ink-700",
        "hover:bg-ink-100",
      )}
    >
      {children}
    </Link>
  );
}
