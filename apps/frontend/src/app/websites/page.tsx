import {
  CardGrid,
  EmptyState,
  PageHeader,
  ProductCard,
} from "@/components/gallery";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";

export const metadata = { title: "Products" };

/**
 * Every product with published screens, two to a row.
 *
 * A product appears only when it has published content — the API's own
 * condition — so the list cannot advertise something with nothing behind it.
 */
export default async function SourcesPage() {
  const sources = await api.listSources({ pageSize: 60 });

  const covers = await Promise.all(
    sources.items.map((source) =>
      api
        .listScreens({ source: source.slug, pageSize: 1 })
        .then((result) => result.items[0]?.primaryMedia ?? null)
        .catch(() => null),
    ),
  );

  return (
    <>
      <PageHeader
        label={plural(sources.total, "company", "companies")}
        title="Companies"
        note="Every company with a website here. Names and logos belong to their owners."
      />

      {sources.items.length === 0 ? (
        <EmptyState title="Coming soon">
          New websites are on the way. Check back soon.
        </EmptyState>
      ) : (
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
      )}
    </>
  );
}
