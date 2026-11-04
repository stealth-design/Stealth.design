import "server-only";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { type Db, contentItems, crawlJobs, discoveredPages, taxonomyAssignments } from "@uxd/database";
import { ATTENTION_STATUSES } from "@uxd/types";
import type { SidebarBadges } from "@/components/sidebar";

/**
 * The backlog counts shown in the sidebar.
 *
 * One query for the three content counts rather than three, because this runs
 * on every navigation and the sidebar is not worth three round trips.
 */
export async function loadSidebarBadges(db: Db): Promise<SidebarBadges> {
  const [content, jobs, suggestions, untriaged] = await Promise.all([
    db
      .select({
        needsReview: sql<number>`count(*) filter (where ${contentItems.status} = 'needs_review')::int`,
        needsAttention: sql<number>`count(*) filter (where ${contentItems.status}::text in ${[...ATTENTION_STATUSES]})::int`,
      })
      .from(contentItems)
      .where(isNull(contentItems.deletedAt)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(crawlJobs)
      .where(inArray(crawlJobs.status, ["queued", "running", "paused", "cancelling"])),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(taxonomyAssignments)
      .where(eq(taxonomyAssignments.reviewStatus, "pending")),
    // Candidates nobody has looked at. The partial index on `status = 'new'`
    // is what keeps this cheap once the queue holds tens of thousands of
    // settled rows.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(discoveredPages)
      .where(eq(discoveredPages.status, "new")),
  ]);

  return {
    needsReview: content[0]?.needsReview ?? 0,
    needsAttention: content[0]?.needsAttention ?? 0,
    activeJobs: jobs[0]?.n ?? 0,
    pendingSuggestions: suggestions[0]?.n ?? 0,
    untriagedPages: untriaged[0]?.n ?? 0,
  };
}
