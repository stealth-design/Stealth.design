import Link from "next/link";
import { contentStatusCounts, listContent } from "@uxd/api";
import {
  CONTENT_KINDS,
  CONTENT_KIND_META,
  LIFECYCLE_STATUSES,
  LIFECYCLE_STATUS_META,
  RIGHTS_STATUS_META,
  type ContentSortKey,
  type LifecycleStatus,
  type RightsStatus,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  Thumbnail,
  Timestamp,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { ContentBulkBar } from "./bulk-bar";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Content" };

/**
 * The unified content database (§2).
 *
 * One table for every kind — page, screen, flow, state, interaction — at every
 * stage of the pipeline, because an operator's question is usually "where is
 * this?" rather than "show me pages specifically". The kind and status filters
 * narrow it; the shared spine is what makes one table possible at all.
 */
export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("content.read");
  const params = await searchParams;

  const statuses = params.status?.split(",").filter(Boolean) as LifecycleStatus[] | undefined;
  const kinds = params.kind?.split(",").filter(Boolean);
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const filters = {
    q: params.q,
    statuses,
    kinds,
    sourceId: params.source,
    crawlJobId: params.job,
    changedOnly: params.changed === "1",
    hasMedia: params.media === "1" ? true : params.media === "0" ? false : undefined,
    sort: (params.sort as ContentSortKey | undefined) ?? "updatedAt",
    direction: params.dir === "asc" ? ("asc" as const) : ("desc" as const),
  };

  const [{ rows, total }, counts] = await Promise.all([
    listContent(context.db, filters, { page, pageSize: 50 }),
    contentStatusCounts(context.db, { ...filters, statuses: undefined }),
  ]);

  const urls = await resolveMediaUrls(rows.map((row) => row.thumbnailKey));

  return (
    <>
      <PageHeader
        title="Content"
        description="Every page, screen, flow, state and interaction we hold, at any stage of the pipeline."
        count={`${total.toLocaleString("en-US")} records`}
        actions={<LinkButton href="/ingestion" variant="primary">Ingest URLs</LinkButton>}
      />

      <div className="space-y-3 p-4">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search titles and URLs…"
            className="h-7 w-72 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          {/* Preserve the other filters when searching. */}
          {(["status", "kind", "source", "job", "sort", "dir"] as const).map((key) =>
            params[key] ? <input key={key} type="hidden" name={key} value={params[key]} /> : null,
          )}
          <button
            type="submit"
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2.5 text-xs hover:bg-ink-100"
          >
            Search
          </button>
          {params.q ? (
            <Link href="/content" className="text-2xs text-ink-500 underline hover:text-ink-800">
              Clear
            </Link>
          ) : null}
        </form>

        <div className="space-y-1.5">
          <FilterChips
            basePath="/content"
            paramName="status"
            active={statuses ?? []}
            searchParams={params}
            options={LIFECYCLE_STATUSES.filter((status) => (counts[status] ?? 0) > 0).map((status) => ({
              value: status,
              label: LIFECYCLE_STATUS_META[status].label,
              title: LIFECYCLE_STATUS_META[status].description,
              count: counts[status],
            }))}
          />
          <FilterChips
            basePath="/content"
            paramName="kind"
            active={kinds ?? []}
            searchParams={params}
            options={CONTENT_KINDS.map((kind) => ({
              value: kind,
              label: CONTENT_KIND_META[kind].plural,
              title: CONTENT_KIND_META[kind].description,
            }))}
          />
        </div>

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={Object.keys(params).length > 0 ? "Nothing matches those filters" : "No content yet"}
              description={
                Object.keys(params).length > 0
                  ? "Clear the filters to see everything."
                  : "Submit a URL and the pipeline will capture it, classify it, and put it in the review queue."
              }
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          ) : (
            <ContentBulkBar ids={rows.map((row) => row.id)}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-8" />
                    <th className="w-12" />
                    <th>Title</th>
                    <th className="w-24">Kind</th>
                    <th className="w-32">Status</th>
                    <th className="w-32">Source</th>
                    <th className="w-14 text-right">Ver</th>
                    <th className="w-24">Captured</th>
                    <th className="w-24">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const statusMeta = LIFECYCLE_STATUS_META[row.status as LifecycleStatus];
                    const rightsMeta = RIGHTS_STATUS_META[row.rightsStatus as RightsStatus];
                    return (
                      <tr key={row.id} data-content-row={row.id}>
                        <td>
                          <input
                            type="checkbox"
                            name="contentIds"
                            value={row.id}
                            aria-label={`Select ${row.title ?? "untitled"}`}
                          />
                        </td>
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
                          {row.sourceUrl ? (
                            <MonoValue value={row.sourceUrl} truncate />
                          ) : null}
                          <InlineMeta
                            items={[
                              row.assignedToName ? `assigned to ${row.assignedToName}` : null,
                              row.pendingSuggestions > 0
                                ? `${row.pendingSuggestions} suggestion${row.pendingSuggestions === 1 ? "" : "s"}`
                                : null,
                              rightsMeta.blocksPublishing ? `rights: ${rightsMeta.label}` : null,
                            ]}
                          />
                        </td>
                        <td className="capitalize text-ink-600">{row.kind}</td>
                        <td>
                          <Badge tone={statusMeta.tone} title={statusMeta.description} dot>
                            {statusMeta.label}
                          </Badge>
                        </td>
                        <td className="truncate-cell">
                          {row.sourceId ? (
                            <Link href={`/sources/${row.sourceId}`} className="hover:underline">
                              {row.sourceName ?? row.sourceDomain ?? "—"}
                            </Link>
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </td>
                        <td className="text-right tabular-nums text-ink-600">{row.version}</td>
                        <td>
                          <Timestamp value={row.capturedAt} relative />
                        </td>
                        <td>
                          <Timestamp value={row.updatedAt} relative />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ContentBulkBar>
          )}
        </Panel>

        <Pagination basePath="/content" page={page} pageSize={50} total={total} searchParams={params} />
      </div>
    </>
  );
}
