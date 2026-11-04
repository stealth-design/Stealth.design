import Link from "next/link";
import { listMedia } from "@uxd/api";
import {
  MEDIA_FORMATS,
  MEDIA_KINDS,
  MEDIA_STATUS_META,
  type MediaSortKey,
  type MediaStatus,
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
  formatBytes,
} from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { MediaUpload } from "./upload";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Media" };

/**
 * The media library (§9).
 *
 * §9 asks for grid and list views, search, filters, sort, bulk select, upload
 * and drag-and-drop, and calls this a core feature. The grid is the default
 * because the primary act here is *recognising* a screenshot, and the list is
 * one click away for when the act is comparing dimensions, sizes or dates.
 *
 * The "unused" filter is the one that earns its place operationally: a library
 * built by a crawler accumulates orphans, and this is how a team finds them.
 */
export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("media.read");
  const params = await searchParams;

  const view = params.view === "list" ? "list" : "grid";
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const kinds = params.kind?.split(",").filter(Boolean);
  const statuses = params.status?.split(",").filter(Boolean);

  const { rows, total, totalBytes } = await listMedia(
    context.db,
    {
      q: params.q,
      kinds,
      statuses,
      mimeTypes: params.mime ? [params.mime] : undefined,
      sourceId: params.source,
      crawlJobId: params.job,
      unusedOnly: params.unused === "1",
      includeArchived: params.archived === "1",
      sort: (params.sort as MediaSortKey | undefined) ?? "createdAt",
      direction: params.dir === "asc" ? "asc" : "desc",
    },
    { page, pageSize: view === "grid" ? 48 : 100 },
  );

  const urls = await resolveMediaUrls([
    ...rows.map((row) => row.thumbnailKey),
    ...rows.map((row) => row.storageKey),
  ]);

  const urlFor = (row: (typeof rows)[number]): string | null =>
    (row.thumbnailKey ? urls.get(row.thumbnailKey) : undefined) ?? urls.get(row.storageKey) ?? null;

  const viewHref = (target: "grid" | "list"): string => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "view" || key === "page" || value === undefined) continue;
      next.set(key, value);
    }
    if (target === "list") next.set("view", "list");
    const query = next.toString();
    return query.length > 0 ? `/media?${query}` : "/media";
  };

  return (
    <>
      <PageHeader
        title="Media"
        description="Every captured and uploaded file, with the provenance that says where it came from and when."
        count={`${total.toLocaleString("en-US")} files · ${formatBytes(totalBytes)}`}
        actions={<MediaUpload />}
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search filenames, alt text, URLs…"
              className="h-7 w-64 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
            <button
              type="submit"
              className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2.5 text-xs hover:bg-ink-100"
            >
              Search
            </button>
          </form>

          <div className="flex items-center gap-0.5 rounded-[4px] border border-ink-300 p-0.5">
            {(["grid", "list"] as const).map((target) => (
              <Link
                key={target}
                href={viewHref(target)}
                className={
                  view === target
                    ? "rounded-[3px] bg-ink-800 px-2 py-0.5 text-2xs font-medium capitalize text-ink-50"
                    : "rounded-[3px] px-2 py-0.5 text-2xs capitalize text-ink-600 hover:bg-ink-100"
                }
              >
                {target}
              </Link>
            ))}
          </div>

          <FilterChips
            basePath="/media"
            paramName="kind"
            active={kinds ?? []}
            searchParams={params}
            options={MEDIA_KINDS.map((kind) => ({ value: kind, label: kind }))}
          />
          <FilterChips
            basePath="/media"
            paramName="unused"
            active={params.unused === "1" ? ["1"] : []}
            searchParams={params}
            options={[
              {
                value: "1",
                label: "Unused",
                title: "Files not attached to any content record. Housekeeping candidates.",
              },
            ]}
          />
          <FilterChips
            basePath="/media"
            paramName="archived"
            active={params.archived === "1" ? ["1"] : []}
            searchParams={params}
            options={[{ value: "1", label: "Include archived" }]}
          />
        </div>

        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title={Object.keys(params).length > 0 ? "Nothing matches those filters" : "No media yet"}
              description={
                Object.keys(params).length > 0
                  ? "Clear the filters to see everything."
                  : "Capture a URL, or upload a file directly."
              }
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          ) : view === "grid" ? (
            <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {rows.map((row) => (
                <Link key={row.id} href={`/media/${row.id}`} className="group block min-w-0">
                  <Thumbnail
                    url={urlFor(row)}
                    alt={row.altText ?? row.originalFilename ?? ""}
                    width={240}
                    height={160}
                    fallbackColor={row.dominantColorHex}
                    className="w-full group-hover:border-ink-400"
                  />
                  <p className="mt-1 truncate text-2xs font-medium text-ink-800">
                    {row.title ?? row.originalFilename ?? row.id.slice(0, 8)}
                  </p>
                  <p className="truncate text-2xs text-ink-500">
                    {row.width && row.height ? `${row.width}×${row.height} · ` : ""}
                    {formatBytes(row.byteSize)}
                  </p>
                  <p className="truncate text-2xs text-ink-400">
                    {row.usageCount === 0 ? (
                      <span className="text-[var(--color-tone-warning)]">unused</span>
                    ) : (
                      `used ${row.usageCount}×`
                    )}
                    {row.originDomain ? ` · ${row.originDomain}` : ""}
                  </p>
                </Link>
              ))}
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-12" />
                  <th>File</th>
                  <th className="w-24">Type</th>
                  <th className="w-24">Status</th>
                  <th className="w-24 text-right">Size</th>
                  <th className="w-28 text-right">Dimensions</th>
                  <th className="w-16 text-right">Used</th>
                  <th className="w-32">Origin</th>
                  <th className="w-24">Captured</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const statusMeta = MEDIA_STATUS_META[row.status as MediaStatus];
                  return (
                    <tr key={row.id}>
                      <td>
                        <Thumbnail url={urlFor(row)} alt="" width={36} height={24} />
                      </td>
                      <td className="truncate-cell">
                        <Link href={`/media/${row.id}`} className="font-medium hover:underline">
                          {row.title ?? row.originalFilename ?? row.id.slice(0, 12)}
                        </Link>
                        <InlineMeta
                          items={[
                            row.deviceProfile,
                            row.screenshotScope?.replace(/_/g, " "),
                            row.altText ? "has alt text" : "no alt text",
                          ]}
                        />
                      </td>
                      <td className="mono text-2xs text-ink-600">{row.mimeType}</td>
                      <td>
                        <Badge tone={statusMeta.tone} title={statusMeta.description}>
                          {statusMeta.label}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {formatBytes(row.byteSize)}
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {row.width && row.height ? `${row.width}×${row.height}` : "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.usageCount === 0 ? (
                          <span className="text-[var(--color-tone-warning)]">0</span>
                        ) : (
                          row.usageCount
                        )}
                      </td>
                      <td className="truncate-cell">
                        <MonoValue value={row.originDomain} truncate />
                      </td>
                      <td>
                        <Timestamp value={row.capturedAt ?? row.createdAt} relative />
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
            basePath="/media"
            page={page}
            pageSize={view === "grid" ? 48 : 100}
            total={total}
            searchParams={params}
          />
          <p className="text-2xs text-ink-500">
            Accepted formats:{" "}
            {MEDIA_FORMATS.filter((format) => format.uploadable)
              .map((format) => format.label)
              .join(", ")}
            . Type is detected from file contents, never the extension.
          </p>
        </div>
      </div>
    </>
  );
}
