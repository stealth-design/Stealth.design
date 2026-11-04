import Link from "next/link";
import { listJobs } from "@uxd/api";
import { formatDuration } from "@uxd/shared";
import { JOB_STATUSES, JOB_STATUS_META, type JobStatus } from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  PageHeader,
  Panel,
  ProgressBar,
  Timestamp,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Crawl jobs" };

/**
 * Crawl jobs (§6).
 *
 * Every ingestion operation is a persistent job with its own progress, counts
 * and log. The segmented progress bar is the point of this table: "80% done"
 * and "80% done, a third of it failed" are different situations, and an
 * operator needs to tell them apart without opening each job.
 */
export default async function CrawlJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const context = await getAdminContextWith("ingestion.read");
  const params = await searchParams;

  const statuses = params.status ? params.status.split(",").filter(Boolean) : undefined;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const { rows, total } = await listJobs(
    context.db,
    { statuses, q: params.q },
    { page, pageSize: 50 },
  );

  return (
    <>
      <PageHeader
        title="Crawl jobs"
        description="Every capture run, with live progress and a per-URL outcome. Pause, resume, cancel and retry from a job's own page."
        count={`${total.toLocaleString("en-US")} total`}
        actions={<LinkButton href="/ingestion" variant="primary">New ingestion</LinkButton>}
      />

      <div className="space-y-3 p-4">
        <FilterChips
          basePath="/crawl-jobs"
          paramName="status"
          active={statuses ?? []}
          searchParams={params}
          options={JOB_STATUSES.map((status) => ({
            value: status,
            label: JOB_STATUS_META[status].label,
            title: JOB_STATUS_META[status].description,
          }))}
        />

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={statuses || params.q ? "No jobs match those filters" : "No crawl jobs yet"}
              description={
                statuses || params.q
                  ? "Clear the filters to see everything."
                  : "Submit URLs to start your first capture run."
              }
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th className="w-32">Status</th>
                  <th className="w-44">Progress</th>
                  <th className="w-16 text-right">Done</th>
                  <th className="w-16 text-right">Failed</th>
                  <th className="w-16 text-right">Media</th>
                  <th className="w-20 text-right">Duration</th>
                  <th className="w-24">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => {
                  const meta = JOB_STATUS_META[job.status as JobStatus];
                  const settled =
                    job.completedCount + job.failedCount + job.skippedCount + job.blockedCount;
                  return (
                    <tr key={job.id}>
                      <td className="truncate-cell">
                        <Link href={`/crawl-jobs/${job.id}`} className="font-medium hover:underline">
                          {job.name}
                        </Link>
                        <InlineMeta
                          items={[
                            job.reference,
                            job.createdByName,
                            job.submittedCount > 0
                              ? `${job.submittedCount.toLocaleString("en-US")} submitted`
                              : null,
                            job.discoveredCount > 0
                              ? `${job.discoveredCount.toLocaleString("en-US")} discovered`
                              : null,
                          ]}
                        />
                      </td>
                      <td>
                        <Badge tone={meta.tone} title={meta.description} dot>
                          {meta.label}
                        </Badge>
                      </td>
                      <td>
                        <ProgressBar
                          total={job.totalItems}
                          segments={[
                            { value: job.completedCount, tone: "success", label: "Captured" },
                            { value: job.failedCount, tone: "danger", label: "Failed" },
                            { value: job.blockedCount, tone: "danger", label: "Blocked" },
                            { value: job.skippedCount, tone: "neutral", label: "Skipped" },
                            { value: job.runningCount, tone: "progress", label: "Capturing" },
                          ]}
                        />
                        <span className="mt-1 block text-2xs text-ink-500">
                          {settled.toLocaleString("en-US")} of {job.totalItems.toLocaleString("en-US")}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">{job.completedCount}</td>
                      <td className="text-right tabular-nums">
                        {job.failedCount > 0 ? (
                          <span className="text-[var(--color-tone-danger)]">{job.failedCount}</span>
                        ) : (
                          <span className="text-ink-400">0</span>
                        )}
                      </td>
                      <td className="text-right tabular-nums text-ink-600">{job.mediaCount}</td>
                      <td className="text-right text-ink-600">{formatDuration(job.durationMs)}</td>
                      <td>
                        <Timestamp value={job.createdAt} relative />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Pagination basePath="/crawl-jobs" page={page} pageSize={50} total={total} searchParams={params} />
      </div>
    </>
  );
}
