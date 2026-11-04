import {
  CardGrid,
  EmptyState,
  PageHeader,
  Pager,
  ScreenCard,
} from "@/components/gallery";
import { FilterRows } from "@/components/filter-rows";
import { api } from "@/lib/api";
import { kindLabel, plural } from "@/lib/format";

export const metadata = { title: "Screens" };

const PAGE_SIZE = 30;

/** The vocabularies worth filtering screens by, in the order they are shown. */
const FACET_ORDER = [
  "screen_type",
  "page_type",
  "ux_pattern",
  "ui_pattern",
  "component",
  "state",
  "function",
  "industry",
  "design_style",
];

/**
 * Every published screen, filterable by device and pattern.
 *
 * Every filter is a query parameter, so a filtered view is a URL that can be
 * shared and works without JavaScript.
 */
export default async function ScreensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const many = (key: string): string[] => {
    const value = params[key];
    return Array.isArray(value) ? value : value ? [value] : [];
  };

  const page = Math.max(1, Number(single("page") ?? 1) || 1);
  const terms = many("term");
  const q = single("q");
  const sourceSlug = single("source");
  const device = single("device");
  const sort: "recent" | "title" =
    single("sort") === "title" ? "title" : "recent";

  const [results, facets] = await Promise.all([
    api.listScreens({
      q,
      source: sourceSlug,
      term: terms,
      device,
      sort,
      page,
      pageSize: PAGE_SIZE,
    }),
    api.listFacets(),
  ]);

  const withParams = (
    changes: Record<string, string | string[] | undefined>,
  ): string => {
    const next = new URLSearchParams();
    const base: Record<string, string | string[] | undefined> = {
      q,
      source: sourceSlug,
      device,
      sort: sort === "recent" ? undefined : sort,
      term: terms,
      ...changes,
    };
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined || value === "") continue;
      if (Array.isArray(value))
        for (const item of value) next.append(key, item);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `/screens?${query}` : "/screens";
  };

  const toggleTerm = (slug: string): string =>
    withParams({
      term: terms.includes(slug)
        ? terms.filter((t) => t !== slug)
        : [...terms, slug],
      page: undefined,
    });

  const activeCount =
    terms.length + (q ? 1 : 0) + (sourceSlug ? 1 : 0) + (device ? 1 : 0);
  const totalPages = Math.max(1, Math.ceil(results.total / PAGE_SIZE));
  const groups = facets
    .filter(
      (group) => FACET_ORDER.includes(group.kind) && group.terms.length > 0,
    )
    .sort((a, b) => FACET_ORDER.indexOf(a.kind) - FACET_ORDER.indexOf(b.kind));

  return (
    <>
      <PageHeader
        label={q ? "Search" : plural(results.total, "website")}
        title={q ? `“${q}”` : "Screens"}
        note={
          q
            ? `${plural(results.total, "website")} match your search.`
            : "Browse every website. Hover one to visit the real site."
        }
      />

      <FilterRows
        activeCount={activeCount}
        clearHref="/screens"
        rows={[
          {
            label: "Device",
            options: [
              {
                label: "All",
                href: withParams({ device: undefined, page: undefined }),
                active: !device,
              },
              {
                label: "Desktop",
                href: withParams({ device: "desktop", page: undefined }),
                active: device === "desktop",
              },
              {
                label: "Mobile",
                href: withParams({ device: "mobile", page: undefined }),
                active: device === "mobile",
              },
            ],
          },
          {
            label: "Sort",
            options: [
              {
                label: "Recent",
                href: withParams({ sort: undefined }),
                active: sort === "recent",
              },
              {
                label: "A–Z",
                href: withParams({ sort: "title" }),
                active: sort === "title",
              },
            ],
          },
          ...groups.map((group) => ({
            label: kindLabel(group.kind),
            options: group.terms.map((entry) => ({
              label: entry.term.name,
              href: toggleTerm(entry.term.slug),
              count: entry.count,
              active: terms.includes(entry.term.slug),
              title: entry.term.description ?? undefined,
            })),
          })),
        ]}
      />

      {results.items.length === 0 ? (
        <EmptyState title="Nothing matches">
          Try removing a filter or two.
        </EmptyState>
      ) : (
        <CardGrid columns={3}>
          {results.items.map((item, index) => (
            <ScreenCard key={item.id} item={item} priority={index < 3} />
          ))}
        </CardGrid>
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        href={(target) =>
          withParams({ page: target === 1 ? undefined : String(target) })
        }
      />
    </>
  );
}
