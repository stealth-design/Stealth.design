import { EmptyState, PageIntro, ProductRow } from "@/components/gallery";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";

export const metadata = { title: "Products" };

/**
 * Every product with published screens, one strip of film each.
 *
 * A product appears only when it has published content — the API's own
 * condition — so the list cannot advertise something with nothing behind it.
 */
export default async function SourcesPage() {
  const sources = await api.listSources({ pageSize: 60 });
  const rows = await Promise.all(
    sources.items.map((source) =>
      api
        .listScreens({ source: source.slug, pageSize: 10 })
        .then((result) => result.items)
        .catch(() => []),
    ),
  );

  return (
    <>
      <PageIntro
        title="Products"
        count={plural(sources.total, "product")}
        description="The products these interfaces were captured from. Each name and mark belongs to the company that owns it."
      />
      {sources.items.length === 0 ? (
        <EmptyState title="No products yet">Products appear once something from them is published.</EmptyState>
      ) : (
        sources.items.map((source, index) => (
          <ProductRow key={source.id} source={source} count={source.publishedCount} items={rows[index] ?? []} />
        ))
      )}
    </>
  );
}
