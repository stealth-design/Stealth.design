import {
  CardGrid,
  EmptyState,
  PageHeader,
  Pager,
  ScreenCard,
} from "@/components/gallery";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";

export const metadata = { title: "Flows" };

const PAGE_SIZE = 24;

/** Every published flow: ordered journeys through screens. */
export default async function FlowsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const page = Math.max(1, Number(single("page") ?? 1) || 1);
  const q = single("q");
  const sourceSlug = single("source");

  const results = await api.listFlows({
    q,
    source: sourceSlug,
    page,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(results.total / PAGE_SIZE));

  const pageHref = (target: number) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (sourceSlug) next.set("source", sourceSlug);
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/flows?${query}` : "/flows";
  };

  return (
    <>
      <PageHeader
        label={q ? "Search" : plural(results.total, "flow")}
        title={q ? `“${q}”` : "Flows"}
        note="Journeys through a product, one screen at a time: signing up, checking out, setting something up."
      />

      {results.items.length === 0 ? (
        <EmptyState title="No flows yet">
          A flow walks you through a website one screen at a time. Check back
          soon.
        </EmptyState>
      ) : (
        <CardGrid columns={3}>
          {results.items.map((flow, index) => (
            <ScreenCard key={flow.id} item={flow} priority={index < 3} />
          ))}
        </CardGrid>
      )}

      <Pager page={page} totalPages={totalPages} href={pageHref} />
    </>
  );
}
