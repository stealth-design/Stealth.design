import Link from "next/link";
import { auditActionCounts, listAuditEvents } from "@uxd/api";
import { AUDIT_ENTITY_TYPES, type AuditAction, type AuditEntityType } from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  MonoValue,
  PageHeader,
  Panel,
  Timestamp,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Audit log" };

const PAGE_SIZE = 100;

/** Where a record of this entity type can be opened, when it still exists. */
const ENTITY_ROUTES: Partial<Record<AuditEntityType, string>> = {
  content: "/content",
  source: "/sources",
  media: "/media",
  crawl_job: "/crawl-jobs",
  collection: "/collections",
  taxonomy_term: "/patterns",
};

/**
 * The audit log (§17).
 *
 * Append-only, and rendered as sentences rather than as a diff table, because
 * the primary reader is a person asking "who changed this and when" — a
 * question a sentence answers and a column of JSON does not. The before/after
 * detail is there for the rows whose action declares a snapshot, shown inline
 * and only for the keys that actually changed.
 *
 * Bulk operations are the reason for the batch column. Approving forty records
 * writes forty rows plus one summary row; the summary is what appears in the
 * list, with its size, and the batch filter opens the forty. Without that a
 * single afternoon of bulk work would bury everything else.
 *
 * `actorLabel` comes from the event, not from a join: capturing the name at
 * write time is what keeps the trail readable after a user is deleted.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("audit.read");
  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const entityTypes = params.entity?.split(",").filter(Boolean) as
    | AuditEntityType[]
    | undefined;
  const actions = params.action?.split(",").filter(Boolean) as AuditAction[] | undefined;

  const [{ rows, total }, actionCounts] = await Promise.all([
    listAuditEvents(context.db, {
      q: params.q,
      entityTypes,
      actions,
      actorId: params.actor,
      entityId: params.entityId,
      batchId: params.batch,
      significantOnly: params.significant === "1",
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    auditActionCounts(context.db),
  ]);

  const presentEntityTypes = AUDIT_ENTITY_TYPES.filter((type) =>
    rows.some((row) => row.entityType === type),
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every consequential change, who made it and what it was before. Append-only."
        count={`${total.toLocaleString("en-US")} events`}
      />

      <div className="space-y-3 p-4">
        {params.batch ? (
          <p className="text-2xs text-ink-600">
            Showing one bulk operation.{" "}
            <Link href="/audit" className="underline">
              Back to everything
            </Link>
            .
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search records, people, actions…"
              className="h-7 w-64 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2.5 text-xs hover:bg-ink-100"
            >
              Search
            </button>
          </form>

          <FilterChips
            basePath="/audit"
            paramName="significant"
            active={params.significant === "1" ? ["1"] : []}
            searchParams={params}
            options={[
              {
                value: "1",
                label: "Consequential only",
                title: "Hide routine reads and bookkeeping; show decisions and changes.",
              },
            ]}
          />
          <FilterChips
            basePath="/audit"
            paramName="entity"
            active={entityTypes ?? []}
            searchParams={params}
            options={(presentEntityTypes.length > 0 ? presentEntityTypes : AUDIT_ENTITY_TYPES).map(
              (type) => ({ value: type, label: type.replace(/_/g, " ") }),
            )}
          />
        </div>

        {actionCounts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs uppercase tracking-wide text-ink-400">Actions</span>
            <FilterChips
              basePath="/audit"
              paramName="action"
              active={actions ?? []}
              searchParams={params}
              options={actionCounts.slice(0, 18).map((entry) => ({
                value: entry.action,
                label: `${entry.label} (${entry.count})`,
                title: entry.action,
              }))}
            />
          </div>
        ) : null}

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={
                Object.keys(params).length > 0 ? "Nothing matches those filters" : "No events yet"
              }
              description={
                Object.keys(params).length > 0
                  ? "Clear the filters to see the whole trail."
                  : "Every consequential change is recorded here as it happens: ingestion, capture, review decisions, publishing, rights changes and settings."
              }
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-32">When</th>
                  <th>What happened</th>
                  <th className="w-28">Entity</th>
                  <th className="w-40">Person</th>
                  <th className="w-20">Batch</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const route = ENTITY_ROUTES[row.entityType as AuditEntityType];
                  const changed = changedKeys(row.before, row.after);
                  return (
                    <tr key={row.id}>
                      <td>
                        <Timestamp value={row.createdAt} relative />
                      </td>

                      <td className="truncate-cell">
                        <p className="text-ink-800">
                          {row.sentence}
                          {!row.significant ? (
                            <span
                              className="ml-1.5 text-2xs text-ink-400"
                              title="Routine bookkeeping rather than a decision."
                            >
                              routine
                            </span>
                          ) : null}
                        </p>
                        {changed.length > 0 ? (
                          <p className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-ink-500">
                            {changed.map(({ key, from, to }) => (
                              <span key={key}>
                                <span className="mono text-ink-600">{key}</span>{" "}
                                <span className="text-ink-400">{from}</span>
                                {" → "}
                                <span className="text-ink-700">{to}</span>
                              </span>
                            ))}
                          </p>
                        ) : null}
                        <InlineMeta
                          items={[
                            row.action,
                            typeof row.context.reason === "string" ? `"${row.context.reason}"` : null,
                          ]}
                        />
                      </td>

                      <td className="truncate-cell">
                        {route && row.entityId ? (
                          <Link href={`${route}/${row.entityId}`} className="hover:underline">
                            {row.entityLabel ?? row.entityType.replace(/_/g, " ")}
                          </Link>
                        ) : (
                          <span className="text-ink-600">
                            {row.entityLabel ?? row.entityType.replace(/_/g, " ")}
                          </span>
                        )}
                      </td>

                      <td className="truncate-cell">
                        <span className="text-ink-700">{row.actorLabel ?? "—"}</span>
                        {row.actorType !== "user" ? (
                          <Badge tone="neutral" title="Not a person: a worker or a scheduled task.">
                            {row.actorType}
                          </Badge>
                        ) : null}
                      </td>

                      <td>
                        {row.batchId && row.batchSize > 1 ? (
                          <Link
                            href={`/audit?batch=${row.batchId}`}
                            className="text-2xs hover:underline"
                            title="Open every row of this bulk operation."
                          >
                            {row.batchSize} rows
                          </Link>
                        ) : (
                          <span className="text-2xs text-ink-400">—</span>
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
            basePath="/audit"
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            searchParams={params}
          />
          <p className="max-w-xl text-2xs leading-relaxed text-ink-500">
            The trail is append-only: nothing here can be edited or deleted through the
            application. Only the keys that changed are stored, never a whole row, and a setting
            marked sensitive records that it changed without recording to what. Correlate with the
            structured logs using <MonoValue value="requestId" />.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * The keys that actually differ between two snapshots.
 *
 * Rendering the whole `before` object would drown the sentence it is meant to
 * qualify. Values are truncated hard: an audit row is a pointer to a change,
 * not a place to read a page's text.
 */
function changedKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { key: string; from: string; to: string }[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: { key: string; from: string; to: string }[] = [];
  for (const key of keys) {
    const from = render(before[key]);
    const to = render(after[key]);
    if (from !== to) changes.push({ key, from, to });
  }
  return changes.slice(0, 4);
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return "…";
}
