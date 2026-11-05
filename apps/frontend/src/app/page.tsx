import Link from "next/link";
import {
  CardGrid,
  EmptyState,
  Pager,
  ProductCard,
  ScreenCard,
  SectionHeader,
  SeeAllBar,
  Shot,
} from "@/components/gallery";
import { Wordmark } from "@/components/logo";
import { FilterRows } from "@/components/filter-rows";
import { FiltersPanel } from "@/components/filters-panel";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import { screenPath } from "@/lib/paths";
import { kindLabel } from "@/lib/format";

/** Three blocks, each starting on a column line: 1, 5 and 9. */
const COLUMN_STARTS = [
  "col-span-full md:col-span-3",
  "col-span-full md:col-span-3 md:col-start-5",
  "col-span-full md:col-span-3 md:col-start-9",
];

/**
 * The extra sections: the scrolling strip, the numbers, products and
 * patterns. Off for launch, kept for later: set to
 * true to bring them all back.
 */
const SHOW_FOLDS = false;

const NONE = { items: [], total: 0 } as const;

const PAGE_SIZE = 30;

/** The vocabularies worth filtering by, in the order they are shown. */
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
 * The front page.
 *
 * For launch: one sentence, then the screens. Dark throughout; the colour
 * is the screenshots.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The filters live here for now, since there are no other pages: each one
  // is a query parameter, so a filtered view is a URL that can be shared.
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
  const device = single("device");
  const sort: "recent" | "title" =
    single("sort") === "title" ? "title" : "recent";
  const filtering = terms.length > 0 || device !== undefined;

  const [recent, facets, sources, everything] = await Promise.all([
    api.listScreens({ sort, device, term: terms, page, pageSize: PAGE_SIZE }),
    api.listFacets(),
    SHOW_FOLDS ? api.listSources({ pageSize: 4 }) : Promise.resolve(NONE),
    // The count in the first fold is of everything, filtered or not.
    filtering ? api.listScreens({ pageSize: 1 }) : Promise.resolve(null),
  ]);
  const total = everything?.total ?? recent.total;
  const totalPages = Math.max(1, Math.ceil(recent.total / PAGE_SIZE));

  const withParams = (
    changes: Record<string, string | string[] | undefined>,
  ): string => {
    const next = new URLSearchParams();
    const base: Record<string, string | string[] | undefined> = {
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
    // Land on the cards, not back at the top of the first fold.
    return `${query ? `/?${query}` : "/"}#websites`;
  };
  const toggleTerm = (slug: string): string =>
    withParams({
      term: terms.includes(slug)
        ? terms.filter((t) => t !== slug)
        : [...terms, slug],
      page: undefined,
    });
  const activeCount = terms.length + (device ? 1 : 0);
  const filterGroups = facets
    .filter(
      (group) => FACET_ORDER.includes(group.kind) && group.terms.length > 0,
    )
    .sort((a, b) => FACET_ORDER.indexOf(a.kind) - FACET_ORDER.indexOf(b.kind));

  const covers = await Promise.all(
    sources.items.map((source) =>
      api
        .listScreens({ source: source.slug, pageSize: 1 })
        .then((result) => result.items[0]?.primaryMedia ?? null)
        .catch(() => null),
    ),
  );

  const patternGroups = (SHOW_FOLDS ? facets : [])
    .filter((group) => group.terms.length > 0)
    .sort((a, b) => b.terms.length - a.terms.length)
    .slice(0, 4);

  const stats = [
    { value: recent.total, label: "Screens", href: "/screens" },
    { value: sources.total, label: "Websites", href: "/websites" },
  ];

  return (
    <>
      {/* --- The first fold --------------------------------------------- */}
      {/*
        Short on purpose: the wordmark and one line, then straight into the
        filters and the first row of websites, all on the first screen.
      */}
      <section className="px-4 pt-12 pb-10 md:px-10 md:pt-14 md:pb-12">
        <Reveal>
          <Wordmark
            height="clamp(2.5rem, 5vw, 4.5rem)"
            className="mx-auto mb-5 md:mb-7"
          />
          <h1 className="mx-auto max-w-[26em] text-center text-[clamp(1.375rem,2.6vw,2.75rem)] leading-[1.15] font-normal tracking-[-0.03em] text-balance">
            A library of ideas for better digital experiences.
          </h1>
        </Reveal>
      </section>

      {total === 0 ? (
        <div className="mt-24">
          <EmptyState title="Coming soon">
            New websites are on the way. Check back soon.
          </EmptyState>
        </div>
      ) : (
        <>
          {/* --- The work, as a strip ------------------------------------ */}
          {SHOW_FOLDS ? (
            <section className="mt-20 md:mt-28" aria-label="Latest websites">
              <div className="no-scrollbar flex snap-x gap-3 overflow-x-auto px-4 md:px-10">
                {recent.items.map((item, index) => (
                  <Link
                    key={item.id}
                    href={screenPath(item.slug, item.source?.slug)}
                    className="group relative w-[78vw] shrink-0 snap-start overflow-hidden rounded-lg md:w-[38vw]"
                    aria-label={item.title}
                  >
                    <Shot
                      media={item.primaryMedia}
                      title={item.title}
                      priority={index < 3}
                      className="transition-transform duration-700 ease-out group-hover:scale-[1.02]"
                    />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {/* --- The numbers --------------------------------------------- */}
          {SHOW_FOLDS ? (
            <section className="page-grid mt-20 gap-y-10 md:mt-28">
              {stats.map((stat, index) => (
                <Link
                  key={stat.label}
                  href={stat.href}
                  className={COLUMN_STARTS[index]?.replace(
                    "col-span-full",
                    "col-span-2",
                  )}
                >
                  <p className="t-stat hover:opacity-60">
                    {stat.value.toLocaleString("en-US")}
                  </p>
                  <p className="t-label mt-3 text-muted-foreground">
                    {stat.label}
                  </p>
                </Link>
              ))}
            </section>
          ) : null}

          {/* --- By product ---------------------------------------------- */}
          {sources.items.length > 0 ? (
            <section className="mt-32 md:mt-48">
              <SectionHeader
                title="Products"
                note="Every website here, with all of its screens."
              />
              <CardGrid columns={2}>
                {sources.items.map((source, index) => (
                  <ProductCard
                    key={source.id}
                    source={source}
                    cover={covers[index] ?? null}
                    count={source.publishedCount}
                    priority={index < 2}
                  />
                ))}
              </CardGrid>
              <SeeAllBar href="/websites">See all products</SeeAllBar>
            </section>
          ) : null}

          {/* --- The screens --------------------------------------------- */}
          <section
            id="websites"
            className="scroll-mt-6"
            aria-label="Websites"
          >
            <FiltersPanel activeCount={activeCount} clearHref="/#websites">
              <FilterRows
                activeCount={activeCount}
                clearHref="/#websites"
                showClear={false}
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
                        href: withParams({ sort: undefined, page: undefined }),
                        active: sort === "recent",
                      },
                      {
                        label: "A–Z",
                        href: withParams({ sort: "title", page: undefined }),
                        active: sort === "title",
                      },
                    ],
                  },
                  ...filterGroups.map((group) => ({
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
            </FiltersPanel>

            {recent.items.length === 0 ? (
              <EmptyState title="Nothing matches">
                Try removing a filter or two.
              </EmptyState>
            ) : (
              <CardGrid columns={3}>
                {recent.items.map((item, index) => (
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
          </section>

          {/* --- By pattern ---------------------------------------------- */}
          {patternGroups.length > 0 ? (
            <section className="mt-32 md:mt-48">
              {patternGroups.map((group) => (
                <Reveal
                  key={group.kind}
                  className="border-t px-4 py-12 text-center md:px-10 md:py-16"
                >
                  <h2 className="t-title">{kindLabel(group.kind)}</h2>
                  <p className="t-label mx-auto mt-6 flex max-w-4xl flex-wrap justify-center gap-x-5 gap-y-2">
                    {group.terms.slice(0, 10).map((entry) => (
                      <Link
                        key={entry.term.id}
                        href={`/screens?term=${encodeURIComponent(entry.term.slug)}`}
                        className="flex items-center gap-2 hover:opacity-60"
                      >
                        <span
                          aria-hidden
                          className="size-1 rounded-full bg-muted-foreground"
                        />
                        {entry.term.name}
                      </Link>
                    ))}
                  </p>
                </Reveal>
              ))}
              <SeeAllBar href="/patterns">See all patterns</SeeAllBar>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
