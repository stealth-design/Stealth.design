import Link from "next/link";
import { notFound } from "next/navigation";
import { entityHistory, getContentDetail } from "@uxd/api";
import { formatDuration } from "@uxd/shared";
import {
  CLASSIFICATION_ORIGIN_META,
  CONTENT_KIND_META,
  LIFECYCLE_STATUS_META,
  PERMISSION_STATUS_LABELS,
  RIGHTS_STATUS_META,
  TAKEDOWN_STATUS_LABELS,
  TAXONOMY_KIND_META,
  type ClassificationOrigin,
  type ContentKind,
  type LifecycleStatus,
  type PermissionStatus,
  type RightsStatus,
  type TakedownStatus,
  type TaxonomyKind,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  Field,
  FieldList,
  InlineMeta,
  Note,
  PageHeader,
  Panel,
  SectionLabel,
  Thumbnail,
  Timestamp,
  formatBytes,
} from "@/components/ui/primitives";
import { ContentActions } from "./actions";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Content record" };

/**
 * Content detail (§29).
 *
 * Everything §29 lists, in the order it lists it: the primary media large
 * enough to judge, then metadata, classification, relationships, provenance,
 * and the internal notes and history.
 *
 * The classification panel is where §14's important distinction becomes
 * visible: every assigned term is badged with where it came from — AI
 * suggested, human verified, human modified, human added — and a suggestion
 * awaiting review is shown as an offer with accept and reject next to it,
 * never as a fact.
 */
export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContextWith("content.read");
  const { id } = await params;

  const detail = await getContentDetail(context.db, id);
  if (!detail) notFound();

  const content = detail.content;
  const statusMeta = LIFECYCLE_STATUS_META[content.status as LifecycleStatus];
  const kindMeta = CONTENT_KIND_META[content.kind as ContentKind];
  const rightsMeta = RIGHTS_STATUS_META[content.rightsStatus as RightsStatus];

  const audit = await entityHistory(context.db, "content", id, 30);

  const mediaUrls = await resolveMediaUrls([
    ...detail.media.map((entry) => entry.media.storageKey),
    ...detail.media.map((entry) => entry.thumbnailKey),
  ]);

  const primary =
    detail.media.find((entry) => entry.media.id === content.primaryMediaId) ?? detail.media[0];

  // Suggestions awaiting a human, separated from confirmed classifications.
  const pending = detail.taxonomy.filter((entry) => entry.assignment.reviewStatus === "pending");
  const confirmed = detail.taxonomy.filter((entry) => entry.assignment.reviewStatus !== "pending");

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Content", href: "/content" }]}
        title={content.title ?? "Untitled"}
        description={kindMeta.description}
        actions={
          <ContentActions
            contentId={id}
            status={content.status as LifecycleStatus}
            rightsStatus={content.rightsStatus as RightsStatus}
          />
        }
      />

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusMeta.tone} title={statusMeta.description} dot>
            {statusMeta.label}
          </Badge>
          <Badge tone="neutral">{kindMeta.label}</Badge>
          {content.version > 1 ? (
            <Badge tone="info" title={`Captured ${content.version} times.`}>
              v{content.version}
            </Badge>
          ) : null}
          <Badge tone={rightsMeta.tone} title={rightsMeta.description}>
            Rights: {rightsMeta.label}
          </Badge>
          {content.publishedAt ? (
            <span className="text-2xs text-ink-500">
              Published <Timestamp value={content.publishedAt} relative /> by{" "}
              {detail.publishedByName ?? "—"}
            </span>
          ) : null}
        </div>

        {rightsMeta.blocksPublishing ? (
          <Note tone="danger">
            <strong>This cannot be published while its rights status is “{rightsMeta.label}”.</strong>{" "}
            {rightsMeta.description}
            {content.rightsNotes ? <> Recorded reason: {content.rightsNotes}</> : null}
          </Note>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
          {/* --- Main: media and relationships -------------------- */}
          <div className="min-w-0 space-y-4">
            <Panel
              title="Primary media"
              description={
                primary
                  ? `${primary.media.deviceProfile ?? "unknown device"} · ${primary.media.screenshotScope ?? "capture"}`
                  : undefined
              }
              actions={
                primary ? (
                  <Link
                    href={`/media/${primary.media.id}`}
                    className="text-2xs text-ink-500 underline hover:text-ink-800"
                  >
                    Media record
                  </Link>
                ) : undefined
              }
            >
              {primary ? (
                <div className="flex max-h-[60vh] justify-center overflow-y-auto bg-ink-100 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mediaUrls.get(primary.media.storageKey) ?? ""}
                    alt={primary.media.altText ?? `Capture of ${content.title ?? "this record"}`}
                    className="max-w-full rounded-[3px] border border-ink-200 bg-surface object-contain"
                  />
                </div>
              ) : (
                <EmptyState
                  title="No media attached"
                  description="A page or screen needs a screenshot before it can be published."
                />
              )}
            </Panel>

            {detail.media.length > 1 ? (
              <Panel title={`All media (${detail.media.length})`}>
                <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4">
                  {detail.media.map((entry) => (
                    <Link
                      key={`${entry.media.id}-${entry.usage.role}`}
                      href={`/media/${entry.media.id}`}
                      className="group block"
                    >
                      <Thumbnail
                        url={
                          entry.thumbnailKey
                            ? (mediaUrls.get(entry.thumbnailKey) ?? null)
                            : (mediaUrls.get(entry.media.storageKey) ?? null)
                        }
                        alt={entry.media.altText ?? ""}
                        width={200}
                        height={130}
                        fallbackColor={entry.media.dominantColorHex}
                        className="w-full group-hover:border-ink-400"
                      />
                      <p className="mt-1 truncate text-2xs font-medium text-ink-700">
                        {entry.usage.role.replace(/_/g, " ")}
                      </p>
                      <p className="truncate text-2xs text-ink-500">
                        {entry.media.width}×{entry.media.height} · {formatBytes(entry.media.byteSize)}
                      </p>
                    </Link>
                  ))}
                </div>
              </Panel>
            ) : null}

            {/* --- Classification (§14) --------------------------- */}
            <Panel
              title="Classification"
              description="Where each term came from is shown next to it. A suggestion is an offer until someone confirms it."
              actions={
                <Link href="/taxonomy" className="text-2xs text-ink-500 underline hover:text-ink-800">
                  Manage taxonomy
                </Link>
              }
            >
              {pending.length > 0 ? (
                <div className="border-b border-ink-100 bg-[var(--color-tone-warning-bg)]/40 p-3">
                  <SectionLabel>
                    {pending.length} suggestion{pending.length === 1 ? "" : "s"} awaiting you
                  </SectionLabel>
                  <ul className="space-y-1.5 px-3">
                    {pending.map((entry) => (
                      <li
                        key={entry.assignment.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-ink-200 bg-surface px-2 py-1.5"
                      >
                        <span className="min-w-0">
                          <span className="text-2xs uppercase tracking-wide text-ink-500">
                            {TAXONOMY_KIND_META[entry.term.kind as TaxonomyKind].label}
                          </span>
                          <span className="ml-1.5 text-xs font-medium text-ink-800">
                            {entry.term.name}
                          </span>
                          {entry.assignment.confidence !== null ? (
                            <span className="ml-1.5 text-2xs text-ink-500">
                              {Math.round(entry.assignment.confidence * 100)}% confident
                            </span>
                          ) : null}
                          {entry.assignment.note ? (
                            <span className="mt-0.5 block text-2xs text-ink-500">
                              {entry.assignment.note}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-2xs text-ink-500">
                          {entry.assignment.model ?? "heuristic"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 px-3 text-2xs text-ink-500">
                    Confirm or reject these in the review queue, where the screenshot is shown at
                    full size alongside them.
                  </p>
                </div>
              ) : null}

              {confirmed.length === 0 && pending.length === 0 ? (
                <EmptyState
                  title="Not classified yet"
                  description="Classification suggestions appear here after a capture, and a person confirms them."
                />
              ) : confirmed.length > 0 ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-40">Vocabulary</th>
                      <th>Term</th>
                      <th className="w-36">Source</th>
                      <th className="w-32">Confirmed by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {confirmed.map((entry) => {
                      const originMeta =
                        CLASSIFICATION_ORIGIN_META[entry.assignment.origin as ClassificationOrigin];
                      return (
                        <tr key={entry.assignment.id}>
                          <td className="text-ink-600">
                            {TAXONOMY_KIND_META[entry.term.kind as TaxonomyKind].label}
                          </td>
                          <td>
                            <span className="font-medium">{entry.term.name}</span>
                            {entry.term.path.includes("/") ? (
                              <InlineMeta items={[entry.term.path]} />
                            ) : null}
                          </td>
                          <td>
                            <Badge tone={originMeta.tone} title={originMeta.description}>
                              {originMeta.shortLabel}
                            </Badge>
                          </td>
                          <td className="truncate-cell text-ink-600">
                            {entry.reviewerName ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}
            </Panel>

            {/* --- Capture history (§12) -------------------------- */}
            <Panel
              title={`Capture history (${detail.captureHistory.length})`}
              description="Every attempt to record this page, and what changed between them."
            >
              {detail.captureHistory.length === 0 ? (
                <EmptyState title="No captures recorded" />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-28">When</th>
                      <th className="w-24">Status</th>
                      <th className="w-14 text-right">HTTP</th>
                      <th>What changed</th>
                      <th className="w-28">Viewport</th>
                      <th className="w-20 text-right">Took</th>
                      <th className="w-28">Job</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.captureHistory.map(({ capture, jobReference }) => (
                      <tr key={capture.id}>
                        <td>
                          <Timestamp value={capture.createdAt} />
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
                        <td className="text-right tabular-nums text-ink-600">
                          {capture.httpStatus ?? "—"}
                        </td>
                        <td className="truncate-cell text-ink-600">
                          {capture.changed === null ? (
                            <span className="text-ink-400">first capture</span>
                          ) : (
                            String(
                              (capture.changeSummary as { description?: string })?.description ??
                                (capture.changed ? "Changed" : "No change"),
                            )
                          )}
                          {capture.errorMessage ? (
                            <span className="block text-2xs text-[var(--color-tone-danger)]">
                              {capture.errorMessage}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-2xs text-ink-600">
                          {capture.viewportWidth
                            ? `${capture.viewportWidth}×${capture.viewportHeight}`
                            : "—"}
                          {capture.fullPage ? <InlineMeta items={["full page"]} /> : null}
                        </td>
                        <td className="text-right text-ink-600">
                          {formatDuration(capture.durationMs)}
                        </td>
                        <td className="truncate-cell">
                          {capture.crawlJobId ? (
                            <Link href={`/crawl-jobs/${capture.crawlJobId}`} className="mono text-2xs hover:underline">
                              {jobReference ?? "job"}
                            </Link>
                          ) : (
                            <span className="text-ink-400">manual</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            {/* --- Relationships (§29) ---------------------------- */}
            {detail.children.length > 0 ||
            detail.related.length > 0 ||
            detail.flowMemberships.length > 0 ? (
              <Panel title="Relationships">
                <div className="divide-y divide-ink-100">
                  {detail.children.length > 0 ? (
                    <RelationList
                      label={`States and interactions (${detail.children.length})`}
                      items={detail.children.map((child) => ({
                        id: child.id,
                        label: child.title ?? "Untitled",
                        hint: child.kind,
                        href: `/content/${child.id}`,
                      }))}
                    />
                  ) : null}
                  {detail.flowMemberships.length > 0 ? (
                    <RelationList
                      label={`Appears in flows (${detail.flowMemberships.length})`}
                      items={detail.flowMemberships.map((flow) => ({
                        id: flow.id,
                        label: flow.title ?? "Untitled flow",
                        hint: `step ${flow.position}`,
                        href: `/content/${flow.id}`,
                      }))}
                    />
                  ) : null}
                  {detail.related.length > 0 ? (
                    <RelationList
                      label={`Related (${detail.related.length})`}
                      items={detail.related.map((related) => ({
                        id: related.id,
                        label: related.title ?? "Untitled",
                        hint: related.kind,
                        href: `/content/${related.id}`,
                      }))}
                    />
                  ) : null}
                  {detail.collections.length > 0 ? (
                    <RelationList
                      label={`Collections (${detail.collections.length})`}
                      items={detail.collections.map((collection) => ({
                        id: collection.id,
                        label: collection.name,
                        hint: collection.visibility,
                        href: `/collections/${collection.id}`,
                      }))}
                    />
                  ) : null}
                </div>
              </Panel>
            ) : null}
          </div>

          {/* --- Sidebar: metadata, provenance, internal ---------- */}
          <aside className="space-y-4">
            <Panel title="Metadata">
              <FieldList>
                <Field label="Source URL" mono>
                  {content.sourceUrl ? (
                    <a
                      href={content.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="break-all hover:underline"
                    >
                      {content.sourceUrl}
                    </a>
                  ) : null}
                </Field>
                <Field label="Source">
                  {detail.source ? (
                    <Link href={`/sources/${detail.source.id}`} className="hover:underline">
                      {detail.source.name}
                    </Link>
                  ) : null}
                </Field>
                <Field label="Slug" mono>
                  {content.slug}
                </Field>
                <Field label="Description">{content.description}</Field>
                <Field label="Platform">{content.platform}</Field>
                <Field label="Device">{content.deviceClass}</Field>
                {detail.page ? (
                  <>
                    <Field label="Page title">{detail.page.pageTitle}</Field>
                    <Field label="Main heading">{detail.page.h1}</Field>
                    <Field label="Words">{detail.page.wordCount?.toLocaleString("en-US")}</Field>
                    <Field label="Dimensions">
                      {detail.page.pageWidth
                        ? `${detail.page.pageWidth}×${detail.page.pageHeight}`
                        : null}
                    </Field>
                    <Field label="HTTP status">{detail.page.httpStatus}</Field>
                    {detail.page.canonicalUrl ? (
                      <Field
                        label="Canonical (as claimed)"
                        mono
                        hint="The page's own rel=canonical. Recorded, not obeyed."
                      >
                        {detail.page.canonicalUrl}
                      </Field>
                    ) : null}
                  </>
                ) : null}
                <Field label="Captured">
                  <Timestamp value={content.capturedAt} />
                </Field>
                <Field label="Created">
                  <Timestamp value={content.createdAt} />
                </Field>
                <Field label="Updated">
                  <Timestamp value={content.updatedAt} />
                </Field>
              </FieldList>
            </Panel>

            {/* --- Provenance (§29) ------------------------------- */}
            <Panel
              title="Provenance"
              description="Where this came from and how it was produced."
            >
              <FieldList>
                <Field label="Record id" mono>
                  {content.id}
                </Field>
                <Field label="Content hash" mono hint="Equal hashes mean the text did not change.">
                  {content.contentHash?.slice(0, 24)}
                </Field>
                <Field label="Layout hash" mono hint="Changes when the page structure changes.">
                  {content.layoutHash?.slice(0, 24)}
                </Field>
                <Field label="Version">{content.version}</Field>
                <Field label="Captures">{detail.captureHistory.length}</Field>
                <Field label="Created by">{detail.createdByName ?? "capture pipeline"}</Field>
                <Field label="Last edited by">{detail.updatedByName}</Field>
              </FieldList>
            </Panel>

            {/* --- Rights (§22) ---------------------------------- */}
            <Panel
              title="Rights"
              description="Operational labels recording what we know and have decided. Not legal determinations."
            >
              <FieldList>
                <Field label="Status" hint={rightsMeta.description}>
                  <Badge tone={rightsMeta.tone}>{rightsMeta.label}</Badge>
                </Field>
                <Field label="Owner">{content.rightsOwner}</Field>
                <Field label="Attribution">{content.attribution}</Field>
                <Field label="Permission">
                  {PERMISSION_STATUS_LABELS[content.permissionStatus as PermissionStatus]}
                </Field>
                <Field label="Takedown">
                  {TAKEDOWN_STATUS_LABELS[content.takedownStatus as TakedownStatus]}
                </Field>
                <Field label="Internal review">{content.legalReviewStatus.replace(/_/g, " ")}</Field>
                <Field label="Notes">{content.rightsNotes}</Field>
              </FieldList>
            </Panel>

            {/* --- Internal ------------------------------------- */}
            <Panel title="Internal notes" description="Never shown publicly.">
              <FieldList>
                <Field label="Notes">{content.notes}</Field>
                <Field label="Review notes">{content.reviewNotes}</Field>
                <Field label="Other notes">{content.internalNotes}</Field>
                {content.rejectionReason ? (
                  <Field label="Rejection reason">{content.rejectionReason}</Field>
                ) : null}
              </FieldList>
            </Panel>

            {/* --- Review history (§29) -------------------------- */}
            <Panel title="Review history">
              {detail.reviewHistory.length === 0 ? (
                <EmptyState title="Not reviewed yet" />
              ) : (
                <ul className="divide-y divide-ink-100">
                  {detail.reviewHistory.map(({ review, assigneeName, deciderName }) => (
                    <li key={review.id} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-ink-800">
                          {review.decision
                            ? `${deciderName ?? "Someone"} ${review.decision.replace(/_/g, " ")}`
                            : `Assigned to ${assigneeName ?? "nobody"}`}
                        </span>
                        <Timestamp value={review.decidedAt ?? review.createdAt} relative />
                      </div>
                      <InlineMeta
                        items={[
                          review.reason.replace(/_/g, " "),
                          review.durationMs ? `took ${formatDuration(review.durationMs)}` : null,
                        ]}
                      />
                      {review.notes ? (
                        <p className="mt-0.5 text-2xs text-ink-600">{review.notes}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/* --- Audit history (§29) --------------------------- */}
            <Panel title="Audit history" description="Append-only record of every change.">
              {audit.length === 0 ? (
                <EmptyState title="No changes recorded" />
              ) : (
                <ul className="divide-y divide-ink-100">
                  {audit.map((event) => (
                    <li key={event.id} className="px-3 py-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 text-2xs text-ink-700">{event.sentence}</span>
                        <Timestamp value={event.createdAt} relative />
                      </div>
                      {event.after && Object.keys(event.after).length > 0 ? (
                        <details className="mt-0.5">
                          <summary className="cursor-pointer text-2xs text-ink-400 hover:text-ink-600">
                            what changed
                          </summary>
                          <pre className="mono mt-1 overflow-x-auto rounded-[3px] bg-ink-50 p-1.5 text-2xs">
                            {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </aside>
        </div>
      </div>
    </>
  );
}

function RelationList({
  label,
  items,
}: {
  label: string;
  items: readonly { id: string; label: string; hint: string; href: string }[];
}) {
  return (
    <div className="p-3">
      <SectionLabel>{label}</SectionLabel>
      <ul className="space-y-0.5 px-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-2">
            <Link href={item.href} className="min-w-0 truncate text-xs hover:underline">
              {item.label}
            </Link>
            <span className="shrink-0 text-2xs capitalize text-ink-500">{item.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
