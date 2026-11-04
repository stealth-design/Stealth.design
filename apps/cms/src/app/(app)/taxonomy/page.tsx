import Link from "next/link";
import { listPendingSuggestions, listTaxonomyTerms } from "@uxd/api";
import {
  TAXONOMY_KINDS,
  TAXONOMY_KIND_META,
  TAXONOMY_TERM_STATUSES,
  type TaxonomyKind,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  SectionLabel,
  Timestamp,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Taxonomy" };

/**
 * The vocabularies (§13).
 *
 * Grouped by kind and indented by depth, because a vocabulary's shape is part
 * of its meaning: "Navigation > Mobile > Bottom navigation" reads as a
 * hierarchy or it reads as three unrelated tags. The materialised `path`
 * column is what makes one ordered query enough — no recursive CTE, and the
 * indentation comes from `depth` rather than from client-side tree building.
 *
 * §37 forbids hardcoded taxonomy, and this screen is the reason that holds:
 * every term here is a database row an operator created, aliased, re-parented
 * or archived. The seed provides a starting vocabulary for local development
 * only; nothing in application logic branches on a specific term.
 */
export default async function TaxonomyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("taxonomy.read");
  const params = await searchParams;

  const kinds = params.kind?.split(",").filter(Boolean);
  const showArchived = params.archived === "1";

  const [terms, pending] = await Promise.all([
    listTaxonomyTerms(context.db, {
      q: params.q,
      kinds,
      statuses: showArchived ? undefined : ["active", "draft"],
    }),
    listPendingSuggestions(context.db, { page: 1, pageSize: 1 }),
  ]);

  // Grouped in one pass; the query already returns them ordered by kind then
  // path, so a term's children immediately follow it.
  const byKind = new Map<string, typeof terms>();
  for (const term of terms) {
    byKind.set(term.kind, [...(byKind.get(term.kind) ?? []), term]);
  }

  const presentKinds = TAXONOMY_KINDS.filter((kind) => byKind.has(kind));

  return (
    <>
      <PageHeader
        title="Taxonomy"
        description="The vocabularies this library is classified with. Yours to create, rename, alias and archive."
        count={`${terms.length.toLocaleString("en-US")} terms across ${presentKinds.length} vocabularies`}
        actions={
          pending.total > 0 ? (
            <LinkButton href="/taxonomy/suggestions" variant="primary">
              {pending.total.toLocaleString("en-US")} suggestions to review
            </LinkButton>
          ) : undefined
        }
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search names and aliases…"
              className="h-7 w-60 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2.5 text-xs hover:bg-ink-100"
            >
              Search
            </button>
          </form>
          <FilterChips
            basePath="/taxonomy"
            paramName="kind"
            active={kinds ?? []}
            searchParams={params}
            options={TAXONOMY_KINDS.map((kind) => ({
              value: kind,
              label: TAXONOMY_KIND_META[kind].label,
              title: TAXONOMY_KIND_META[kind].description,
            }))}
          />
          <FilterChips
            basePath="/taxonomy"
            paramName="archived"
            active={showArchived ? ["1"] : []}
            searchParams={params}
            options={[
              {
                value: "1",
                label: "Include archived",
                title: "Archived terms keep their existing assignments but are not offered for new ones.",
              },
            ]}
          />
        </div>

        {terms.length === 0 ? (
          <Panel>
            <EmptyState
              title={params.q ? "No terms match that" : "No terms yet"}
              description={
                params.q
                  ? "Aliases are searched too, so a term is findable by the words your team actually uses for it."
                  : "Run the development seed to start from a base vocabulary, or create terms as you classify."
              }
            />
          </Panel>
        ) : null}

        {presentKinds.map((kind) => {
          const meta = TAXONOMY_KIND_META[kind as TaxonomyKind];
          const rows = byKind.get(kind) ?? [];
          return (
            <Panel
              key={kind}
              title={`${meta.plural} (${rows.length})`}
              description={meta.description}
              actions={
                <span className="flex items-center gap-2 text-2xs text-ink-500">
                  {meta.hierarchical ? <span title="Supports parent/child nesting">nested</span> : null}
                  {meta.singleValue ? (
                    <span title="A record may carry only one term from this vocabulary">
                      single value
                    </span>
                  ) : null}
                  {meta.publicFacet ? (
                    <span title="Offered as a filter on the public API">public facet</span>
                  ) : null}
                  <span title="Which entities this vocabulary can classify">
                    {meta.targets.join(", ")}
                  </span>
                </span>
              }
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Term</th>
                    <th className="w-20 text-right">Uses</th>
                    <th className="w-20 text-right">Children</th>
                    <th className="w-24">Status</th>
                    <th className="w-24">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((term) => (
                    <tr key={term.id}>
                      <td className="truncate-cell">
                        <span style={{ paddingLeft: `${Math.min(term.depth, 6) * 14}px` }}>
                          {term.depth > 0 ? (
                            <span aria-hidden className="mr-1 text-ink-300">
                              └
                            </span>
                          ) : null}
                          <Link
                            href={`/patterns/${term.id}`}
                            className="font-medium hover:underline"
                            title={term.description ?? undefined}
                          >
                            {term.name}
                          </Link>
                        </span>
                        <InlineMeta
                          items={[
                            term.slug,
                            term.aliases.length > 0
                              ? `also: ${term.aliases.slice(0, 4).join(", ")}`
                              : null,
                            term.isSeed ? "from seed" : null,
                          ]}
                        />
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {term.usageCount.toLocaleString("en-US")}
                      </td>
                      <td className="text-right tabular-nums text-ink-500">
                        {term.childCount > 0 ? term.childCount : "—"}
                      </td>
                      <td>
                        <Badge
                          tone={
                            term.status === "active"
                              ? "success"
                              : term.status === "draft"
                                ? "info"
                                : "neutral"
                          }
                        >
                          {term.status}
                        </Badge>
                      </td>
                      <td>
                        <Timestamp value={term.updatedAt} relative />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          );
        })}

        <div className="space-y-1">
          <SectionLabel>How classification provenance works</SectionLabel>
          <p className="max-w-3xl text-2xs leading-relaxed text-ink-500">
            Every assignment records where it came from: a machine suggestion, a human confirmation,
            a human correction, or a direct human addition. Only human-confirmed assignments reach
            the public API, so an unreviewed guess is never published as if it were a curated fact.
            Statuses available for a term: {TAXONOMY_TERM_STATUSES.join(", ")}.{" "}
            <MonoValue value="usageCount" /> counts assignments of any provenance; the{" "}
            <Link href="/patterns" className="underline">
              Patterns
            </Link>{" "}
            screen splits confirmed from suggested.
          </p>
        </div>
      </div>
    </>
  );
}
