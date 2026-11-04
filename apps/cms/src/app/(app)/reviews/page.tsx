import { listReviewQueue } from "@uxd/api";
import { and, eq, isNull, ne } from "drizzle-orm";
import { users } from "@uxd/database";
import { REVIEW_REASONS, REVIEW_REASON_META } from "@uxd/types";
import { EmptyState, LinkButton, PageHeader, Panel } from "@/components/ui/primitives";
import { FilterChips } from "@/components/filter-chips";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { ReviewQueue } from "./queue";

export const metadata = { title: "Reviews" };

/**
 * The review queue (§15).
 *
 * §15 says the content team's time is valuable and asks for keyboard-friendly
 * review. This screen is built around that: one item at a time, large, with
 * every decision on a single key, and the next item preloaded so a decision
 * costs one keystroke and no waiting.
 *
 * The queue is derived from `content_items.status = 'needs_review'` rather than
 * stored, so it cannot drift from the content it describes.
 */
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; mine?: string; unassigned?: string; sort?: string }>;
}) {
  const context = await getAdminContextWith("review.read");
  const params = await searchParams;

  const reasons = params.reason ? params.reason.split(",").filter(Boolean) : undefined;

  const { rows, total } = await listReviewQueue(
    context.db,
    {
      reasons,
      assignedTo: params.mine === "1" ? context.actor.id : undefined,
      unassignedOnly: params.unassigned === "1",
      lowConfidenceFirst: params.sort === "confidence",
    },
    { page: 1, pageSize: 50 },
  );

  // Resolve thumbnails for the whole batch at once, so the queue does not
  // stall on a presign per item as the reviewer moves through it.
  const urls = await resolveMediaUrls(rows.map((row) => row.thumbnailKey));

  const reviewers = await context.db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.status, "active"), isNull(users.deletedAt), ne(users.role, "viewer")))
    .limit(50);

  return (
    <>
      <PageHeader
        title="Reviews"
        description="Approve, reject, correct and publish. Built for the keyboard — press ? for the shortcuts."
        count={`${total.toLocaleString("en-US")} waiting`}
        actions={<LinkButton href="/content?status=approved">Approved, not published</LinkButton>}
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips
            basePath="/reviews"
            paramName="reason"
            active={reasons ?? []}
            searchParams={params}
            options={REVIEW_REASONS.map((reason) => ({
              value: reason,
              label: REVIEW_REASON_META[reason].label,
              title: REVIEW_REASON_META[reason].description,
            }))}
          />
          <div className="flex items-center gap-1.5 border-l border-ink-200 pl-3">
            <FilterChips
              basePath="/reviews"
              paramName="mine"
              active={params.mine === "1" ? ["1"] : []}
              searchParams={params}
              options={[{ value: "1", label: "Assigned to me" }]}
            />
            <FilterChips
              basePath="/reviews"
              paramName="unassigned"
              active={params.unassigned === "1" ? ["1"] : []}
              searchParams={params}
              options={[{ value: "1", label: "Unassigned" }]}
            />
            <FilterChips
              basePath="/reviews"
              paramName="sort"
              active={params.sort === "confidence" ? ["confidence"] : []}
              searchParams={params}
              options={[
                {
                  value: "confidence",
                  label: "Least certain first",
                  title:
                    "Sort by the lowest classification confidence — where a human judgement adds the most.",
                },
              ]}
            />
          </div>
        </div>

        {rows.length === 0 ? (
          <Panel>
            <EmptyState
              title={reasons || params.mine || params.unassigned ? "Nothing matches those filters" : "The review queue is clear"}
              description={
                reasons || params.mine || params.unassigned
                  ? "Clear the filters to see the whole queue."
                  : "Every captured record has been reviewed. Ingest more URLs to keep going."
              }
              action={<LinkButton href="/ingestion">Ingest URLs</LinkButton>}
            />
          </Panel>
        ) : (
          <ReviewQueue
            items={rows.map((row) => ({
              id: row.id,
              title: row.title,
              kind: row.kind,
              sourceUrl: row.sourceUrl,
              sourceName: row.sourceName,
              sourceId: row.sourceId,
              rightsStatus: row.rightsStatus,
              capturedAt: row.capturedAt?.toISOString() ?? null,
              createdAt: row.createdAt.toISOString(),
              version: row.version,
              reviewReason: row.reviewReason,
              assignedToName: row.assignedToName,
              pendingSuggestions: row.pendingSuggestions,
              classificationConfidence: row.classificationConfidence,
              thumbnailUrl: row.thumbnailKey ? (urls.get(row.thumbnailKey) ?? null) : null,
            }))}
            reviewers={reviewers}
            canPublish={context.actor.role === "admin" || context.actor.role === "reviewer"}
          />
        )}
      </div>
    </>
  );
}
