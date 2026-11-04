import Link from "next/link";
import { listPatterns } from "@uxd/api";
import { TAXONOMY_KIND_META, type TaxonomyKind } from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  PageHeader,
  Panel,
  SectionLabel,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Patterns" };

/** The vocabularies that describe how something works rather than what it is. */
const PATTERN_KINDS = ["ux_pattern", "ui_pattern", "component", "interaction_type"] as const;

/**
 * The pattern layer (§2, §13).
 *
 * §2 is explicit that "UX/UI should NOT be treated as a top-level content
 * source. UX/UI is a classification/research layer applied to content." This
 * screen is that instruction made visible: there is no patterns table. A
 * pattern is a taxonomy term, and what makes it interesting is the set of
 * pages and screens carrying it.
 *
 * The three counts are the point. Confirmed and suggested are kept apart
 * because §14's distinction between a machine guess and a human decision is
 * exactly what a curator needs here — a term with 200 suggested and 3
 * confirmed uses is a term nobody has validated, and adding the two together
 * would hide that. Published is the third, because a pattern with confirmed
 * uses that are all unpublished is invisible to the public API however well
 * curated it is.
 */
export default async function PatternsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("taxonomy.read");
  const params = await searchParams;

  const kinds = params.kind?.split(",").filter(Boolean);
  const unusedOnly = params.unused === "1";

  const rows = await listPatterns(context.db, {
    q: params.q,
    kinds: kinds?.length ? kinds : undefined,
    unusedOnly,
  });

  const byKind = new Map<string, typeof rows>();
  for (const row of rows) {
    byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
  }

  const totals = rows.reduce(
    (acc, row) => ({
      confirmed: acc.confirmed + row.confirmedCount,
      suggested: acc.suggested + row.suggestedCount,
      published: acc.published + row.publishedCount,
    }),
    { confirmed: 0, suggested: 0, published: 0 },
  );

  return (
    <>
      <PageHeader
        title="Patterns"
        description="The UX and UI patterns applied across the library, and what each one has been attached to."
        count={`${rows.length} patterns · ${totals.confirmed.toLocaleString("en-US")} confirmed uses`}
        actions={
          totals.suggested > 0 ? (
            <LinkButton href="/taxonomy/suggestions" variant="primary">
              {totals.suggested.toLocaleString("en-US")} unconfirmed
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
              placeholder="Search patterns and aliases…"
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
            basePath="/patterns"
            paramName="kind"
            active={kinds ?? []}
            searchParams={params}
            options={PATTERN_KINDS.map((kind) => ({
              value: kind,
              label: TAXONOMY_KIND_META[kind].label,
              title: TAXONOMY_KIND_META[kind].description,
            }))}
          />
          <FilterChips
            basePath="/patterns"
            paramName="unused"
            active={unusedOnly ? ["1"] : []}
            searchParams={params}
            options={[
              {
                value: "1",
                label: "Never used",
                title: "Patterns with no assignments at all — candidates for archiving or for the vocabulary being wrong.",
              },
            ]}
          />
        </div>

        {rows.length === 0 ? (
          <Panel>
            <EmptyState
              title={unusedOnly ? "Every pattern is in use" : params.q ? "No patterns match that" : "No patterns yet"}
              description={
                unusedOnly
                  ? "No pattern vocabulary term is sitting unused."
                  : "Patterns are taxonomy terms. Create them on the Taxonomy screen, or let classification propose them."
              }
              action={<LinkButton href="/taxonomy">Open taxonomy</LinkButton>}
            />
          </Panel>
        ) : null}

        {PATTERN_KINDS.filter((kind) => byKind.has(kind)).map((kind) => {
          const meta = TAXONOMY_KIND_META[kind as TaxonomyKind];
          const group = byKind.get(kind) ?? [];
          return (
            <Panel key={kind} title={`${meta.plural} (${group.length})`} description={meta.description}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th className="w-24 text-right">Confirmed</th>
                    <th className="w-24 text-right">Suggested</th>
                    <th className="w-24 text-right">Published</th>
                    <th className="w-24">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((row) => (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <span style={{ paddingLeft: `${Math.min(row.depth, 6) * 14}px` }}>
                          {row.depth > 0 ? (
                            <span aria-hidden className="mr-1 text-ink-300">
                              └
                            </span>
                          ) : null}
                          <Link href={`/patterns/${row.id}`} className="font-medium hover:underline">
                            {row.name}
                          </Link>
                        </span>
                        <InlineMeta
                          items={[
                            row.description,
                            row.aliases.length > 0
                              ? `also: ${row.aliases.slice(0, 3).join(", ")}`
                              : null,
                          ]}
                        />
                      </td>
                      <td className="text-right tabular-nums">
                        {row.confirmedCount > 0 ? (
                          <Link href={`/patterns/${row.id}`} className="hover:underline">
                            {row.confirmedCount.toLocaleString("en-US")}
                          </Link>
                        ) : (
                          <span className="text-ink-400">0</span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.suggestedCount > 0 ? (
                          <Link
                            href="/taxonomy/suggestions"
                            className="text-[var(--color-tone-warning)] hover:underline"
                            title="Machine suggestions nobody has confirmed yet. Not visible on the public API."
                          >
                            {row.suggestedCount.toLocaleString("en-US")}
                          </Link>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.publishedCount > 0 ? (
                          <span className="text-[var(--color-tone-success)]">
                            {row.publishedCount.toLocaleString("en-US")}
                          </span>
                        ) : (
                          <span className="text-ink-400">0</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={row.status === "active" ? "success" : "neutral"}>
                          {row.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          );
        })}

        {rows.length > 0 ? (
          <div className="space-y-1">
            <SectionLabel>Reading these numbers</SectionLabel>
            <p className="max-w-3xl text-2xs leading-relaxed text-ink-500">
              <strong>Confirmed</strong> counts records where a person verified, corrected or added
              the pattern. <strong>Suggested</strong> counts unreviewed machine proposals — they do
              not appear on the public API and do not become facets.{" "}
              <strong>Published</strong> is the subset of confirmed uses that is currently live, so a
              pattern with confirmed uses but zero published is well curated and publicly invisible.
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}
