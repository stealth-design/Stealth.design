import Link from "next/link";
import { notFound } from "next/navigation";
import {
  discoveryCountsForSource,
  getSourceDetail,
  listFlows,
  listScreens,
} from "@uxd/api";
import {
  CONTENT_KINDS,
  CONTENT_KIND_META,
  JOB_STATUS_META,
  LIFECYCLE_STATUSES,
  LIFECYCLE_STATUS_META,
  RIGHTS_STATUS_META,
  ROBOTS_STATUS_META,
  SOURCE_HEALTH_META,
  type ContentKind,
  type JobStatus,
  type LifecycleStatus,
  type RightsStatus,
  type RobotsStatus,
  type SourceHealth,
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
  SectionLabel,
  Thumbnail,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { SourceActions } from "./actions";
import { SourceWorkflow } from "./workflow";

export const metadata = { title: "Source" };

/**
 * A source's overview (§3: "show me everything from this product").
 *
 * The shape answers three questions in order, because that is the order they
 * get asked: what do we hold from this source, is it healthy, and what is its
 * rights position. Capture history sits below because it is the evidence for
 * the health verdict rather than the verdict itself.
 *
 * Internal notes and the crawl log live here and are never serialised to the
 * public API (§19) — the public source record carries name, domain and
 * attribution only.
 */
export default async function SourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContextWith("source.read");
  const { id } = await params;

  const detail = await getSourceDetail(context.db, id);
  if (!detail) notFound();

  const { source, contentByKind, contentByStatus, recentCaptures, jobs, mediaSample } = detail;
  const health = SOURCE_HEALTH_META[source.health as SourceHealth];
  const rights = RIGHTS_STATUS_META[source.rightsStatus as RightsStatus];
  const robots = source.robotsStatus
    ? ROBOTS_STATUS_META[source.robotsStatus as RobotsStatus]
    : null;

  const mediaUrls = await resolveMediaUrls([
    ...mediaSample.map((asset) => asset.thumbnailKey),
    ...mediaSample.map((asset) => asset.storageKey),
  ]);

  // Counts only — the lists themselves live on their own screens. A source page
  // that tried to render every candidate would be the discovery queue with a
  // different heading.
  const [discovery, screens, flows] = await Promise.all([
    discoveryCountsForSource(context.db, id),
    listScreens(context.db, { sourceId: id }, { page: 1, pageSize: 1 }),
    listFlows(context.db, { sourceId: id }, { page: 1, pageSize: 1 }),
  ]);

  const totalContent = Object.values(contentByStatus).reduce((sum, n) => sum + n, 0);
  const publishedCount = contentByStatus.published ?? 0;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Sources", href: "/sources" }]}
        title={source.name}
        description={source.description ?? undefined}
        count={source.domain ?? undefined}
        actions={
          <SourceActions
            sourceId={source.id}
            health={source.health as SourceHealth}
            publishedCount={publishedCount}
            totalCount={totalContent}
          />
        }
      />

      <div className="space-y-4 p-4">
        {/*
          The pipeline for this product, in the order it runs (§14).

          Three numbers and three buttons. It sits above everything else on the
          page because it answers the question a researcher opens a source to
          ask — "what is there, what have we taken, and what do I do next?" —
          and the health and rights panels below answer questions they ask much
          less often.
        */}
        <SourceWorkflow
          sourceId={source.id}
          sourceName={source.name}
          homeUrl={source.domain ? `https://${source.domain}` : null}
          discovery={discovery}
          screenCount={screens.total}
          flowCount={flows.total}
        />

        {/* --- Health, stated with its reason ------------------------- */}
        <Panel>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Badge tone={health.tone}>{health.label}</Badge>
              <span className="text-2xs text-ink-500">{health.description}</span>
            </div>
            {source.consecutiveFailures > 0 ? (
              <span className="text-2xs text-[var(--color-tone-danger)]">
                {source.consecutiveFailures} consecutive capture failures
              </span>
            ) : null}
            {source.crawlBlockedAt ? (
              <span className="text-2xs text-[var(--color-tone-danger)]">
                Crawling blocked: {source.crawlBlockedReason ?? "no reason recorded"}
              </span>
            ) : null}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-3">
          {/* --- What we hold --------------------------------------- */}
          <div className="space-y-4 lg:col-span-2">
            <Panel
              title="What we hold"
              description={`${totalContent.toLocaleString("en-US")} records, ${publishedCount.toLocaleString("en-US")} published.`}
            >
              {totalContent === 0 ? (
                <EmptyState
                  title="Nothing captured yet"
                  description="This source exists but has no content records against it."
                  action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
                />
              ) : (
                <div className="space-y-3 p-3">
                  <div>
                    <SectionLabel>By kind</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {CONTENT_KINDS.filter((kind) => (contentByKind[kind] ?? 0) > 0).map((kind) => (
                        <Link
                          key={kind}
                          href={`/content?source=${source.id}&kind=${kind}`}
                          className="flex items-center gap-1.5 rounded-[4px] border border-ink-200 px-2 py-1 text-2xs hover:bg-ink-100"
                          title={CONTENT_KIND_META[kind as ContentKind].description}
                        >
                          <span className="text-ink-700">
                            {CONTENT_KIND_META[kind as ContentKind].label}
                          </span>
                          <span className="tabular-nums font-medium text-ink-900">
                            {(contentByKind[kind] ?? 0).toLocaleString("en-US")}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>

                  <div>
                    <SectionLabel>By pipeline stage</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {LIFECYCLE_STATUSES.filter((status) => (contentByStatus[status] ?? 0) > 0).map(
                        (status) => {
                          const meta = LIFECYCLE_STATUS_META[status as LifecycleStatus];
                          return (
                            <Link
                              key={status}
                              href={`/content?source=${source.id}&status=${status}`}
                              title={meta.description}
                              className="flex items-center gap-1.5 rounded-[4px] border border-ink-200 px-2 py-1 text-2xs hover:bg-ink-100"
                            >
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                              <span className="tabular-nums font-medium text-ink-900">
                                {(contentByStatus[status] ?? 0).toLocaleString("en-US")}
                              </span>
                            </Link>
                          );
                        },
                      )}
                    </div>
                  </div>
                </div>
              )}
            </Panel>

            {/* --- Capture history: the evidence for the health verdict */}
            <Panel
              title="Capture history"
              description="The last 25 captures against this source, newest first."
              actions={
                <Link
                  href={`/content?source=${source.id}`}
                  className="text-2xs text-ink-600 hover:underline"
                >
                  All content →
                </Link>
              }
            >
              {recentCaptures.length === 0 ? (
                <EmptyState title="No captures yet" description="Nothing has been fetched from this source." />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-24">When</th>
                      <th className="w-20">Result</th>
                      <th>Page</th>
                      <th className="w-16 text-right">HTTP</th>
                      <th className="w-20 text-right">Load</th>
                      <th className="w-16 text-right">Files</th>
                      <th className="w-20">Changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentCaptures.map(({ capture, contentTitle, contentId }) => (
                      <tr key={capture.id}>
                        <td>
                          <Timestamp value={capture.createdAt} relative />
                        </td>
                        <td>
                          <Badge
                            tone={
                              capture.status === "succeeded"
                                ? "success"
                                : capture.status === "partial"
                                  ? "warning"
                                  : "danger"
                            }
                          >
                            {capture.status}
                          </Badge>
                        </td>
                        <td className="truncate-cell">
                          {contentId ? (
                            <Link href={`/content/${contentId}`} className="hover:underline">
                              {contentTitle ?? capture.requestedUrl ?? capture.id.slice(0, 8)}
                            </Link>
                          ) : (
                            <MonoValue value={capture.requestedUrl} truncate />
                          )}
                          <InlineMeta
                            items={[
                              capture.method,
                              capture.deviceProfile,
                              `level ${capture.captureLevel}`,
                              capture.errorCode,
                            ]}
                          />
                        </td>
                        <td className="text-right tabular-nums text-ink-600">
                          {capture.httpStatus ?? "—"}
                        </td>
                        <td className="text-right tabular-nums text-ink-600">
                          {capture.loadTimeMs ? `${capture.loadTimeMs}ms` : "—"}
                        </td>
                        <td className="text-right tabular-nums text-ink-600">
                          {capture.screenshotCount + capture.mediaCount}
                        </td>
                        <td>
                          {capture.changed === null ? (
                            <span className="text-2xs text-ink-400">first</span>
                          ) : capture.changed ? (
                            <Badge tone="info">changed</Badge>
                          ) : (
                            <span className="text-2xs text-ink-400">same</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            {/* --- Media sample --------------------------------------- */}
            {mediaSample.length > 0 ? (
              <Panel
                title="Recent media"
                actions={
                  <Link
                    href={`/media?source=${source.id}`}
                    className="text-2xs text-ink-600 hover:underline"
                  >
                    All media →
                  </Link>
                }
              >
                <div className="grid grid-cols-4 gap-2 p-3 sm:grid-cols-6">
                  {mediaSample.map((asset) => (
                    <Link key={asset.id} href={`/media/${asset.id}`} className="block min-w-0">
                      <Thumbnail
                        url={
                          (asset.thumbnailKey ? mediaUrls.get(asset.thumbnailKey) : undefined) ??
                          mediaUrls.get(asset.storageKey) ??
                          null
                        }
                        alt=""
                        width={160}
                        height={110}
                        className="w-full hover:border-ink-400"
                      />
                    </Link>
                  ))}
                </div>
              </Panel>
            ) : null}
          </div>

          {/* --- Facts, rights and provenance ------------------------ */}
          <div className="space-y-4">
            <Panel title="Source">
              <FieldList>
                <Field label="Domain" mono>
                  {source.domain}
                </Field>
                <Field label="Canonical URL" mono>
                  {source.canonicalUrl ? (
                    <span className="break-all">{source.canonicalUrl}</span>
                  ) : null}
                </Field>
                <Field label="Type">{source.type}</Field>
                <Field label="Module" hint="Which content module this source belongs to.">
                  {source.module}
                </Field>
                <Field label="Company">{source.companyName}</Field>
                <Field label="Product">{source.productName}</Field>
                <Field label="Platforms">
                  {source.platforms.length > 0 ? source.platforms.join(", ") : null}
                </Field>
                <Field label="Slug" mono>
                  {source.slug}
                </Field>
                <Field label="Source ID" mono>
                  {source.id}
                </Field>
              </FieldList>
            </Panel>

            <Panel
              title="Rights"
              description="Operational labels recording what the team knows. Not legal determinations."
            >
              <FieldList>
                <Field label="Status">
                  <Badge tone={rights.tone} title={rights.description}>
                    {rights.label}
                  </Badge>
                  {rights.blocksPublishing ? (
                    <span className="ml-1.5 text-2xs text-[var(--color-tone-warning)]">
                      blocks publishing
                    </span>
                  ) : null}
                </Field>
                <Field label="Owner">{source.rightsOwner}</Field>
                <Field label="Attribution">{source.attribution}</Field>
                <Field label="Permission">{source.permissionStatus}</Field>
                <Field label="Takedown">{source.takedownStatus}</Field>
                <Field label="Legal review">{source.legalReviewStatus}</Field>
                <Field label="Notes">
                  {source.rightsNotes ? (
                    <span className="whitespace-pre-wrap">{source.rightsNotes}</span>
                  ) : null}
                </Field>
              </FieldList>
            </Panel>

            <Panel title="Capture policy">
              <FieldList>
                <Field label="robots.txt" hint={robots?.description}>
                  {robots ? <span title={robots.description}>{robots.label}</span> : null}
                </Field>
                <Field label="robots checked">
                  <Timestamp value={source.robotsCheckedAt} />
                </Field>
                <Field
                  label="Rate limit override"
                  hint="Requests per minute for this host, if the global default was changed for it."
                >
                  {source.requestsPerMinuteOverride
                    ? `${source.requestsPerMinuteOverride}/min`
                    : null}
                </Field>
                <Field label="Capture interval">
                  {source.captureIntervalDays ? `every ${source.captureIntervalDays} days` : null}
                </Field>
                <Field label="Next scheduled">
                  <Timestamp value={source.nextScheduledCaptureAt} />
                </Field>
              </FieldList>
            </Panel>

            <Panel title="Timeline">
              <FieldList>
                <Field label="First captured">
                  <Timestamp value={source.firstCapturedAt} />
                </Field>
                <Field label="Last captured">
                  <Timestamp value={source.lastCapturedAt} />
                </Field>
                <Field label="Last successful">
                  <Timestamp value={source.lastSuccessfulCaptureAt} />
                </Field>
                <Field label="Last changed">
                  <Timestamp value={source.lastChangedAt} />
                </Field>
                <Field label="Last response">
                  {source.lastResponseStatus ? String(source.lastResponseStatus) : null}
                </Field>
                <Field label="Last error">
                  {source.lastErrorCode ? (
                    <span className="text-[var(--color-tone-danger)]">{source.lastErrorCode}</span>
                  ) : null}
                </Field>
                <Field label="Created">
                  <Timestamp value={source.createdAt} />
                </Field>
              </FieldList>
            </Panel>

            {jobs.length > 0 ? (
              <Panel title="Crawl jobs">
                <table className="data-table">
                  <tbody>
                    {jobs.map((job) => {
                      const meta = JOB_STATUS_META[job.status as JobStatus];
                      return (
                        <tr key={job.id}>
                          <td className="truncate-cell">
                            <Link href={`/crawl-jobs/${job.id}`} className="hover:underline">
                              {job.name ?? job.reference}
                            </Link>
                            <InlineMeta
                              items={[
                                `${job.completedCount} done`,
                                job.failedCount > 0 ? `${job.failedCount} failed` : null,
                              ]}
                            />
                          </td>
                          <td className="w-20">
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </td>
                          <td className="w-20">
                            <Timestamp value={job.createdAt} relative />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
            ) : null}

            {/* Internal only. Never reaches the public API (§19). */}
            {source.internalNotes || source.notes ? (
              <Panel title="Notes" description="Internal. Not published.">
                <FieldList>
                  <Field label="Notes">
                    {source.notes ? (
                      <span className="whitespace-pre-wrap">{source.notes}</span>
                    ) : null}
                  </Field>
                  <Field label="Internal notes">
                    {source.internalNotes ? (
                      <span className="whitespace-pre-wrap">{source.internalNotes}</span>
                    ) : null}
                  </Field>
                </FieldList>
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
