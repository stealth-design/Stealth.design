import Link from "next/link";
import { notFound } from "next/navigation";
import { entityHistory, getMediaDetail } from "@uxd/api";
import { NEAR_DUPLICATE_THRESHOLD, hammingDistance } from "@uxd/media";
import { formatDuration } from "@uxd/shared";
import {
  CAPTURE_METHOD_LABELS,
  MEDIA_STATUS_META,
  MEDIA_USAGE_ROLE_LABELS,
  type CaptureMethod,
  type MediaStatus,
  type MediaUsageRole,
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
  Thumbnail,
  Timestamp,
  formatBytes,
} from "@/components/ui/primitives";
import { MediaActions } from "./actions";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Media file" };

/**
 * Media detail (§30).
 *
 * Everything §30 asks for: a large preview, metadata, source, content usage,
 * dimensions, format, size, hash, capture information, related content and
 * history.
 *
 * The provenance block is the reason this page exists. §10 sets out two
 * questions this system must always be able to answer — "where did this
 * screenshot come from?" and "when did we capture it?" — and this is where
 * they are answered, down to the browser version and viewport.
 */
export default async function MediaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContextWith("media.read");
  const { id } = await params;

  const detail = await getMediaDetail(context.db, id);
  if (!detail) notFound();

  const media = detail.media;
  const statusMeta = MEDIA_STATUS_META[media.status as MediaStatus];
  const audit = await entityHistory(context.db, "media", id, 25);

  const urls = await resolveMediaUrls([
    media.storageKey,
    ...detail.derivatives.map((derivative) => derivative.storageKey),
    ...detail.similar.map((row) => row.storageKey),
  ]);

  // Exact Hamming distances, computed here over the SQL-narrowed candidate set.
  const nearDuplicates = media.perceptualHash
    ? detail.similar
        .map((row) => ({
          ...row,
          distance: row.perceptualHash ? hammingDistance(media.perceptualHash!, row.perceptualHash) : 64,
        }))
        .filter((row) => row.distance <= NEAR_DUPLICATE_THRESHOLD)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8)
    : [];

  const isServable = statusMeta.usable;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Media", href: "/media" }]}
        title={media.title ?? media.originalFilename ?? id.slice(0, 12)}
        description={`${media.mimeType} · ${formatBytes(media.byteSize)}${
          media.width ? ` · ${media.width}×${media.height}` : ""
        }`}
        actions={<MediaActions mediaId={id} status={media.status as MediaStatus} usageCount={media.usageCount} />}
      />

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusMeta.tone} title={statusMeta.description} dot>
            {statusMeta.label}
          </Badge>
          <Badge tone="neutral">{media.kind}</Badge>
          {media.usageCount === 0 ? (
            <Badge tone="warning" title="Not attached to any content record.">
              Unused
            </Badge>
          ) : (
            <Badge tone="success">
              Used {media.usageCount}×
            </Badge>
          )}
          {media.bytesDeletedAt ? (
            <Badge tone="danger" title="The file was removed from storage; this record remains.">
              Bytes deleted
            </Badge>
          ) : null}
        </div>

        {media.status === "quarantined" ? (
          <Note tone="danger">
            <strong>This upload was refused and is never served.</strong>{" "}
            {media.scanNotes ?? "It failed validation."} The record is retained so the attempt can
            be inspected.
          </Note>
        ) : null}

        {media.bytesDeletedAt ? (
          <Note tone="warning">
            The file itself was deleted{" "}
            <Timestamp value={media.bytesDeletedAt} relative />. This record is kept because
            provenance outlives the file: where it came from and when it was captured stay
            answerable.
          </Note>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-4">
            <Panel title="Preview">
              {isServable && media.kind === "image" ? (
                <div className="flex max-h-[65vh] justify-center overflow-auto bg-ink-100 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={urls.get(media.storageKey) ?? ""}
                    alt={media.altText ?? "Media preview"}
                    className="max-w-full rounded-[3px] border border-ink-200 bg-surface object-contain"
                  />
                </div>
              ) : isServable ? (
                <div className="p-6 text-center">
                  <p className="text-xs text-ink-600">
                    {media.mimeType} files are not previewed in the browser.
                  </p>
                  <a
                    href={`${urls.get(media.storageKey) ?? "#"}?download=1`}
                    className="mt-2 inline-block text-xs underline"
                  >
                    Download the file
                  </a>
                </div>
              ) : (
                <EmptyState
                  title="Not available"
                  description={statusMeta.description}
                />
              )}
            </Panel>

            {/* --- Content usage (§30) ---------------------------- */}
            <Panel
              title={`Used by (${detail.usages.length})`}
              description="Which records reference this file, and in what role."
            >
              {detail.usages.length === 0 ? (
                <EmptyState
                  title="Not used anywhere"
                  description="This file is not attached to any content record. It is a housekeeping candidate."
                />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Record</th>
                      <th className="w-20">Kind</th>
                      <th className="w-28">Status</th>
                      <th className="w-40">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.usages.map(({ usage, contentId, contentTitle, contentKind, contentStatus }) => (
                      <tr key={`${usage.mediaId}-${contentId}-${usage.role}`}>
                        <td className="truncate-cell">
                          <Link href={`/content/${contentId}`} className="hover:underline">
                            {contentTitle ?? "Untitled"}
                          </Link>
                        </td>
                        <td className="capitalize text-ink-600">{contentKind}</td>
                        <td className="text-ink-600">{contentStatus.replace(/_/g, " ")}</td>
                        <td className="text-ink-600">
                          {MEDIA_USAGE_ROLE_LABELS[usage.role as MediaUsageRole] ?? usage.role}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            {/* --- Near-duplicates (§11) ------------------------- */}
            {nearDuplicates.length > 0 ? (
              <Panel
                title={`Visually similar (${nearDuplicates.length})`}
                description="Found by perceptual hash. These are near-identical images, not byte-identical ones — an exact duplicate would have been merged into this record automatically."
              >
                <div className="grid grid-cols-3 gap-3 p-3 sm:grid-cols-4 lg:grid-cols-6">
                  {nearDuplicates.map((row) => (
                    <Link key={row.id} href={`/media/${row.id}`} className="group block min-w-0">
                      <Thumbnail
                        url={urls.get(row.storageKey) ?? null}
                        alt=""
                        width={160}
                        height={110}
                        className="w-full group-hover:border-ink-400"
                      />
                      <p className="mt-1 truncate text-2xs text-ink-700">
                        {row.originalFilename ?? row.id.slice(0, 8)}
                      </p>
                      <p className="text-2xs text-ink-500">
                        {row.distance === 0 ? "identical image" : `${row.distance} bits different`}
                      </p>
                    </Link>
                  ))}
                </div>
              </Panel>
            ) : null}

            {/* --- Derivatives ---------------------------------- */}
            {detail.derivatives.length > 0 ? (
              <Panel
                title={`Generated sizes (${detail.derivatives.length})`}
                description="Produced on upload. Regenerating them is a backfill, not a migration."
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-28">Size</th>
                      <th className="w-28">Dimensions</th>
                      <th className="w-24">Format</th>
                      <th className="w-24 text-right">Bytes</th>
                      <th>Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.derivatives.map((derivative) => (
                      <tr key={derivative.id}>
                        <td className="capitalize">{derivative.kind}</td>
                        <td className="tabular-nums text-ink-600">
                          {derivative.width}×{derivative.height}
                        </td>
                        <td className="mono text-2xs text-ink-600">{derivative.mimeType}</td>
                        <td className="text-right tabular-nums text-ink-600">
                          {formatBytes(derivative.byteSize)}
                        </td>
                        <td className="mono truncate-cell text-2xs text-ink-500">
                          {derivative.storageKey}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ) : null}
          </div>

          {/* --- Sidebar ------------------------------------------ */}
          <aside className="space-y-4">
            <Panel title="Editorial" description="Shown publicly where the record is published.">
              <FieldList>
                <Field label="Title">{media.title}</Field>
                <Field
                  label="Alt text"
                  hint="Describes the image for screen readers and for search."
                >
                  {media.altText}
                </Field>
                <Field label="Caption">{media.caption}</Field>
              </FieldList>
            </Panel>

            {/* --- Provenance (§10) --------------------------- */}
            <Panel
              title="Provenance"
              description="Where this file came from and exactly how it was produced."
            >
              <FieldList>
                <Field label="Source URL" mono>
                  {media.sourceUrl ? (
                    <a
                      href={media.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="break-all hover:underline"
                    >
                      {media.sourceUrl}
                    </a>
                  ) : null}
                </Field>
                <Field label="Origin domain" mono>
                  {media.originDomain}
                </Field>
                <Field label="Source">
                  {detail.source ? (
                    <Link href={`/sources/${detail.source.id}`} className="hover:underline">
                      {detail.source.name}
                    </Link>
                  ) : null}
                </Field>
                <Field label="Captured for">
                  {media.parentContentId ? (
                    <Link href={`/content/${media.parentContentId}`} className="hover:underline">
                      the content record
                    </Link>
                  ) : null}
                </Field>
                <Field label="Capture job">
                  {media.crawlJobId ? (
                    <Link href={`/crawl-jobs/${media.crawlJobId}`} className="hover:underline">
                      {detail.jobReference ?? "job"}
                    </Link>
                  ) : (
                    <span className="text-ink-400">manual upload</span>
                  )}
                </Field>
                <Field label="Capture method">
                  {CAPTURE_METHOD_LABELS[media.captureMethod as CaptureMethod]}
                </Field>
                <Field label="Captured at">
                  <Timestamp value={media.capturedAt} />
                </Field>
                <Field label="Viewport">
                  {media.viewportWidth ? `${media.viewportWidth}×${media.viewportHeight}` : null}
                </Field>
                <Field label="Device profile">{media.deviceProfile}</Field>
                <Field label="Scale factor">
                  {media.deviceScaleFactor ? `${media.deviceScaleFactor}×` : null}
                </Field>
                <Field label="Browser">
                  {media.browserName
                    ? `${media.browserName} ${media.browserVersion ?? ""}`.trim()
                    : null}
                </Field>
                <Field label="Screenshot scope">
                  {media.screenshotScope?.replace(/_/g, " ")}
                </Field>
                {detail.capture ? (
                  <Field label="From capture">
                    {formatDuration(detail.capture.durationMs)} ·{" "}
                    {detail.capture.status}
                  </Field>
                ) : null}
                <Field label="Uploaded by">{detail.uploaderName ?? "capture pipeline"}</Field>
              </FieldList>
            </Panel>

            {/* --- File identity ---------------------------- */}
            <Panel title="File">
              <FieldList>
                <Field label="Original filename" mono>
                  {media.originalFilename}
                </Field>
                <Field label="Content type" mono hint="Detected from the file's bytes.">
                  {media.mimeType}
                </Field>
                <Field label="Size">{formatBytes(media.byteSize)}</Field>
                <Field label="Dimensions">
                  {media.width ? `${media.width}×${media.height}` : null}
                </Field>
                <Field
                  label="sha256"
                  mono
                  hint="Exact-duplicate key. An identical file is reused rather than stored twice."
                >
                  {media.sha256}
                </Field>
                <Field
                  label="Perceptual hash"
                  mono
                  hint="Near-duplicate key. Survives re-encoding and small changes."
                >
                  {media.perceptualHash}
                </Field>
                <Field label="Storage driver">{media.storageDriver}</Field>
                <Field label="Storage key" mono>
                  {media.storageKey}
                </Field>
                <Field label="Colour profile">{media.colorProfile}</Field>
                <Field label="Transparency">
                  {media.hasAlpha === null ? null : media.hasAlpha ? "yes" : "no"}
                </Field>
                <Field label="Validation">
                  {media.scanStatus}
                  {media.scanNotes ? <InlineMeta items={[media.scanNotes]} /> : null}
                </Field>
                <Field label="Added">
                  <Timestamp value={media.createdAt} />
                </Field>
              </FieldList>
            </Panel>

            <Panel title="Internal notes">
              <FieldList>
                <Field label="Notes">{media.internalNotes}</Field>
              </FieldList>
            </Panel>

            <Panel title="History">
              {audit.length === 0 ? (
                <EmptyState title="No changes recorded" />
              ) : (
                <ul className="divide-y divide-ink-100">
                  {audit.map((event) => (
                    <li key={event.id} className="flex items-baseline justify-between gap-2 px-3 py-1.5">
                      <span className="min-w-0 text-2xs text-ink-700">{event.sentence}</span>
                      <Timestamp value={event.createdAt} relative />
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
