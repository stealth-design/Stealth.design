import Link from "next/link";
import { notFound } from "next/navigation";
import { getJobDetail, listJobItems, listJobLog, listJobUrls } from "@uxd/api";
import { formatDuration } from "@uxd/shared";
import {
  JOB_ITEM_STATUSES,
  JOB_ITEM_STATUS_META,
  JOB_STATUS_META,
  URL_VALIDATION_OUTCOME_META,
  type JobItemStatus,
  type JobStatus,
  type UrlValidationOutcome,
  jobEventSentence,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  Field,
  FieldList,
  InlineMeta,
  MonoValue,
  PageHeader,
  Panel,
  ProgressBar,
  Timestamp,
  formatBytes,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { JobControls } from "./controls";
import { AutoRefresh } from "@/components/auto-refresh";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Crawl job" };

/**
 * Crawl job detail (§6, §24).
 *
 * Everything §6 asks a job to record: its configuration, its counts, its
 * per-URL outcomes, the submitted-URL breakdown including the rejects, and a
 * log that reads as English.
 *
 * While the job is running the page auto-refreshes. That is a deliberate choice
 * over websockets: this is one screen an operator leaves open for minutes, a
 * few seconds of staleness costs nothing, and a polling refresh has no
 * connection state to get wrong or to reconnect.
 */
export default async function CrawlJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; itemStatus?: string; urlOutcome?: string; page?: string; level?: string }>;
}) {
  const context = await getAdminContextWith("ingestion.read");
  const { id } = await params;
  const query = await searchParams;

  const detail = await getJobDetail(context.db, id);
  if (!detail) notFound();

  const job = detail.job;
  const meta = JOB_STATUS_META[job.status as JobStatus];
  const tab = query.tab ?? "items";
  const page = Math.max(1, Number(query.page ?? 1) || 1);

  const itemStatuses = query.itemStatus ? query.itemStatus.split(",").filter(Boolean) : undefined;
  const levels = query.level ? query.level.split(",").filter(Boolean) : undefined;

  const [items, urls, log] = await Promise.all([
    tab === "items"
      ? listJobItems(context.db, id, { statuses: itemStatuses }, { page, pageSize: 100 })
      : Promise.resolve({ rows: [], total: 0 }),
    tab === "urls"
      ? listJobUrls(context.db, id, query.urlOutcome, { page, pageSize: 100 })
      : Promise.resolve({ rows: [], total: 0 }),
    tab === "log" ? listJobLog(context.db, id, levels, 300) : Promise.resolve([]),
  ]);

  const totalItems = Object.values(detail.itemsByStatus).reduce((sum, n) => sum + n, 0);
  const settled =
    job.completedCount + job.failedCount + job.skippedCount + job.blockedCount;
  const isActive = meta.isActive || job.status === "paused" || job.status === "cancelling";

  const baseHref = `/crawl-jobs/${id}`;
  const tabHref = (name: string) => `${baseHref}?tab=${name}`;

  return (
    <>
      {/* Only poll while there is something to watch. */}
      {isActive ? <AutoRefresh intervalMs={4000} /> : null}

      <PageHeader
        breadcrumb={[{ label: "Crawl jobs", href: "/crawl-jobs" }]}
        title={job.name}
        description={meta.description}
        count={job.reference}
        actions={<JobControls jobId={id} status={job.status as JobStatus} />}
      />

      <div className="space-y-4 p-4">
        {/* --- Progress ---------------------------------------------- */}
        <Panel>
          <div className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={meta.tone} title={meta.description} dot>
                {meta.label}
              </Badge>
              <InlineMeta
                items={[
                  `${settled.toLocaleString("en-US")} of ${totalItems.toLocaleString("en-US")} settled`,
                  detail.timing?.avgMs ? `avg ${formatDuration(detail.timing.avgMs)}` : null,
                  detail.timing?.p95Ms ? `p95 ${formatDuration(detail.timing.p95Ms)}` : null,
                  detail.timing?.completedLastMinute
                    ? `${detail.timing.completedLastMinute}/min`
                    : null,
                  job.durationMs ? `ran ${formatDuration(job.durationMs)}` : null,
                ]}
              />
            </div>
            <ProgressBar
              total={totalItems}
              segments={[
                { value: job.completedCount, tone: "success", label: "Captured" },
                { value: job.failedCount, tone: "danger", label: "Failed" },
                { value: job.blockedCount, tone: "danger", label: "Blocked" },
                { value: job.skippedCount, tone: "neutral", label: "Skipped" },
                { value: job.runningCount, tone: "progress", label: "Capturing" },
                { value: job.queuedCount, tone: "info", label: "Queued" },
              ]}
            />
          </div>

          <div className="grid grid-cols-2 gap-px border-t border-ink-100 bg-ink-100 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="Submitted" value={job.submittedCount} />
            <Metric label="Queued" value={job.queuedCount} tone={job.queuedCount > 0 ? "info" : undefined} />
            <Metric label="Capturing" value={job.runningCount} tone={job.runningCount > 0 ? "progress" : undefined} />
            <Metric label="Captured" value={job.completedCount} tone="success" />
            <Metric label="Failed" value={job.failedCount} tone={job.failedCount > 0 ? "danger" : undefined} />
            <Metric label="Discovered" value={job.discoveredCount} />
            <Metric label="Media" value={job.mediaCount} />
            <Metric label="Stored" value={formatBytes(job.bytesStored)} />
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          {/* --- Tabs: items / urls / log --------------------------- */}
          <div className="min-w-0 space-y-3">
            <nav className="flex gap-1 border-b border-ink-200" aria-label="Job details">
              {[
                { name: "items", label: `Queue (${totalItems})` },
                { name: "urls", label: `Submitted (${job.submittedCount})` },
                { name: "log", label: "Log" },
                { name: "hosts", label: `Domains (${detail.byHost.length})` },
              ].map((entry) => (
                <Link
                  key={entry.name}
                  href={tabHref(entry.name)}
                  className={
                    tab === entry.name
                      ? "-mb-px border-b-2 border-[var(--color-accent)] px-2.5 py-1.5 text-xs font-medium text-ink-900"
                      : "px-2.5 py-1.5 text-xs text-ink-500 hover:text-ink-800"
                  }
                >
                  {entry.label}
                </Link>
              ))}
            </nav>

            {tab === "items" ? (
              <>
                <FilterChips
                  basePath={baseHref}
                  paramName="itemStatus"
                  active={itemStatuses ?? []}
                  searchParams={{ ...query, tab: "items" }}
                  options={JOB_ITEM_STATUSES.filter(
                    (status) => (detail.itemsByStatus[status] ?? 0) > 0,
                  ).map((status) => ({
                    value: status,
                    label: JOB_ITEM_STATUS_META[status].label,
                    title: JOB_ITEM_STATUS_META[status].description,
                    count: detail.itemsByStatus[status],
                  }))}
                />
                <Panel>
                  {items.rows.length === 0 ? (
                    <EmptyState title="No URLs match those filters" />
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>URL</th>
                          <th className="w-32">Status</th>
                          <th className="w-12 text-right">Try</th>
                          <th className="w-14 text-right">HTTP</th>
                          <th className="w-20 text-right">Took</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.rows.map(({ item, contentTitle, contentStatus }) => {
                          const itemMeta = JOB_ITEM_STATUS_META[item.status as JobItemStatus];
                          return (
                            <tr key={item.id}>
                              <td className="truncate-cell">
                                <MonoValue value={item.url} truncate />
                                {item.depth > 0 ? (
                                  <InlineMeta
                                    items={[
                                      `depth ${item.depth}`,
                                      item.discoveredFromUrl ? "discovered" : null,
                                    ]}
                                  />
                                ) : null}
                              </td>
                              <td>
                                <Badge tone={itemMeta.tone} title={itemMeta.description} dot>
                                  {itemMeta.label}
                                </Badge>
                              </td>
                              <td className="text-right tabular-nums text-ink-600">
                                {item.attempts}/{item.maxAttempts}
                              </td>
                              <td className="text-right tabular-nums text-ink-600">
                                {item.httpStatus ?? "—"}
                              </td>
                              <td className="text-right text-ink-600">
                                {formatDuration(item.durationMs)}
                              </td>
                              <td className="truncate-cell">
                                {item.contentItemId ? (
                                  <Link
                                    href={`/content/${item.contentItemId}`}
                                    className="text-xs hover:underline"
                                  >
                                    {contentTitle ?? "View content"}
                                  </Link>
                                ) : item.errorMessage ? (
                                  <span
                                    className="text-2xs text-[var(--color-tone-danger)]"
                                    title={`${item.errorCode ?? ""} ${item.errorMessage}`}
                                  >
                                    {item.errorMessage}
                                  </span>
                                ) : (
                                  <span className="text-ink-400">—</span>
                                )}
                                {contentStatus ? <InlineMeta items={[contentStatus]} /> : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Panel>
                <Pagination
                  basePath={baseHref}
                  page={page}
                  pageSize={100}
                  total={items.total}
                  searchParams={{ ...query, tab: "items" }}
                />
              </>
            ) : null}

            {tab === "urls" ? (
              <>
                <FilterChips
                  basePath={baseHref}
                  paramName="urlOutcome"
                  active={query.urlOutcome ? [query.urlOutcome] : []}
                  searchParams={{ ...query, tab: "urls" }}
                  options={Object.entries(detail.urlOutcomes).map(([outcome, count]) => ({
                    value: outcome,
                    label: URL_VALIDATION_OUTCOME_META[outcome as UrlValidationOutcome].label,
                    title: URL_VALIDATION_OUTCOME_META[outcome as UrlValidationOutcome].description,
                    count,
                  }))}
                />
                <Panel
                  title="Everything that was submitted"
                  description="Including the URLs that were refused, with the reason. Kept so a job explains what happened to all of its input."
                >
                  {urls.rows.length === 0 ? (
                    <EmptyState title="No submitted URLs match" />
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th className="w-12 text-right">#</th>
                          <th>URL as submitted</th>
                          <th className="w-36">Outcome</th>
                          <th className="w-16 text-center">In job</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {urls.rows.map((row) => {
                          const outcomeMeta =
                            URL_VALIDATION_OUTCOME_META[row.outcome as UrlValidationOutcome];
                          return (
                            <tr key={row.id}>
                              <td className="text-right text-2xs text-ink-400">{row.lineNumber}</td>
                              <td className="truncate-cell">
                                <MonoValue value={row.rawUrl} truncate />
                              </td>
                              <td>
                                <Badge
                                  tone={
                                    row.outcome === "valid"
                                      ? "success"
                                      : row.outcome === "already_in_database" || row.outcome === "unreachable"
                                        ? "warning"
                                        : row.outcome === "duplicate_in_batch"
                                          ? "neutral"
                                          : "danger"
                                  }
                                  title={outcomeMeta.description}
                                >
                                  {outcomeMeta.label}
                                </Badge>
                              </td>
                              <td className="text-center">
                                {row.included ? (
                                  <span className="text-[var(--color-tone-success)]">yes</span>
                                ) : (
                                  <span className="text-ink-400">no</span>
                                )}
                              </td>
                              <td className="truncate-cell text-2xs text-ink-600" title={row.reasonMessage ?? ""}>
                                {row.reasonMessage ?? "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Panel>
                <Pagination
                  basePath={baseHref}
                  page={page}
                  pageSize={100}
                  total={urls.total}
                  searchParams={{ ...query, tab: "urls" }}
                />
              </>
            ) : null}

            {tab === "log" ? (
              <>
                <FilterChips
                  basePath={baseHref}
                  paramName="level"
                  active={levels ?? []}
                  searchParams={{ ...query, tab: "log" }}
                  options={[
                    { value: "error", label: "Errors" },
                    { value: "warn", label: "Warnings" },
                    { value: "info", label: "Info" },
                    { value: "debug", label: "Debug" },
                  ]}
                />
                <Panel
                  title="Job log"
                  description="Written for a person to read. Expand a row for the structured detail behind it."
                >
                  {log.length === 0 ? (
                    <EmptyState title="Nothing logged yet" />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {log.map((event) => (
                        <li key={event.id} className="px-3 py-1.5">
                          <div className="flex items-baseline gap-2">
                            <Badge
                              tone={
                                event.level === "error"
                                  ? "danger"
                                  : event.level === "warn"
                                    ? "warning"
                                    : event.level === "debug"
                                      ? "neutral"
                                      : "info"
                              }
                            >
                              {event.level}
                            </Badge>
                            <span className="min-w-0 flex-1 text-xs text-ink-800">
                              {event.message ?? jobEventSentence(event.code)}
                            </span>
                            <span className="shrink-0 text-2xs text-ink-500">
                              <Timestamp value={event.createdAt} relative />
                            </span>
                          </div>
                          {Object.keys(event.data ?? {}).length > 0 ? (
                            <details className="mt-0.5">
                              <summary className="cursor-pointer text-2xs text-ink-500 hover:text-ink-700">
                                {event.code}
                                {event.actor ? ` · ${event.actor}` : ""}
                              </summary>
                              <pre className="mono mt-1 overflow-x-auto rounded-[3px] bg-ink-50 p-2 text-2xs text-ink-700">
                                {JSON.stringify(event.data, null, 2)}
                              </pre>
                            </details>
                          ) : (
                            <p className="mt-0.5 text-2xs text-ink-400">
                              {event.code}
                              {event.actor ? ` · ${event.actor}` : ""}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </>
            ) : null}

            {tab === "hosts" ? (
              <Panel
                title="Per-domain progress"
                description="Each domain's share of the job, and its own page limit."
              >
                {detail.byHost.length === 0 ? (
                  <EmptyState title="No domains yet" />
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Domain</th>
                        <th className="w-20 text-right">Total</th>
                        <th className="w-20 text-right">Captured</th>
                        <th className="w-20 text-right">Failed</th>
                        <th className="w-32">Progress</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.byHost.map((host) => (
                        <tr key={host.host}>
                          <td className="truncate-cell">
                            <MonoValue value={host.host} truncate />
                          </td>
                          <td className="text-right tabular-nums">{host.total}</td>
                          <td className="text-right tabular-nums">{host.done}</td>
                          <td className="text-right tabular-nums">
                            {host.failed > 0 ? (
                              <span className="text-[var(--color-tone-danger)]">{host.failed}</span>
                            ) : (
                              "0"
                            )}
                          </td>
                          <td>
                            <ProgressBar
                              total={host.total}
                              segments={[
                                { value: host.done, tone: "success", label: "Captured" },
                                { value: host.failed, tone: "danger", label: "Failed" },
                              ]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            ) : null}
          </div>

          {/* --- Configuration and provenance ----------------------- */}
          <aside className="space-y-3">
            <Panel title="Configuration" description="What this job was told to do.">
              <FieldList>
                <Field
                  label="Capture level"
                  hint="How hard the crawl looks. Neither level creates content."
                >
                  {job.config.maxCaptureLevel === 1
                    ? "1 — plain HTTP fetch, no browser"
                    : "2 — rendered in Chromium, for sites that build themselves in JavaScript"}
                </Field>
                <Field
                  label="Triage previews"
                  hint="A small thumbnail for the candidate list. Never attached to a screen."
                >
                  {job.config.capturePreview ? `on — ${job.config.previewProfile}` : "off"}
                </Field>
                <Field
                  label="Link discovery"
                  hint="Off means exactly the submitted URLs were captured."
                >
                  {job.config.crawlInternalLinks
                    ? `on — depth ${job.config.maxDepth}, ${job.config.maxPagesPerDomain}/domain, ${job.config.maxPagesTotal} total`
                    : "off"}
                </Field>
                <Field label="robots.txt">
                  {job.config.respectRobots ? (
                    "respected"
                  ) : (
                    <span className="text-[var(--color-tone-danger)]">
                      overridden — {job.config.robotsOverrideReason ?? "no reason recorded"}
                    </span>
                  )}
                </Field>
                <Field label="Rate limit">
                  {job.config.requestsPerMinutePerDomain}/min per domain
                </Field>
                <Field label="Attempts">{job.config.maxAttempts} per URL</Field>
                <Field
                  label="What this produces"
                  hint="A crawl discovers. Screens are captured by a person in the studio."
                >
                  Candidates in the discovery queue
                </Field>
              </FieldList>
            </Panel>

            <Panel title="Provenance">
              <FieldList>
                <Field label="Reference" mono>
                  {job.reference}
                </Field>
                <Field label="Created by">{detail.createdByName ?? "—"}</Field>
                <Field label="Created">
                  <Timestamp value={job.createdAt} />
                </Field>
                <Field label="Started">
                  <Timestamp value={job.startedAt} />
                </Field>
                <Field label="Finished">
                  <Timestamp value={job.finishedAt} />
                </Field>
                <Field label="Duration">{formatDuration(job.durationMs)}</Field>
                {detail.sourceName ? <Field label="Source">{detail.sourceName}</Field> : null}
                {job.notes ? <Field label="Notes">{job.notes}</Field> : null}
              </FieldList>
            </Panel>

            {Object.keys(job.errorSummary ?? {}).length > 0 ? (
              <Panel title="Error summary">
                <FieldList>
                  {Object.entries(job.errorSummary).map(([code, count]) => (
                    <Field key={code} label={code}>
                      {String(count)}
                    </Field>
                  ))}
                </FieldList>
              </Panel>
            ) : null}
          </aside>
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "info" | "progress" | "success" | "danger";
}) {
  const color =
    tone === "danger"
      ? "text-[var(--color-tone-danger)]"
      : tone === "success"
        ? "text-[var(--color-tone-success)]"
        : tone === "progress"
          ? "text-[var(--color-tone-progress)]"
          : tone === "info"
            ? "text-[var(--color-tone-info)]"
            : "text-ink-900";
  return (
    <div className="bg-surface p-2.5">
      <p className="text-2xs uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${color}`}>
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </p>
    </div>
  );
}
