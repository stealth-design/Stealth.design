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

export const metadata = { title: "Browse" };

const PAGE_SIZE = 30;

const FACET_ORDER = [
  "page_type",
  "screen_type",
  "ux_pattern",
  "ui_pattern",
  "component",
  "function",
  "industry",
  "design_style",
];

/**
 * Everything published, of every kind — and where collection links land.
 * Every filter is a query parameter, so each view is a URL.
 */
export default async function BrowsePage({
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
  const kind = single("kind");
  const sourceSlug = single("source");
  const collectionSlug = single("collection");
  const sort: "recent" | "title" =
    single("sort") === "title" ? "title" : "recent";

  const [results, facets, collections] = await Promise.all([
    api.listContent({
      q,
      kind,
      source: sourceSlug,
      collection: collectionSlug,
      term: terms,
      sort,
      page,
      pageSize: PAGE_SIZE,
    }),
    api.listFacets(),
    collectionSlug ? api.listCollections() : Promise.resolve([]),
  ]);

  const withParams = (
    changes: Record<string, string | string[] | undefined>,
  ): string => {
    const next = new URLSearchParams();
    const base: Record<string, string | string[] | undefined> = {
      q,
      kind,
      source: sourceSlug,
      collection: collectionSlug,
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
    return query ? `/browse?${query}` : "/browse";
  };

  const toggleTerm = (slug: string): string =>
    withParams({
      term: terms.includes(slug)
        ? terms.filter((t) => t !== slug)
        : [...terms, slug],
      page: undefined,
    });

  const activeCount =
    terms.length +
    (kind ? 1 : 0) +
    (q ? 1 : 0) +
    (sourceSlug ? 1 : 0) +
    (collectionSlug ? 1 : 0);
  const activeCollection = collections.find(
    (entry) => entry.slug === collectionSlug,
  );
  const totalPages = Math.max(1, Math.ceil(results.total / PAGE_SIZE));
  const groups = FACET_ORDER.filter((wanted) =>
    facets.some((group) => group.kind === wanted),
  )
    .map((wanted) => facets.find((group) => group.kind === wanted)!)
    .filter((group) => group.terms.length > 0);

  return (
    <>
      <PageHeader
        label={`${activeCollection ? "Collection" : q ? "Search" : "Everything"} · ${plural(results.total, "website")}`}
        title={
          activeCollection ? activeCollection.name : q ? `“${q}”` : "Browse"
        }
        note={
          activeCollection?.description ??
          "Every website and flow, in one place."
        }
      />

      <FilterRows
        activeCount={activeCount}
        clearHref="/browse"
        rows={[
          {
            label: "Sort",
            options: (
              [
                ["recent", "Newest"],
                ["title", "A–Z"],
              ] as const
            ).map(([value, label]) => ({
              label,
              href: withParams({
                sort: value === "recent" ? undefined : value,
                page: undefined,
              }),
              active: sort === value,
            })),
          },
          ...(kind || sourceSlug
            ? [
                {
                  label: "Showing",
                  options: [
                    ...(kind
                      ? [
                          {
                            label: `${kindLabel(kind)} ×`,
                            href: withParams({
                              kind: undefined,
                              page: undefined,
                            }),
                            active: true,
                          },
                        ]
                      : []),
                    ...(sourceSlug
                      ? [
                          {
                            label: `${sourceSlug} ×`,
                            href: withParams({
                              source: undefined,
                              page: undefined,
                            }),
                            active: true,
                          },
                        ]
                      : []),
                  ],
                },
              ]
            : []),
          ...groups.map((group) => ({
            label: kindLabel(group.kind),
            options: group.terms.slice(0, 16).map((entry) => ({
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
        <EmptyState title="Nothing matches">Try removing a filter.</EmptyState>
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
