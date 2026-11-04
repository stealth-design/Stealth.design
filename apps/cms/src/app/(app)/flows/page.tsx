import Link from "next/link";
import { listFlows, listSources } from "@uxd/api";
import {
  LIFECYCLE_STATUSES,
  LIFECYCLE_STATUS_META,
  type LifecycleStatus,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  PageHeader,
  Panel,
  Timestamp,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith } from "@/lib/server";
import { CreateFlow } from "./create";

export const metadata = { title: "Flows" };

const PAGE_SIZE = 50;

/**
 * Flows (§2).
 *
 * A flow is a content record of kind `flow` — the same spine, lifecycle and
 * publish gate as a page — whose distinguishing detail is an ordered path
 * through other records. That is why this list looks like Content rather than
 * like a separate subsystem: it is Content, filtered.
 *
 * Two columns exist only here. `Steps` shows the maintained count against the
 * actual number of step rows, so a drift between them is visible rather than
 * silent. `Publishable` shows how many of those steps are themselves published,
 * because a flow is only as complete publicly as its steps: a seven-step
 * checkout whose steps are half in review arrives as a partial journey.
 */
export default async function FlowsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("content.read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const statuses = params.status?.split(",").filter(Boolean);

  const { rows, total } = await listFlows(
    context.db,
    { q: params.q, statuses, sourceId: params.source },
    { page, pageSize: PAGE_SIZE },
  );

  const drifted = rows.filter((row) => (row.stepCount ?? 0) !== row.actualStepCount);

  const sources = await listSources(context.db, {}, { page: 1, pageSize: 200 });
  const sourceOptions = sources.rows.map((row) => ({ id: row.id, name: row.name }));

  return (
    <>
      <PageHeader
        title="Flows"
        description="Ordered journeys assembled from Screens. A Screen can belong to several flows; it is never captured twice."
        count={`${total.toLocaleString("en-US")} flows`}
        actions={<CreateFlow sources={sourceOptions} />}
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search flows…"
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
            basePath="/flows"
            paramName="status"
            active={statuses ?? []}
            searchParams={params}
            options={LIFECYCLE_STATUSES.map((status) => ({
              value: status,
              label: LIFECYCLE_STATUS_META[status].label,
              title: LIFECYCLE_STATUS_META[status].description,
            }))}
          />
        </div>

        {drifted.length > 0 ? (
          <p className="text-2xs text-[var(--color-tone-warning)]">
            {drifted.length}{" "}
            {drifted.length === 1 ? "flow has a step count that" : "flows have step counts that"} do
            not match their step rows. The actual number is authoritative.
          </p>
        ) : null}

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={
                Object.keys(params).length > 0 ? "Nothing matches those filters" : "No flows yet"
              }
              description={
                Object.keys(params).length > 0
                  ? "Clear the filters to see every flow."
                  : "A flow is assembled from pages or screens already captured: capture the steps first, then order them into a journey."
              }
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Flow</th>
                  <th className="w-28">Status</th>
                  <th className="w-20 text-right">Steps</th>
                  <th className="w-24 text-right">Publishable</th>
                  <th className="w-32">Source</th>
                  <th className="w-24">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const meta = LIFECYCLE_STATUS_META[row.status as LifecycleStatus];
                  const drift = (row.stepCount ?? 0) !== row.actualStepCount;
                  const partial =
                    row.actualStepCount > 0 && row.publishedStepCount < row.actualStepCount;
                  return (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/flows/${row.id}`} className="font-medium hover:underline">
                          {row.title ?? "Untitled flow"}
                        </Link>
                        <InlineMeta items={[row.goal, row.slug]} />
                      </td>
                      <td>
                        <Badge tone={meta.tone} title={meta.description}>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {row.actualStepCount}
                        {drift ? (
                          <span
                            className="ml-1 text-[var(--color-tone-warning)]"
                            title={`The flow record says ${row.stepCount ?? 0}.`}
                          >
                            ≠{row.stepCount ?? 0}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">
                        <span
                          className={
                            partial ? "text-[var(--color-tone-warning)]" : "text-ink-600"
                          }
                          title={
                            partial
                              ? "Some steps are not published, so the public flow would be incomplete."
                              : "Every step is published."
                          }
                        >
                          {row.publishedStepCount}
                        </span>
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
                        <Timestamp value={row.updatedAt} relative />
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
            basePath="/flows"
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            searchParams={params}
          />
          <p className="max-w-xl text-2xs leading-relaxed text-ink-500">
            A step is a reference to a content record, not a copy of it, so a page appearing in
            three flows is one record with three step rows. Publishing a flow does not publish its
            steps.
          </p>
        </div>
      </div>
    </>
  );
}
