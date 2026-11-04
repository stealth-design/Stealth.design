import Link from "next/link";
import { notFound } from "next/navigation";
import { listContentForPattern, listTaxonomyTerms } from "@uxd/api";
import {
  CLASSIFICATION_ORIGIN_META,
  CONTENT_KIND_META,
  LIFECYCLE_STATUS_META,
  TAXONOMY_KIND_META,
  type ClassificationOrigin,
  type ContentKind,
  type LifecycleStatus,
  type TaxonomyKind,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  Field,
  FieldList,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  Thumbnail,
  Timestamp,
} from "@/components/ui/primitives";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Pattern" };

const PAGE_SIZE = 50;

/**
 * One term, and everything carrying it (§13).
 *
 * Serves both /patterns and /taxonomy, because "show me what this term is
 * attached to" is the same question for a pattern, an industry and a page type
 * — and answering it from one screen means a curator can judge any vocabulary
 * the same way.
 *
 * Provenance is a column rather than a filter default: the useful view is
 * confirmed and suggested uses side by side, so the reviewer can see whether a
 * term's apparent popularity is human judgement or one model's habit.
 */
export default async function PatternDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("taxonomy.read");
  const { id } = await params;
  const query = await searchParams;
  const page = Math.max(1, Number(query.page ?? 1) || 1);

  // `listTaxonomyTerms` is the single term reader; there is no separate
  // getTerm, and adding one would mean two places that decide what a term's
  // shape is.
  const [terms, { rows, total }] = await Promise.all([
    listTaxonomyTerms(context.db, { statuses: undefined }),
    listContentForPattern(context.db, id, { page, pageSize: PAGE_SIZE }),
  ]);

  const term = terms.find((candidate) => candidate.id === id);
  if (!term) notFound();

  const kindMeta = TAXONOMY_KIND_META[term.kind as TaxonomyKind];
  const parent = term.parentId ? terms.find((candidate) => candidate.id === term.parentId) : null;
  const children = terms.filter((candidate) => candidate.parentId === term.id);
  const urls = await resolveMediaUrls(rows.map((row) => row.thumbnailKey));

  const confirmed = rows.filter(
    (row) => row.origin !== "ai_suggested" || row.reviewStatus !== "pending",
  ).length;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Patterns", href: "/patterns" },
          ...(parent ? [{ label: parent.name, href: `/patterns/${parent.id}` }] : []),
        ]}
        title={term.name}
        description={term.description ?? kindMeta?.description}
        count={`${total.toLocaleString("en-US")} records`}
        actions={<LinkButton href="/taxonomy">All vocabularies</LinkButton>}
      />

      <div className="grid gap-4 p-4 lg:grid-cols-4">
        <div className="space-y-4 lg:col-span-3">
          <Panel
            title="Attached to"
            description={`${confirmed} of ${rows.length} on this page are human-confirmed. Only those reach the public API.`}
          >
            {rows.length === 0 ? (
              <EmptyState
                title="Nothing carries this term"
                description={
                  term.status === "archived"
                    ? "This term is archived, so it is not offered for new assignments."
                    : "Classify something with it from a content record, or let classification propose it."
                }
                action={<LinkButton href="/content">Browse content</LinkButton>}
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-12" />
                    <th>Record</th>
                    <th className="w-20">Kind</th>
                    <th className="w-28">Status</th>
                    <th className="w-36">Provenance</th>
                    <th className="w-32">Source</th>
                    <th className="w-24">Captured</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const statusMeta = LIFECYCLE_STATUS_META[row.status as LifecycleStatus];
                    const originMeta =
                      CLASSIFICATION_ORIGIN_META[row.origin as ClassificationOrigin];
                    const unreviewed = row.origin === "ai_suggested" && row.reviewStatus === "pending";
                    return (
                      <tr key={`${row.id}-${row.origin}`}>
                        <td>
                          <Thumbnail
                            url={row.thumbnailKey ? (urls.get(row.thumbnailKey) ?? null) : null}
                            alt=""
                            width={36}
                            height={24}
                          />
                        </td>
                        <td className="truncate-cell">
                          <Link href={`/content/${row.id}`} className="font-medium hover:underline">
                            {row.title ?? "Untitled"}
                          </Link>
                        </td>
                        <td className="text-2xs text-ink-600">
                          {CONTENT_KIND_META[row.kind as ContentKind]?.label ?? row.kind}
                        </td>
                        <td>
                          <Badge tone={statusMeta.tone} title={statusMeta.description}>
                            {statusMeta.label}
                          </Badge>
                        </td>
                        <td>
                          <span
                            className={
                              unreviewed
                                ? "text-2xs text-[var(--color-tone-warning)]"
                                : "text-2xs text-ink-700"
                            }
                            title={originMeta?.description}
                          >
                            {originMeta?.label ?? row.origin}
                          </span>
                          <InlineMeta
                            items={[
                              row.confidence !== null ? `confidence ${row.confidence.toFixed(2)}` : null,
                              unreviewed ? "awaiting review" : null,
                            ]}
                          />
                        </td>
                        <td className="truncate-cell">
                          {row.sourceId ? (
                            <Link href={`/sources/${row.sourceId}`} className="hover:underline">
                              {row.sourceName ?? "—"}
                            </Link>
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </td>
                        <td>
                          <Timestamp value={row.capturedAt} relative />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>

          <Pagination
            basePath={`/patterns/${id}`}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            searchParams={query}
          />
        </div>

        <div className="space-y-4">
          <Panel title="Term">
            <FieldList>
              <Field label="Vocabulary" hint={kindMeta?.description}>
                {kindMeta?.label ?? term.kind}
              </Field>
              <Field label="Slug" mono>
                {term.slug}
              </Field>
              <Field label="Path" mono hint="Materialised ancestor path, so a subtree is a prefix match.">
                {term.path}
              </Field>
              <Field label="Parent">
                {parent ? (
                  <Link href={`/patterns/${parent.id}`} className="hover:underline">
                    {parent.name}
                  </Link>
                ) : null}
              </Field>
              <Field label="Status">
                <Badge tone={term.status === "active" ? "success" : "neutral"}>{term.status}</Badge>
              </Field>
              <Field
                label="Aliases"
                hint="Alternative names that resolve to this term, so a model or an importer saying 'hamburger menu' maps here instead of creating a near-duplicate."
              >
                {term.aliases.length > 0 ? term.aliases.join(", ") : null}
              </Field>
              <Field label="Total assignments">{term.usageCount.toLocaleString("en-US")}</Field>
              <Field label="Origin">{term.isSeed ? "Development seed" : "Created by an operator"}</Field>
              <Field label="Created">
                <Timestamp value={term.createdAt} />
              </Field>
              <Field label="Term ID" mono>
                {term.id}
              </Field>
            </FieldList>
          </Panel>

          {children.length > 0 ? (
            <Panel title={`Narrower terms (${children.length})`}>
              <table className="data-table">
                <tbody>
                  {children.map((child) => (
                    <tr key={child.id}>
                      <td className="truncate-cell">
                        <Link href={`/patterns/${child.id}`} className="hover:underline">
                          {child.name}
                        </Link>
                      </td>
                      <td className="w-16 text-right tabular-nums text-ink-600">
                        {child.usageCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          <p className="text-2xs leading-relaxed text-ink-500">
            This is a taxonomy term, not a content record. §2 keeps UX/UI as a classification layer
            applied to content rather than a content source of its own, which is why a pattern has
            no capture, no media and no lifecycle of its own — only the records carrying it do. See{" "}
            <MonoValue value="taxonomy_assignments" />.
          </p>
        </div>
      </div>
    </>
  );
}
