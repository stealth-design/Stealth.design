import Link from "next/link";
import { listScreens, listSources, screenStatusCounts } from "@uxd/api";
import {
  DEVICE_PROFILES,
  LIFECYCLE_STATUSES,
  LIFECYCLE_STATUS_META,
  SCREEN_ACQUISITION_LABELS,
  type DeviceProfileKey,
  type LifecycleStatus,
  type ScreenAcquisition,
} from "@uxd/types";
import { Badge, EmptyState, PageHeader, Panel, Timestamp } from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Screens" };

const PAGE_SIZE = 48;

/**
 * The Screen library (§2, §14).
 *
 * A grid rather than a table, because a Screen is a picture and its identity
 * is visual — a researcher scanning for "the one with the comparison table"
 * recognises it instantly and could not find it from a title. The title still
 * carries the state, since eight records called "Pricing" are unusable.
 *
 * Statuses are shown, not hidden. A library screen that only showed published
 * records would make the pipeline invisible to the people operating it.
 */
export default async function ScreensPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    source?: string;
    profile?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const context = await getAdminContextWith("content.read");
  const query = await searchParams;

  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const statuses = (query.status?.split(",").filter(Boolean) ?? []) as LifecycleStatus[];

  const filters = {
    q: query.q,
    statuses: statuses.length > 0 ? statuses : undefined,
    sourceId: query.source,
    deviceProfile: query.profile,
    sort: (query.sort as "newest" | "oldest" | "title" | undefined) ?? "newest",
  };

  const [{ rows, total }, counts, sources] = await Promise.all([
    listScreens(context.db, filters, { page, pageSize: PAGE_SIZE }),
    screenStatusCounts(context.db, { ...filters, statuses: undefined }),
    listSources(context.db, {}, { page: 1, pageSize: 200 }),
  ]);

  const mediaUrls = await resolveMediaUrls(rows.map((row) => row.thumbnailKey));

  return (
    <>
      <PageHeader
        title="Screens"
        count={`${total.toLocaleString()} total`}
        description="Deliberately captured visual states. The same URL can yield several — default, navigation open, modal open — and each is its own Screen."
        actions={
          <Link
            href="/discovered"
            className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
          >
            Capture a screen
          </Link>
        }
      />

      <div className="space-y-3 p-4">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Filter by name or URL"
            className="h-7 w-72 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <select
            name="source"
            defaultValue={query.source ?? ""}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Source"
          >
            <option value="">All sources</option>
            {sources.rows.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
          <select
            name="profile"
            defaultValue={query.profile ?? ""}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Device"
          >
            <option value="">Any device</option>
            <option value="desktop_1440">Desktop</option>
            <option value="mobile_390">Mobile</option>
          </select>
          {query.status ? <input type="hidden" name="status" value={query.status} /> : null}
          <button
            type="submit"
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2.5 text-xs hover:bg-ink-100"
          >
            Apply
          </button>
          {query.q || query.source || query.profile ? (
            <Link href="/screens" className="text-2xs text-ink-500 underline hover:text-ink-800">
              Reset
            </Link>
          ) : null}
        </form>

        <FilterChips
          basePath="/screens"
          paramName="status"
          active={statuses}
          searchParams={query}
          options={LIFECYCLE_STATUSES.filter((status) => (counts[status] ?? 0) > 0).map((status) => ({
            value: status,
            label: LIFECYCLE_STATUS_META[status].label,
            count: counts[status] ?? 0,
            title: LIFECYCLE_STATUS_META[status].description,
          }))}
        />

        {rows.length === 0 ? (
          <Panel>
            <EmptyState
              title="No screens yet"
              description="Screens are captured by hand from the discovery queue. Pick a candidate, drive the browser to the state worth keeping, then press Capture."
              action={
                <Link
                  href="/discovered"
                  className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
                >
                  Go to discovered pages
                </Link>
              }
            />
          </Panel>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {rows.map((row) => {
              const meta = LIFECYCLE_STATUS_META[row.status as LifecycleStatus];
              const profile = row.deviceProfile
                ? DEVICE_PROFILES[row.deviceProfile as DeviceProfileKey]
                : undefined;
              return (
                <li
                  key={row.id}
                  className="overflow-hidden rounded-md border border-ink-200 bg-surface"
                >
                  <Link href={`/screens/${row.id}`} className="block">
                    {/* The card image fills the column, so the width is set by
                        CSS rather than the primitive's fixed box. */}
                    <div className="aspect-[16/10] w-full overflow-hidden border-b border-ink-200 bg-ink-100">
                      {row.thumbnailKey && mediaUrls.get(row.thumbnailKey) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={mediaUrls.get(row.thumbnailKey)}
                          alt={row.title ?? "Screen"}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover object-top"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center text-2xs text-ink-400">
                          no image
                        </div>
                      )}
                    </div>
                    <div className="p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 text-xs font-medium text-ink-900">
                          {row.title ?? "Untitled"}
                        </span>
                        <Badge tone={meta.tone} title={meta.description}>
                          {meta.label}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-500">
                        {row.sourceName ? <span>{row.sourceName}</span> : null}
                        {profile ? <span>{profile.deviceClass}</span> : null}
                        {row.acquisition !== "interactive_capture" ? (
                          <span title="How this screen was obtained">
                            {SCREEN_ACQUISITION_LABELS[row.acquisition as ScreenAcquisition] ??
                              row.acquisition}
                          </span>
                        ) : null}
                        <Timestamp value={row.capturedAt} relative />
                      </div>
                      {row.pendingSuggestions > 0 ? (
                        <p className="mt-1.5 text-2xs text-[var(--color-tone-warning)]">
                          {row.pendingSuggestions} tag suggestion
                          {row.pendingSuggestions === 1 ? "" : "s"} awaiting review
                        </p>
                      ) : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <Pagination
          basePath="/screens"
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          searchParams={query}
        />
      </div>
    </>
  );
}
