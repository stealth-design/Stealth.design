import Link from "next/link";
import { listSources } from "@uxd/api";
import {
  ATTENTION_SOURCE_HEALTH,
  RIGHTS_STATUS_META,
  SOURCE_HEALTH_META,
  SOURCE_HEALTH_STATUSES,
  SOURCE_TYPES,
  type RightsStatus,
  type SourceHealth,
  type SourceSortKey,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  Timestamp,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Sources" };

const PAGE_SIZE = 50;

/**
 * The source register (§3).
 *
 * A source is the anchor for everything captured from one product or site, and
 * this list is deliberately shaped around the two questions a team asks of it:
 * "what do we hold from this?" and "is any of it going stale?". So the columns
 * are counts and recency rather than descriptive metadata, and health is a
 * first-class column rather than something you find by opening the record.
 *
 * Health is derived, not typed in — `deriveSourceHealth` computes it from
 * capture outcomes — which is why it is worth surfacing here: it is the one
 * column that changes without anyone touching the record.
 */
export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("source.read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const healths = params.health?.split(",").filter(Boolean);
  const types = params.type?.split(",").filter(Boolean);

  const { rows, total } = await listSources(
    context.db,
    {
      q: params.q,
      healths,
      types,
      needsAttention: params.attention === "1",
      sort: (params.sort as SourceSortKey | undefined) ?? "name",
      direction: params.dir === "desc" ? "desc" : "asc",
    },
    { page, pageSize: PAGE_SIZE },
  );

  const attentionCount = rows.filter((row) =>
    ATTENTION_SOURCE_HEALTH.includes(row.health as SourceHealth),
  ).length;

  return (
    <>
      <PageHeader
        title="Sources"
        description="The products and sites we study. Each one anchors everything captured from it, and carries its own health and rights position."
        count={`${total.toLocaleString("en-US")} sources`}
        actions={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search name, domain, company…"
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
            basePath="/sources"
            paramName="attention"
            active={params.attention === "1" ? ["1"] : []}
            searchParams={params}
            options={[
              {
                value: "1",
                label: "Needs attention",
                title: "Changed, stale, unavailable, blocked, redirected or flagged.",
              },
            ]}
          />
          <FilterChips
            basePath="/sources"
            paramName="health"
            active={healths ?? []}
            searchParams={params}
            options={SOURCE_HEALTH_STATUSES.map((health) => ({
              value: health,
              label: SOURCE_HEALTH_META[health].label,
              title: SOURCE_HEALTH_META[health].description,
            }))}
          />
          <FilterChips
            basePath="/sources"
            paramName="type"
            active={types ?? []}
            searchParams={params}
            options={SOURCE_TYPES.map((type) => ({ value: type, label: type }))}
          />
        </div>

        {attentionCount > 0 && params.attention !== "1" ? (
          <p className="text-2xs text-ink-500">
            {attentionCount} of the sources on this page need attention.{" "}
            <Link href="/sources?attention=1" className="underline">
              Show only those
            </Link>
            .
          </p>
        ) : null}

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={Object.keys(params).length > 0 ? "Nothing matches those filters" : "No sources yet"}
              description={
                Object.keys(params).length > 0
                  ? "Clear the filters to see everything."
                  : "A source is created automatically the first time a URL from its domain is captured."
              }
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="w-28">Health</th>
                  <th className="w-24">Rights</th>
                  <th className="w-20 text-right">Content</th>
                  <th className="w-20 text-right">Published</th>
                  <th className="w-16 text-right">Media</th>
                  <th className="w-24">Last capture</th>
                  <th className="w-24">Next due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const health = SOURCE_HEALTH_META[row.health as SourceHealth];
                  const rights = RIGHTS_STATUS_META[row.rightsStatus as RightsStatus];
                  return (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/sources/${row.id}`} className="font-medium hover:underline">
                          {row.name}
                        </Link>
                        <InlineMeta
                          items={[
                            row.domain,
                            row.type,
                            row.module,
                            row.companyName !== row.name ? row.companyName : null,
                            row.consecutiveFailures > 0
                              ? `${row.consecutiveFailures} consecutive failures`
                              : null,
                          ]}
                        />
                      </td>
                      <td>
                        <Badge tone={health.tone} title={health.description}>
                          {health.label}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={rights.tone} title={rights.description}>
                          {rights.label}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {row.contentCount.toLocaleString("en-US")}
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
                      <td className="text-right tabular-nums text-ink-600">
                        {row.mediaCount.toLocaleString("en-US")}
                      </td>
                      <td>
                        {row.lastCapturedAt ? (
                          <Timestamp value={row.lastCapturedAt} relative />
                        ) : (
                          <span className="text-2xs text-ink-400">never</span>
                        )}
                      </td>
                      <td>
                        {row.nextScheduledCaptureAt ? (
                          <Timestamp value={row.nextScheduledCaptureAt} relative />
                        ) : (
                          <span
                            className="text-2xs text-ink-400"
                            title="No recapture scheduled. Set a capture interval on the source."
                          >
                            —
                          </span>
                        )}
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
            basePath="/sources"
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            searchParams={params}
          />
          <p className="text-2xs text-ink-500">
            Health is derived from capture outcomes, not entered by hand.{" "}
            <MonoValue value="Published" /> counts only what is live on the public API.
          </p>
        </div>
      </div>
    </>
  );
}
