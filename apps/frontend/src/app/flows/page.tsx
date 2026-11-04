import { ContactSheet, EmptyState, PageIntro, Pager, Room } from "@/components/gallery";
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

  const results = await api.listFlows({ q, source: sourceSlug, page, pageSize: PAGE_SIZE });
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
      <PageIntro
        title={q ? `“${q}”` : "Flows"}
        count={plural(results.total, "flow")}
        description="Journeys through a product — signing up, checking out, setting something up — one screen at a time."
      />
      {results.items.length === 0 ? (
        <EmptyState title="No flows yet">
          A flow is an ordered journey through screens, assembled by hand from screens that have already
          been captured.
        </EmptyState>
      ) : (
        <Room>
          <ContactSheet items={results.items} numberFrom={(page - 1) * PAGE_SIZE + 1} size="lg" />
        </Room>
      )}
      <Pager page={page} totalPages={totalPages} href={pageHref} />
    </>
  );
}
