/**
 * Dashboard queries (§1, §24).
 *
 * §1 lists eleven questions the dashboard must answer and asks for a control
 * center rather than a showcase. So this returns counts, backlogs and
 * operational tables — nothing decorative — and it answers all of them in a
 * fixed number of queries rather than one per card.
 *
 * The counts come from `count(*) filter (where ...)` in single grouped
 * statements. Eleven separate COUNT queries would make the CMS's home page the
 * slowest screen in the product, and it is the one everybody loads first.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  type Db,
  captures,
  contentItems,
  crawlJobItems,
  crawlJobs,
  mediaAssets,
  queueHealth,
  reviews,
  sources,
  taxonomyAssignments,
  users,
  workerInstances,
} from "@uxd/database";
import { type LifecycleStatus, ATTENTION_STATUSES, IN_FLIGHT_STATUSES } from "@uxd/types";

export interface DashboardSummary {
  /** "What content do we have?" */
  readonly content: {
    readonly total: number;
    readonly byStatus: Partial<Record<LifecycleStatus, number>>;
    readonly byKind: Record<string, number>;
    readonly published: number;
    readonly inFlight: number;
    readonly needsReview: number;
    readonly needsAttention: number;
  };
  /** "How much media have we collected?" */
  readonly media: {
    readonly total: number;
    readonly totalBytes: number;
    readonly images: number;
    readonly videos: number;
    readonly unused: number;
    readonly addedLast7Days: number;
  };
  /** "How many sources are active?" */
  readonly sources: {
    readonly total: number;
    readonly active: number;
    readonly needsAttention: number;
    readonly byHealth: Record<string, number>;
  };
  /** "What ingestion jobs are running?" */
  readonly jobs: {
    readonly active: number;
    readonly paused: number;
    readonly completedLast24h: number;
    readonly failedItemsTotal: number;
  };
  readonly queue: Awaited<ReturnType<typeof queueHealth>>;
  readonly workers: {
    readonly online: number;
    readonly stale: number;
    /** No workers plus queued work is the single most useful alert here: it is
     * exactly why a job appears stuck at Queued forever. */
    readonly noneRunningWithWork: boolean;
  };
  readonly classification: {
    readonly pendingSuggestions: number;
  };
  /** "What changed recently?" */
  readonly changes: {
    readonly changedLast7Days: number;
    readonly capturedLast24h: number;
    readonly captureSuccessRate7Days: number | null;
  };
}

export async function getDashboardSummary(db: Db): Promise<DashboardSummary> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const oneDayAgo = new Date(Date.now() - 86_400_000);

  const [
    contentCounts,
    contentByKind,
    mediaCounts,
    sourceCounts,
    sourceByHealth,
    jobCounts,
    queue,
    workerCounts,
    suggestionCount,
    captureStats,
  ] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        published: sql<number>`count(*) filter (where ${contentItems.status} = 'published')::int`,
        needsReview: sql<number>`count(*) filter (where ${contentItems.status} = 'needs_review')::int`,
        inFlight: sql<number>`count(*) filter (where ${contentItems.status}::text in ${[...IN_FLIGHT_STATUSES]})::int`,
        needsAttention: sql<number>`count(*) filter (where ${contentItems.status}::text in ${[...ATTENTION_STATUSES]})::int`,
        draft: sql<number>`count(*) filter (where ${contentItems.status} = 'draft')::int`,
        approved: sql<number>`count(*) filter (where ${contentItems.status} = 'approved')::int`,
        rejected: sql<number>`count(*) filter (where ${contentItems.status} = 'rejected')::int`,
        archived: sql<number>`count(*) filter (where ${contentItems.status} = 'archived')::int`,
        failed: sql<number>`count(*) filter (where ${contentItems.status} = 'failed')::int`,
        processed: sql<number>`count(*) filter (where ${contentItems.status} = 'processed')::int`,
        aiClassified: sql<number>`count(*) filter (where ${contentItems.status} = 'ai_classified')::int`,
        restricted: sql<number>`count(*) filter (where ${contentItems.status} = 'restricted')::int`,
      })
      .from(contentItems)
      .where(isNull(contentItems.deletedAt)),

    db
      .select({ kind: contentItems.kind, n: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(isNull(contentItems.deletedAt))
      .groupBy(contentItems.kind),

    db
      .select({
        total: sql<number>`count(*)::int`,
        totalBytes: sql<string>`coalesce(sum(${mediaAssets.byteSize}), 0)::bigint`,
        images: sql<number>`count(*) filter (where ${mediaAssets.kind} = 'image')::int`,
        videos: sql<number>`count(*) filter (where ${mediaAssets.kind} = 'video')::int`,
        unused: sql<number>`count(*) filter (where ${mediaAssets.usageCount} = 0)::int`,
        recent: sql<number>`count(*) filter (where ${mediaAssets.createdAt} >= ${sevenDaysAgo})::int`,
      })
      .from(mediaAssets)
      .where(and(isNull(mediaAssets.deletedAt), isNull(mediaAssets.archivedAt))),

    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${sources.status} not in ('archived','removed'))::int`,
        needsAttention: sql<number>`count(*) filter (where ${sources.health}::text in ('changed','needs_recapture','unavailable','blocked','redirected','requires_review'))::int`,
      })
      .from(sources)
      .where(isNull(sources.deletedAt)),

    db
      .select({ health: sources.health, n: sql<number>`count(*)::int` })
      .from(sources)
      .where(isNull(sources.deletedAt))
      .groupBy(sources.health),

    db
      .select({
        active: sql<number>`count(*) filter (where ${crawlJobs.status} in ('queued','running'))::int`,
        paused: sql<number>`count(*) filter (where ${crawlJobs.status} = 'paused')::int`,
        completedLast24h: sql<number>`count(*) filter (where ${crawlJobs.finishedAt} >= ${oneDayAgo})::int`,
      })
      .from(crawlJobs),

    queueHealth(db),

    db
      .select({
        online: sql<number>`count(*) filter (where ${workerInstances.lastHeartbeatAt} > now() - interval '2 minutes')::int`,
        stale: sql<number>`count(*) filter (where ${workerInstances.lastHeartbeatAt} <= now() - interval '2 minutes')::int`,
      })
      .from(workerInstances)
      .where(isNull(workerInstances.stoppedAt)),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(taxonomyAssignments)
      .where(eq(taxonomyAssignments.reviewStatus, "pending")),

    db
      .select({
        capturedLast24h: sql<number>`count(*) filter (where ${captures.createdAt} >= ${oneDayAgo})::int`,
        changedLast7Days: sql<number>`count(*) filter (where ${captures.changed} = true and ${captures.createdAt} >= ${sevenDaysAgo})::int`,
        succeeded7d: sql<number>`count(*) filter (where ${captures.status} = 'succeeded' and ${captures.createdAt} >= ${sevenDaysAgo})::int`,
        total7d: sql<number>`count(*) filter (where ${captures.createdAt} >= ${sevenDaysAgo})::int`,
      })
      .from(captures),
  ]);

  const content = contentCounts[0]!;
  const media = mediaCounts[0]!;
  const sourceRow = sourceCounts[0]!;
  const jobRow = jobCounts[0]!;
  const workerRow = workerCounts[0]!;
  const captureRow = captureStats[0]!;

  const [failedItems] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crawlJobItems)
    .where(inArray(crawlJobItems.status, ["failed", "dead_letter"]));

  return {
    content: {
      total: content.total,
      byStatus: {
        draft: content.draft,
        processed: content.processed,
        ai_classified: content.aiClassified,
        needs_review: content.needsReview,
        approved: content.approved,
        published: content.published,
        rejected: content.rejected,
        archived: content.archived,
        failed: content.failed,
        restricted: content.restricted,
      },
      byKind: Object.fromEntries(contentByKind.map((r) => [r.kind, r.n])),
      published: content.published,
      inFlight: content.inFlight,
      needsReview: content.needsReview,
      needsAttention: content.needsAttention,
    },
    media: {
      total: media.total,
      totalBytes: Number(media.totalBytes),
      images: media.images,
      videos: media.videos,
      unused: media.unused,
      addedLast7Days: media.recent,
    },
    sources: {
      total: sourceRow.total,
      active: sourceRow.active,
      needsAttention: sourceRow.needsAttention,
      byHealth: Object.fromEntries(sourceByHealth.map((r) => [r.health, r.n])),
    },
    jobs: {
      active: jobRow.active,
      paused: jobRow.paused,
      completedLast24h: jobRow.completedLast24h,
      failedItemsTotal: failedItems?.n ?? 0,
    },
    queue,
    workers: {
      online: workerRow.online,
      stale: workerRow.stale,
      noneRunningWithWork: workerRow.online === 0 && queue.pending > 0,
    },
    classification: { pendingSuggestions: suggestionCount[0]?.n ?? 0 },
    changes: {
      changedLast7Days: captureRow.changedLast7Days,
      capturedLast24h: captureRow.capturedLast24h,
      captureSuccessRate7Days:
        captureRow.total7d > 0
          ? Math.round((captureRow.succeeded7d / captureRow.total7d) * 100)
          : null,
    },
  };
}

/** Jobs currently running, for the dashboard's live table. */
export async function activeJobsTable(db: Db, limit = 10) {
  return db
    .select({
      id: crawlJobs.id,
      reference: crawlJobs.reference,
      name: crawlJobs.name,
      status: crawlJobs.status,
      queuedCount: crawlJobs.queuedCount,
      runningCount: crawlJobs.runningCount,
      completedCount: crawlJobs.completedCount,
      failedCount: crawlJobs.failedCount,
      startedAt: crawlJobs.startedAt,
      createdByName: sql<string | null>`(select name from ${users} where id = ${crawlJobs}.created_by)`,
      totalItems: sql<number>`(select count(*)::int from ${crawlJobItems} where job_id = ${crawlJobs}.id)`,
      itemsPerMinute: sql<number | null>`(
        select count(*)::int from ${crawlJobItems}
        where job_id = ${crawlJobs}.id and finished_at > now() - interval '1 minute'
      )`,
    })
    .from(crawlJobs)
    .where(inArray(crawlJobs.status, ["queued", "running", "paused", "cancelling"]))
    .orderBy(desc(crawlJobs.startedAt))
    .limit(limit);
}

/** Recently changed captures, for "what changed recently?" */
export async function recentChangesTable(db: Db, limit = 10) {
  return db
    .select({
      captureId: captures.id,
      contentItemId: captures.contentItemId,
      contentTitle: contentItems.title,
      contentKind: contentItems.kind,
      contentStatus: contentItems.status,
      changeSummary: captures.changeSummary,
      createdAt: captures.createdAt,
      sourceName: sources.name,
    })
    .from(captures)
    .leftJoin(contentItems, eq(contentItems.id, captures.contentItemId))
    .leftJoin(sources, eq(sources.id, captures.sourceId))
    .where(and(eq(captures.changed, true), isNotNull(captures.contentItemId)))
    .orderBy(desc(captures.createdAt))
    .limit(limit);
}

/** The review backlog, oldest first, for the dashboard's "needs review" table. */
export async function reviewBacklogTable(db: Db, limit = 10) {
  return db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      kind: contentItems.kind,
      createdAt: contentItems.createdAt,
      sourceName: sources.name,
      assignedToName: sql<string | null>`(
        select u.name from ${reviews} r join ${users} u on u.id = r.assigned_to
        where r.content_item_id = ${contentItems}.id and r.status in ('pending','in_progress') limit 1
      )`,
      waitingDays: sql<number>`extract(day from now() - ${contentItems.createdAt})::int`,
    })
    .from(contentItems)
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(eq(contentItems.status, "needs_review"), isNull(contentItems.deletedAt)))
    .orderBy(desc(sql`now() - ${contentItems.createdAt}`))
    .limit(limit);
}

/** Recently published, for the "what is published" table. */
export async function recentlyPublishedTable(db: Db, limit = 10) {
  return db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      slug: contentItems.slug,
      kind: contentItems.kind,
      publishedAt: contentItems.publishedAt,
      sourceName: sources.name,
      publishedByName: sql<string | null>`(select name from ${users} where id = ${contentItems}.published_by)`,
    })
    .from(contentItems)
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(eq(contentItems.status, "published"), isNull(contentItems.deletedAt)))
    .orderBy(desc(contentItems.publishedAt))
    .limit(limit);
}

/**
 * Capture throughput and error breakdown (§24).
 *
 * Grouped by day so the CMS can render a small table of recent days rather
 * than a chart — §1 explicitly asks to avoid decorative visualisation, and a
 * seven-row table of "date, captures, failures, average duration" is more
 * useful to an operator than a sparkline.
 */
export async function captureMetrics(db: Db, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000);

  const [byDay, byErrorCode] = await Promise.all([
    db
      .select({
        day: sql<string>`date_trunc('day', ${captures.createdAt})::date::text`,
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${captures.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${captures.status} = 'failed')::int`,
        changed: sql<number>`count(*) filter (where ${captures.changed} = true)::int`,
        avgDurationMs: sql<number | null>`avg(${captures.durationMs})::int`,
        p95DurationMs: sql<number | null>`percentile_disc(0.95) within group (order by ${captures.durationMs})::int`,
        bytes: sql<string>`coalesce(sum(${captures.bytesTransferred}), 0)::bigint`,
      })
      .from(captures)
      .where(gte(captures.createdAt, since))
      .groupBy(sql`date_trunc('day', ${captures.createdAt})`)
      .orderBy(desc(sql`date_trunc('day', ${captures.createdAt})`)),

    db
      .select({
        errorCode: crawlJobItems.errorCode,
        n: sql<number>`count(*)::int`,
      })
      .from(crawlJobItems)
      .where(
        and(
          isNotNull(crawlJobItems.errorCode),
          gte(crawlJobItems.finishedAt, since),
        ),
      )
      .groupBy(crawlJobItems.errorCode)
      .orderBy(desc(sql`count(*)`))
      .limit(15),
  ]);

  return {
    byDay: byDay.map((row) => ({ ...row, bytes: Number(row.bytes) })),
    byErrorCode,
  };
}

/** Media growth by day, for the storage panel. */
export async function mediaMetrics(db: Db, days = 14) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${mediaAssets.createdAt})::date::text`,
      count: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(${mediaAssets.byteSize}), 0)::bigint`,
    })
    .from(mediaAssets)
    .where(and(gte(mediaAssets.createdAt, since), isNull(mediaAssets.deletedAt)))
    .groupBy(sql`date_trunc('day', ${mediaAssets.createdAt})`)
    .orderBy(desc(sql`date_trunc('day', ${mediaAssets.createdAt})`));
  return rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
}

/** Reviewer throughput, so §15's "the content team's time is valuable" is
 * measurable rather than asserted. */
export async function reviewMetrics(db: Db, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  return db
    .select({
      reviewerId: reviews.decidedBy,
      reviewerName: sql<string | null>`(select name from ${users} where id = ${reviews}.decided_by)`,
      decisions: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where ${reviews.decision} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${reviews.decision} = 'rejected')::int`,
      medianDurationMs: sql<number | null>`percentile_disc(0.5) within group (order by ${reviews.durationMs})::int`,
    })
    .from(reviews)
    .where(and(isNotNull(reviews.decidedBy), gte(reviews.decidedAt, since)))
    .groupBy(reviews.decidedBy)
    .orderBy(desc(sql`count(*)`))
    .limit(20);
}
