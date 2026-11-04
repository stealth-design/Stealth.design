import Link from "next/link";
import { discoveredStatusCounts, listDiscoveredPages, listSources } from "@uxd/api";
import {
  DISCOVERED_PAGE_STATUSES,
  DISCOVERED_PAGE_STATUS_META,
  type DiscoveredPageStatus,
  type StudioProfile,
} from "@uxd/types";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { AddCandidate } from "./add-candidate";
import { TriageList, type TriageRow } from "./triage";

export const metadata = { title: "Discovered pages" };

const PAGE_SIZE = 40;

/**
 * The discovery queue (§1, §12).
 *
 * The screen that makes the product's central claim operational: a crawl
 * produces candidates, and a person decides which of them become content.
 * Nothing on this page is content, nothing here is publishable, and the only
 * way out of it toward the library is the Capture button — which opens a live
 * browser rather than creating a record.
 *
 * Defaults to untriaged, because the queue is a backlog and a backlog screen
 * that opens showing settled rows is a screen that has to be filtered before
 * it can be used.
 */
export default async function DiscoveredPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    source?: string;
    job?: string;
    sort?: string;
    profile?: string;
    page?: string;
  }>;
}) {
  const context = await getAdminContextWith("content.read");
  const query = await searchParams;

  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const statuses = (query.status?.split(",").filter(Boolean) ?? ["new"]) as DiscoveredPageStatus[];
  const profile: StudioProfile = query.profile === "mobile_390" ? "mobile_390" : "desktop_1440";

  const filters = {
    q: query.q,
    statuses,
    sourceId: query.source,
    jobId: query.job,
    sort: (query.sort as "newest" | "oldest" | "path" | "mostSeen" | undefined) ?? "newest",
  };

  const [{ rows, total }, counts, sources] = await Promise.all([
    listDiscoveredPages(context.db, filters, { page, pageSize: PAGE_SIZE }),
    discoveredStatusCounts(context.db, { ...filters, statuses: undefined }),
    listSources(context.db, {}, { page: 1, pageSize: 200 }),
  ]);

  // One batch resolve for every thumbnail on the page. Resolving per row would
  // be a signed-URL round trip per candidate on an S3 deployment.
  const mediaUrls = await resolveMediaUrls(rows.map((r) => r.previewKey));

  const triageRows: TriageRow[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    url: row.url,
    path: row.path,
    title: row.title,
    description: row.description,
    httpStatus: row.httpStatus,
    wordCount: row.wordCount,
    depth: row.depth,
    seenCount: row.seenCount,
    screenCount: row.screenCount,
    ignoreReason: row.ignoreReason,
    lastSeenAt: row.lastSeenAt.toISOString(),
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    previewUrl: row.previewKey ? (mediaUrls.get(row.previewKey) ?? null) : null,
  }));

  return (
    <>
      <PageHeader
        title="Discovered pages"
        count={`${total.toLocaleString()} matching`}
        description="Candidates a crawl found. Nothing here is content yet — capture the ones worth studying, and set the rest aside."
        actions={<AddCandidate sources={sources.rows.map((row) => ({ id: row.id, name: row.name }))} />}
      />

      <div className="space-y-3 p-4">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Filter by path or title"
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
            name="sort"
            defaultValue={query.sort ?? "newest"}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Sort"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="path">By path</option>
            <option value="mostSeen">Seen most often</option>
          </select>
          {/*
            Which device the Capture button opens. It sits with the filters
            because it is a mode for the whole screen, not a per-row choice —
            a researcher doing a mobile pass wants every capture to be mobile,
            and Playwright fixes the device at context creation anyway, so
            switching mid-session is not a thing that exists.
          */}
          <select
            name="profile"
            defaultValue={profile}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Capture device"
          >
            <option value="desktop_1440">Capture on desktop — 1440×900</option>
            <option value="mobile_390">Capture on mobile — 390×844</option>
          </select>
          {query.status ? <input type="hidden" name="status" value={query.status} /> : null}
          <button
            type="submit"
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2.5 text-xs hover:bg-ink-100"
          >
            Apply
          </button>
          {query.q || query.source || query.sort ? (
            <Link href="/discovered" className="text-2xs text-ink-500 underline hover:text-ink-800">
              Reset
            </Link>
          ) : null}
        </form>

        <FilterChips
          basePath="/discovered"
          paramName="status"
          active={statuses}
          searchParams={query}
          options={DISCOVERED_PAGE_STATUSES.map((status) => ({
            value: status,
            label: DISCOVERED_PAGE_STATUS_META[status].label,
            count: counts[status] ?? 0,
            title: DISCOVERED_PAGE_STATUS_META[status].description,
          }))}
        />

        <Panel
          title={`${total.toLocaleString()} candidate${total === 1 ? "" : "s"}`}
          description={
            statuses.length === 1 && statuses[0] === "new"
              ? "Untriaged only. Add the other states from the chips above."
              : undefined
          }
        >
          {triageRows.length === 0 ? (
            <EmptyState
              title="Nothing to triage"
              description="Run a crawl from Ingestion to find candidate pages, or add a URL by hand."
              action={
                <Link
                  href="/ingestion"
                  className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
                >
                  Start a crawl
                </Link>
              }
            />
          ) : (
            <div className="p-3">
              <TriageList rows={triageRows} profile={profile} />
            </div>
          )}
        </Panel>

        <Pagination
          basePath="/discovered"
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          searchParams={query}
        />
      </div>
    </>
  );
}
