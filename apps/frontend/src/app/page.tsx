import Link from "next/link";
import {
  CardGrid,
  EmptyState,
  ProductCard,
  ScreenCard,
  SectionHeader,
  SeeAllBar,
  Shot,
} from "@/components/gallery";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import { kindLabel } from "@/lib/format";

/** What the library is, in three lines, each on its own column. */
const PRINCIPLES = [
  {
    title: "Real websites",
    note: "Live sites from real companies, shown in full detail.",
  },
  {
    title: "All in one place",
    note: "Great websites side by side, without opening a hundred tabs.",
  },
  {
    title: "Ideas you can use",
    note: "Find something you love, then visit the site to see it live.",
  },
];

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

/**
 * The front page.
 *
 * For launch: the name, then the screens. Black and white throughout — the
 * colour is the screenshots.
 */
export default async function HomePage() {
  const [recent, facets, sources, flows] = await Promise.all([
    api.listScreens({ sort: "recent", pageSize: 12 }),
    SHOW_FOLDS ? api.listFacets() : Promise.resolve([]),
    SHOW_FOLDS ? api.listSources({ pageSize: 4 }) : Promise.resolve(NONE),
    SHOW_FOLDS ? api.listFlows({ pageSize: 1 }) : Promise.resolve(NONE),
  ]);

  const covers = await Promise.all(
    sources.items.map((source) =>
      api
        .listScreens({ source: source.slug, pageSize: 1 })
        .then((result) => result.items[0]?.primaryMedia ?? null)
        .catch(() => null),
    ),
  );

  const patternGroups = facets
    .filter((group) => group.terms.length > 0)
    .sort((a, b) => b.terms.length - a.terms.length)
    .slice(0, 4);

  const stats = [
    { value: recent.total, label: "Screens", href: "/screens" },
    { value: sources.total, label: "Products", href: "/sources" },
    { value: flows.total, label: "Flows", href: "/flows" },
  ];

  return (
    <>
      {/* --- The first fold --------------------------------------------- */}
      {/*
        One screen tall. The three lines sit on the column lines the header's
        notches point at (1, 5, 9), each a short headline with its small print
        set well below it; the name and the sentence close the fold at the
        bottom.
      */}
      <section className="flex min-h-[calc(100svh-3rem)] flex-col pb-12 md:pb-16">
        <div className="page-grid gap-y-10 pt-8 md:pt-10">
          {PRINCIPLES.map((principle, index) => (
            <Reveal
              key={principle.title}
              delay={index * 0.05}
              className={COLUMN_STARTS[index]}
            >
              <p className="text-[clamp(1.05rem,1.4vw,1.375rem)] leading-snug tracking-[-0.02em]">
                {principle.title}
              </p>
              <p className="t-label mt-4 max-w-[17rem] leading-relaxed text-muted-foreground md:mt-[clamp(5rem,16vh,10rem)]">
                {principle.note}
              </p>
            </Reveal>
          ))}
        </div>

        <div className="mt-auto overflow-hidden px-4 pt-20 md:px-10">
          <Reveal>
            <h1
              className="pb-[0.06em] text-center leading-[0.9] font-semibold tracking-[-0.065em]"
              style={{ fontSize: "var(--t-hero)" }}
            >
              Stealth.design
            </h1>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="mx-auto mt-5 max-w-6xl text-center text-[clamp(1.25rem,2.5vw,2.6rem)] leading-[1.15] tracking-[-0.03em] text-balance md:mt-6">
              See how the best websites make a first impression, and find ideas
              for your own.
            </p>
          </Reveal>
          <div className="t-label mt-10 flex justify-center gap-4 text-muted-foreground md:mt-14 md:justify-between">
            <span>
              {recent.total === 1
                ? "1 website to explore"
                : `${recent.total.toLocaleString("en-US")} websites to explore`}
            </span>
            <span className="hidden md:inline">Website inspiration</span>
          </div>
        </div>
      </section>

      {recent.total === 0 ? (
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
                    href={`/entry/${item.slug}`}
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
                note="Every company here, with all of its screens."
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
              <SeeAllBar href="/sources">See all products</SeeAllBar>
            </section>
          ) : null}

          {/* --- The screens --------------------------------------------- */}
          <section className="mt-4 md:mt-6" aria-label="Latest websites">
            <CardGrid columns={3}>
              {recent.items.map((item, index) => (
                <ScreenCard key={item.id} item={item} priority={index < 3} />
              ))}
            </CardGrid>
            {recent.total > recent.items.length ? (
              <SeeAllBar href="/screens">See all screens</SeeAllBar>
            ) : null}
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
