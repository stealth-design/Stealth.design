import { EmptyState, Filters, ProductRow, Room, SectionLabel, toSlide } from "@/components/gallery";
import { Viewer } from "@/components/viewer";
import { api } from "@/lib/api";

/**
 * The front page is the lightbox: the newest screen on the stage, the rest
 * of the recent ones in the filmstrip, ← → to step through. Below it, the
 * library a product at a time.
 */
export default async function HomePage() {
  const [recent, sources, facets] = await Promise.all([
    api.listScreens({ sort: "recent", pageSize: 24 }),
    api.listSources({ pageSize: 8 }),
    api.listFacets(),
  ]);

  if (recent.total === 0) {
    return (
      <EmptyState title="Nothing published yet">
        Screens appear here once they have been captured, reviewed and published in the CMS.
      </EmptyState>
    );
  }

  const rows = await Promise.all(
    sources.items.map((source) =>
      api
        .listScreens({ source: source.slug, pageSize: 10 })
        .then((result) => result.items)
        .catch(() => []),
    ),
  );

  const topTerms = facets
    .flatMap((group) => group.terms)
    .sort((a, b) => b.count - a.count)
    .slice(0, 14);

  return (
    <>
      <section className="pt-6 md:pt-8" aria-label="Recently published">
        <Viewer slides={recent.items.map(toSlide)} />
      </section>

      <section className="mt-24 md:mt-32" aria-label="Products">
        <Room>
          <SectionLabel title="Products" count={sources.total} href="/sources" />
        </Room>
        {sources.items.map((source, index) => (
          <ProductRow key={source.id} source={source} count={source.publishedCount} items={rows[index] ?? []} />
        ))}
      </section>

      {topTerms.length > 0 ? (
        <Room className="mt-20">
          <SectionLabel title="Patterns" href="/patterns" />
          <Filters
            options={topTerms.map((entry) => ({
              label: entry.term.name,
              href: `/screens?term=${encodeURIComponent(entry.term.slug)}`,
              count: entry.count,
              title: entry.term.description ?? undefined,
            }))}
          />
        </Room>
      ) : null}
    </>
  );
}
