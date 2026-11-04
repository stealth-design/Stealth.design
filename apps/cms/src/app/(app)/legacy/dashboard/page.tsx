import Link from "next/link";
import {
  activeJobsTable,
  captureMetrics,
  getDashboardSummary,
  recentActivity,
  recentChangesTable,
  recentlyPublishedTable,
  reviewBacklogTable,
} from "@uxd/api";
import { formatDuration, pluralize } from "@uxd/shared";
import { JOB_STATUS_META, LIFECYCLE_STATUS_META, type JobStatus } from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  Note,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  Timestamp,
  formatBytes,
} from "@/components/ui/primitives";
import { getAdminContext } from "@/lib/server";

export const metadata = { title: "Dashboard" };

/**
 * The dashboard (§1).
 *
 * §1 lists eleven questions this screen must answer and says it is a control
 * center, not a showcase. So there are no charts: the summary cards answer the
 * "how much" questions and each one links to the list it counts, and the tables
 * below answer the "what needs me" and "what changed" questions with rows an
 * operator can act on.
 *
 * The most important element is the alert at the top. A queue with pending work
 * and no running workers is the single failure that makes an ingestion job look
 * broken for reasons a non-engineer cannot diagnose, so it is stated in plain
 * language, above everything else, whenever it is true.
 */
export default async function DashboardPage() {
  const context = await getAdminContext();

  const [summary, activeJobs, backlog, changes, published, activity, metrics] = await Promise.all([
    getDashboardSummary(context.db),
    activeJobsTable(context.db, 8),
    reviewBacklogTable(context.db, 8),
    recentChangesTable(context.db, 8),
    recentlyPublishedTable(context.db, 8),
    recentActivity(context.db, 12),
    captureMetrics(context.db, 7),
  ]);

  const hasNothing = summary.content.total === 0 && summary.sources.total === 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What we have, what is running, what needs a person, and what changed."
        actions={
          <>
            <LinkButton href="/ingestion">Ingest URLs</LinkButton>
            <LinkButton href="/reviews" variant="primary">
              Review queue
            </LinkButton>
          </>
        }
      />

      <div className="space-y-4 p-4">
        {/* --- Operational alerts ------------------------------------ */}
        {summary.workers.noneRunningWithWork ? (
          <Note tone="danger">
            <strong>{pluralize(summary.queue.pending, "URL")} are waiting but no capture worker is
            running.</strong>{" "}
            Nothing will be captured until one connects. Start it with{" "}
            <code className="mono">npm run dev:worker</code>, or check{" "}
            <Link href="/settings/workers" className="underline">
              Settings → Workers
            </Link>{" "}
            to see the last time one reported in.
          </Note>
        ) : null}

        {summary.queue.expiredLeases > 0 ? (
          <Note tone="warning">
            {pluralize(summary.queue.expiredLeases, "URL")} were assigned to a worker that stopped
            responding. They are returned to the queue automatically and will be retried — no action
            needed unless the count keeps growing.
          </Note>
        ) : null}

        {summary.queue.oldestPendingAgeMs !== null && summary.queue.oldestPendingAgeMs > 3_600_000 ? (
          <Note tone="warning">
            The oldest queued URL has been waiting {formatDuration(summary.queue.oldestPendingAgeMs)}.
            That usually means workers are saturated or a job is paused.
          </Note>
        ) : null}

        {hasNothing ? (
          <Panel>
            <EmptyState
              title="Nothing has been captured yet"
              description="Start by submitting a URL. The pipeline will capture it, store the screenshot with its provenance, suggest a classification, and put it in the review queue for you to approve and publish."
              action={
                <LinkButton href="/ingestion" variant="primary">
                  Submit your first URL
                </LinkButton>
              }
            />
          </Panel>
        ) : null}

        {/* --- Summary cards ----------------------------------------- */}
        <section>
          <h2 className="sr-only">Summary</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard
              label="Content"
              value={summary.content.total}
              hint={`${summary.content.published.toLocaleString("en-US")} published`}
              href="/content"
            />
            <StatCard
              label="Needs review"
              value={summary.content.needsReview}
              tone={summary.content.needsReview > 0 ? "warning" : "success"}
              hint={summary.content.needsReview > 0 ? "Waiting on a reviewer" : "Queue is clear"}
              href="/reviews"
            />
            <StatCard
              label="Needs attention"
              value={summary.content.needsAttention}
              tone={summary.content.needsAttention > 0 ? "danger" : "success"}
              hint="Failures, rights holds and blocks"
              href="/attention"
            />
            <StatCard
              label="In flight"
              value={summary.content.inFlight}
              tone={summary.content.inFlight > 0 ? "progress" : "neutral"}
              hint={`${summary.queue.pending.toLocaleString("en-US")} queued · ${summary.queue.inFlight.toLocaleString("en-US")} capturing`}
              href="/crawl-jobs"
            />
            <StatCard
              label="Sources"
              value={summary.sources.total}
              secondary={summary.sources.needsAttention > 0 ? `${summary.sources.needsAttention} flagged` : undefined}
              tone={summary.sources.needsAttention > 0 ? "warning" : undefined}
              hint={`${summary.sources.active.toLocaleString("en-US")} active`}
              href="/sources"
            />
            <StatCard
              label="Media"
              value={summary.media.total}
              secondary={formatBytes(summary.media.totalBytes)}
              hint={`${summary.media.addedLast7Days.toLocaleString("en-US")} added this week`}
              href="/media"
            />
          </div>
        </section>

        {/* --- Content by kind and pipeline position ------------------ */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            title="Content by type"
            description="How many pages, screens, flows, states and interactions we hold."
          >
            {Object.keys(summary.content.byKind).length === 0 ? (
              <EmptyState title="No content yet" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th className="text-right">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.content.byKind)
                    .sort(([, a], [, b]) => b - a)
                    .map(([kind, count]) => (
                      <tr key={kind}>
                        <td className="capitalize">
                          <Link href={`/content?kind=${kind}`} className="hover:underline">
                            {kind}
                          </Link>
                        </td>
                        <td className="text-right tabular-nums">{count.toLocaleString("en-US")}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Pipeline"
            description="Where content sits between capture and publication."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th className="text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(summary.content.byStatus)
                  .filter(([, count]) => count > 0)
                  .map(([status, count]) => {
                    const meta = LIFECYCLE_STATUS_META[status as keyof typeof LIFECYCLE_STATUS_META];
                    return (
                      <tr key={status}>
                        <td>
                          <Link href={`/content?status=${status}`}>
                            <Badge tone={meta.tone} title={meta.description} dot>
                              {meta.label}
                            </Badge>
                          </Link>
                        </td>
                        <td className="text-right tabular-nums">{count.toLocaleString("en-US")}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="Capture health"
            description="Success rate and throughput over the last seven days."
          >
            <div className="grid grid-cols-2 gap-px bg-ink-100">
              <div className="bg-surface p-3">
                <p className="text-2xs uppercase tracking-wide text-ink-500">Success rate</p>
                <p className="mt-0.5 text-lg font-semibold text-ink-900">
                  {summary.changes.captureSuccessRate7Days === null
                    ? "—"
                    : `${summary.changes.captureSuccessRate7Days}%`}
                </p>
              </div>
              <div className="bg-surface p-3">
                <p className="text-2xs uppercase tracking-wide text-ink-500">Captured (24h)</p>
                <p className="mt-0.5 text-lg font-semibold text-ink-900">
                  {summary.changes.capturedLast24h.toLocaleString("en-US")}
                </p>
              </div>
              <div className="bg-surface p-3">
                <p className="text-2xs uppercase tracking-wide text-ink-500">Changed (7d)</p>
                <p className="mt-0.5 text-lg font-semibold text-ink-900">
                  {summary.changes.changedLast7Days.toLocaleString("en-US")}
                </p>
              </div>
              <div className="bg-surface p-3">
                <p className="text-2xs uppercase tracking-wide text-ink-500">Failed items</p>
                <p className="mt-0.5 text-lg font-semibold text-ink-900">
                  {summary.jobs.failedItemsTotal.toLocaleString("en-US")}
                </p>
              </div>
            </div>
            {metrics.byErrorCode.length > 0 ? (
              <div className="border-t border-ink-100 p-3">
                <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-ink-500">
                  Most common failures
                </p>
                <ul className="space-y-1">
                  {metrics.byErrorCode.slice(0, 4).map((row) => (
                    <li key={row.errorCode} className="flex justify-between gap-2 text-xs">
                      <span className="mono truncate text-ink-600">{row.errorCode}</span>
                      <span className="shrink-0 tabular-nums text-ink-700">{row.n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>
        </div>

        {/* --- Active jobs ------------------------------------------- */}
        <Panel
          title="Ingestion in progress"
          description="Jobs currently queued, running or paused."
          actions={<LinkButton href="/crawl-jobs" size="sm" variant="ghost">All jobs</LinkButton>}
        >
          {activeJobs.length === 0 ? (
            <EmptyState
              title="No jobs running"
              description="Submit URLs to start a capture run."
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-64">Job</th>
                  <th className="w-24">Status</th>
                  <th className="w-48">Progress</th>
                  <th className="w-20 text-right">Done</th>
                  <th className="w-20 text-right">Failed</th>
                  <th className="w-24 text-right">Per min</th>
                  <th className="w-28">Started</th>
                </tr>
              </thead>
              <tbody>
                {activeJobs.map((job) => {
                  const meta = JOB_STATUS_META[job.status as JobStatus];
                  const total = job.totalItems;
                  return (
                    <tr key={job.id}>
                      <td className="truncate-cell">
                        <Link href={`/crawl-jobs/${job.id}`} className="font-medium hover:underline">
                          {job.name}
                        </Link>
                        <InlineMeta items={[job.reference, job.createdByName]} />
                      </td>
                      <td>
                        <Badge tone={meta.tone} title={meta.description} dot>
                          {meta.label}
                        </Badge>
                      </td>
                      <td>
                        <ProgressBar
                          total={total}
                          segments={[
                            { value: job.completedCount, tone: "success", label: "Captured" },
                            { value: job.failedCount, tone: "danger", label: "Failed" },
                            { value: job.runningCount, tone: "progress", label: "Capturing" },
                          ]}
                        />
                        <span className="mt-1 block text-2xs text-ink-500">
                          {job.completedCount + job.failedCount} of {total}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">{job.completedCount}</td>
                      <td className="text-right tabular-nums">
                        {job.failedCount > 0 ? (
                          <span className="text-[var(--color-tone-danger)]">{job.failedCount}</span>
                        ) : (
                          "0"
                        )}
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {job.itemsPerMinute ?? "—"}
                      </td>
                      <td>
                        <Timestamp value={job.startedAt} relative />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {/* --- Review backlog and recent changes --------------------- */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Waiting for review"
            description="Oldest first — these have been waiting longest."
            actions={<LinkButton href="/reviews" size="sm" variant="ghost">Open queue</LinkButton>}
          >
            {backlog.length === 0 ? (
              <EmptyState title="Review queue is clear" description="Nothing is waiting on a reviewer." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="w-32">Source</th>
                    <th className="w-20 text-right">Waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {backlog.map((row) => (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/content/${row.id}`} className="hover:underline">
                          {row.title ?? "Untitled"}
                        </Link>
                        <InlineMeta items={[row.kind, row.assignedToName ? `assigned to ${row.assignedToName}` : "unassigned"]} />
                      </td>
                      <td className="truncate-cell text-ink-600">{row.sourceName ?? "—"}</td>
                      <td className="text-right tabular-nums text-ink-600">
                        {row.waitingDays === 0 ? "today" : `${row.waitingDays}d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Changed recently"
            description="Pages whose content or layout moved since the previous capture."
          >
            {changes.length === 0 ? (
              <EmptyState
                title="No changes detected"
                description="Re-capture a source to see what has changed since last time."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>What changed</th>
                    <th className="w-24">When</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((row) => (
                    <tr key={row.captureId}>
                      <td className="truncate-cell">
                        <Link href={`/content/${row.contentItemId}`} className="hover:underline">
                          {row.contentTitle ?? "Untitled"}
                        </Link>
                        <InlineMeta items={[row.sourceName]} />
                      </td>
                      <td className="truncate-cell text-ink-600">
                        {String(
                          (row.changeSummary as { description?: string })?.description ?? "Changed",
                        )}
                      </td>
                      <td>
                        <Timestamp value={row.createdAt} relative />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        {/* --- Published and activity -------------------------------- */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Recently published"
            description="Live on the public API and the public site."
            actions={<LinkButton href="/published" size="sm" variant="ghost">All published</LinkButton>}
          >
            {published.length === 0 ? (
              <EmptyState
                title="Nothing published yet"
                description="Approve content in the review queue, then publish it."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="w-32">Published by</th>
                    <th className="w-24">When</th>
                  </tr>
                </thead>
                <tbody>
                  {published.map((row) => (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/content/${row.id}`} className="hover:underline">
                          {row.title ?? "Untitled"}
                        </Link>
                        <InlineMeta items={[row.kind, row.sourceName]} />
                      </td>
                      <td className="truncate-cell text-ink-600">{row.publishedByName ?? "—"}</td>
                      <td>
                        <Timestamp value={row.publishedAt} relative />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Recent activity"
            description="Consequential changes from the audit log."
            actions={<LinkButton href="/audit" size="sm" variant="ghost">Audit log</LinkButton>}
          >
            {activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {activity.map((event) => (
                  <li key={event.id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                    <span className="min-w-0 truncate text-xs text-ink-700">{event.sentence}</span>
                    <span className="shrink-0 text-2xs text-ink-500">
                      <Timestamp value={event.createdAt} relative />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
