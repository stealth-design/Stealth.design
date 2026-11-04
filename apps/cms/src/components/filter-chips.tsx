import Link from "next/link";
import clsx from "clsx";

/**
 * Multi-select filter chips backed by the URL.
 *
 * Filter state lives in the query string rather than in component state, so a
 * filtered view is a shareable link and the browser's back button behaves. On
 * an operations tool where people say "look at this list" to each other, that
 * matters more than the interaction being fractionally snappier.
 */
export function FilterChips({
  basePath,
  paramName,
  active,
  options,
  searchParams,
}: {
  basePath: string;
  paramName: string;
  active: readonly string[];
  options: readonly { value: string; label: string; title?: string; count?: number }[];
  searchParams: Record<string, string | undefined>;
}) {
  const buildHref = (values: readonly string[]): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === paramName || key === "page" || value === undefined) continue;
      params.set(key, value);
    }
    if (values.length > 0) params.set(paramName, values.join(","));
    const query = params.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link
        href={buildHref([])}
        className={clsx(
          "rounded-[3px] px-2 py-0.5 text-2xs font-medium transition-colors",
          active.length === 0
            ? "bg-ink-800 text-ink-50"
            : "bg-ink-100 text-ink-600 hover:bg-ink-200",
        )}
      >
        All
      </Link>
      {options.map((option) => {
        const isActive = active.includes(option.value);
        // Clicking a chip toggles it, so several filters can stack.
        const next = isActive
          ? active.filter((value) => value !== option.value)
          : [...active, option.value];
        return (
          <Link
            key={option.value}
            href={buildHref(next)}
            title={option.title}
            className={clsx(
              "rounded-[3px] px-2 py-0.5 text-2xs font-medium transition-colors",
              isActive ? "bg-ink-800 text-ink-50" : "bg-ink-100 text-ink-600 hover:bg-ink-200",
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={clsx("ml-1 tabular-nums", isActive ? "text-ink-300" : "text-ink-400")}>
                {option.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
