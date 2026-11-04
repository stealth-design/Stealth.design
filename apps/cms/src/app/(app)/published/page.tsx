import Link from "next/link";
import { listContent } from "@uxd/api";
import {
  CONTENT_KINDS,
  CONTENT_KIND_META,
  RIGHTS_STATUS_META,
  type ContentKind,
  type ContentSortKey,
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
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Published" };

const PAGE_SIZE = 50;

/**
 * What is live (§16, §19).
 *
 * This is deliberately a *filtered view of Content* rather than a separate
 * store: §"the CMS is the source of truth" means published content is the same
 * record at a different lifecycle status, not a copy pushed somewhere else. So
 * the same query powers it, narrowed to `published`.
 *
 * The two columns that only make sense here are the public URL — the thing a
 * visitor actually reaches — and the rights position, because a published
 * record whose rights later become restricted is withdrawn automatically and
 * that transition is worth being able to see coming.
 */
export default async function PublishedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("content.read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const kinds = params.kind?.split(",").filter(Boolean);

  const { rows, total } = await listContent(
    context.db,
    {
      q: params.q,
      statuses: ["published"],
      kinds,
      sourceId: params.source,
      sort: (params.sort as ContentSortKey | undefined) ?? "publishedAt",
      direction: params.dir === "asc" ? "asc" : "desc",
    },
    { page, pageSize: PAGE_SIZE },
  );

  const urls = await resolveMediaUrls(rows.map((row) => row.thumbnailKey));

  return (
    <>
      <PageHeader
        title="Published"
        description="Everything currently live on the public API and the public site."
        count={`${total.toLocaleString("en-US")} live`}
        actions={<LinkButton href="/api/public/content">Public API</LinkButton>}
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search published records…"
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
            basePath="/published"
            paramName="kind"
            active={kinds ?? []}
            searchParams={params}
            options={CONTENT_KINDS.map((kind) => ({
              value: kind,
              label: CONTENT_KIND_META[kind as ContentKind].label,
              title: CONTENT_KIND_META[kind as ContentKind].description,
            }))}
          />
        </div>

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={
                Object.keys(params).length > 0 ? "Nothing matches those filters" : "Nothing published yet"
              }
              description={
                Object.keys(params).length > 0
                  ? "Clear the filters to see everything live."
                  : "Approve a record in the review queue, then publish it. Until something is published the public API returns an empty list."
              }
              action={<LinkButton href="/reviews">Go to reviews</LinkButton>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-12" />
                  <th>Record</th>
                  <th className="w-20">Kind</th>
                  <th className="w-28">Rights</th>
                  <th className="w-32">Source</th>
                  <th className="w-24">Published</th>
                  <th className="w-24">Captured</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rights = RIGHTS_STATUS_META[row.rightsStatus as RightsStatus];
                  return (
                    <tr key={row.id}>
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
                        <InlineMeta items={[row.slug, row.sourceUrl]} />
                      </td>
                      <td className="text-2xs text-ink-600">
                        {CONTENT_KIND_META[row.kind as ContentKind].label}
                      </td>
                      <td>
                        <Badge tone={rights.tone} title={rights.description}>
                          {rights.label}
                        </Badge>
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
                        <Timestamp value={row.publishedAt} relative />
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

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Pagination
            basePath="/published"
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            searchParams={params}
          />
          <p className="text-2xs text-ink-500">
            A record whose rights position becomes blocking is withdrawn from the public API
            immediately, without waiting for anyone to unpublish it separately. Public responses
            carry no internal notes, crawl metadata or storage keys — see{" "}
            <MonoValue value="serializers.ts" />.
          </p>
        </div>
      </div>
    </>
  );
}
