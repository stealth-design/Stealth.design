/**
 * The Inbox: captured screens waiting for a decision.
 *
 * Two stages, read from the screen's own status so the Inbox can never
 * disagree with the record it shows:
 *
 *   review  just captured — nobody has looked yet
 *   draft   looked at and kept, but held back from the public site
 *
 * Published screens are not here; they live in the Library.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type Db,
  contentItems,
  mediaDerivatives,
  screenDetails,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
  users,
} from "@uxd/database";
import type { LifecycleStatus } from "@uxd/types";

export type InboxStage = "review" | "draft";

const STAGE_STATUSES: Record<InboxStage, readonly LifecycleStatus[]> = {
  review: ["processed", "ai_classified", "needs_review"],
  draft: ["approved"],
};

export const INBOX_STAGES: readonly InboxStage[] = ["review", "draft"];

const LIMIT = 300;

function stageWhere(stage: InboxStage, sourceId: string | null) {
  return and(
    eq(contentItems.kind, "screen"),
    isNull(contentItems.deletedAt),
    inArray(contentItems.status, [...STAGE_STATUSES[stage]]),
    sourceId ? eq(contentItems.sourceId, sourceId) : undefined,
  );
}

export interface InboxItem {
  readonly id: string;
  readonly title: string | null;
  readonly screenName: string | null;
  readonly stateLabel: string | null;
  readonly status: LifecycleStatus;
  readonly url: string | null;
  readonly deviceProfile: string | null;
  readonly capturedAt: Date | null;
  readonly sourceId: string | null;
  readonly sourceName: string | null;
  readonly sourceDomain: string | null;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly firstPublishedAt: Date | null;
  readonly thumbnailKey: string | null;
  readonly imageKey: string | null;
}

/** One stage of the Inbox, newest capture first. */
export async function listInbox(
  db: Db,
  filters: { stage: InboxStage; sourceId?: string | null },
): Promise<{ items: InboxItem[]; total: number }> {
  const where = stageWhere(filters.stage, filters.sourceId ?? null);
  const derivative = (kinds: string) => sql<string | null>`(
    select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
    where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
      and ${mediaDerivatives.kind}::text in (${sql.raw(kinds)})
    order by array_position(array[${sql.raw(kinds)}]::text[], ${mediaDerivatives.kind}::text)
    limit 1
  )`;

  const [items, [count]] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        screenName: screenDetails.screenName,
        stateLabel: screenDetails.stateLabel,
        status: contentItems.status,
        url: screenDetails.url,
        deviceProfile: screenDetails.deviceProfile,
        capturedAt: contentItems.capturedAt,
        sourceId: contentItems.sourceId,
        sourceName: sources.name,
        sourceDomain: sources.domain,
        createdBy: contentItems.createdBy,
        createdByName: users.name,
        firstPublishedAt: contentItems.firstPublishedAt,
        thumbnailKey: derivative("'thumbnail','preview'"),
        imageKey: derivative("'large','preview','thumbnail'"),
      })
      .from(contentItems)
      .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .leftJoin(users, eq(users.id, contentItems.createdBy))
      .where(where)
      .orderBy(desc(sql`coalesce(${contentItems.capturedAt}, ${contentItems.createdAt})`), desc(contentItems.id))
      .limit(LIMIT),
    db.select({ n: sql<number>`count(*)::int` }).from(contentItems).where(where),
  ]);

  return { items, total: count?.n ?? 0 };
}

/** How many screens are in each stage, for the tabs. */
export async function inboxCounts(db: Db, sourceId: string | null): Promise<Record<InboxStage, number>> {
  const [review, draft] = await Promise.all(
    INBOX_STAGES.map((stage) =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(contentItems)
        .where(stageWhere(stage, sourceId))
        .then((rows) => rows[0]?.n ?? 0),
    ),
  );
  return { review: review ?? 0, draft: draft ?? 0 };
}

/** Products with something in this stage, for the product filter. */
export async function inboxProducts(db: Db, stage: InboxStage) {
  return db
    .select({
      id: sources.id,
      name: sources.name,
      count: sql<number>`count(*)::int`,
    })
    .from(contentItems)
    .innerJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(stageWhere(stage, null))
    .groupBy(sources.id, sources.name)
    .orderBy(sources.name);
}

/**
 * Tags on these screens: the ones a person chose (accepted) and the ones the
 * classifier only suggested (pending), so review can confirm a suggestion in
 * one click.
 */
export async function inboxTags(db: Db, contentItemIds: readonly string[]) {
  if (contentItemIds.length === 0) return [];
  return db
    .select({
      assignmentId: taxonomyAssignments.id,
      contentItemId: taxonomyAssignments.contentItemId,
      termId: taxonomyTerms.id,
      name: taxonomyTerms.name,
      kind: taxonomyTerms.kind,
      reviewStatus: taxonomyAssignments.reviewStatus,
    })
    .from(taxonomyAssignments)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
    .where(
      and(
        inArray(taxonomyAssignments.contentItemId, [...contentItemIds]),
        inArray(taxonomyAssignments.reviewStatus, ["accepted", "pending"]),
        isNull(taxonomyTerms.archivedAt),
      ),
    )
    .orderBy(taxonomyTerms.kind, taxonomyTerms.name);
}

export interface InboxWebsite {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly review: number;
  readonly draft: number;
  readonly lastCapturedAt: Date | null;
  /** The newest few captures' thumbnails, newest first. */
  readonly thumbnailKeys: readonly string[];
}

/**
 * The Inbox's front page: one row per website with something waiting.
 *
 * Every capture is filed under exactly one product — its website's — so this
 * is the whole Inbox, grouped, with nothing counted twice.
 */
export async function inboxWebsites(db: Db): Promise<InboxWebsite[]> {
  const waiting = [...STAGE_STATUSES.review, ...STAGE_STATUSES.draft];
  const review = [...STAGE_STATUSES.review];

  const rows = await db.execute<{
    id: string;
    name: string;
    domain: string | null;
    review: number;
    draft: number;
    last_captured_at: string | null;
  }>(sql`
    select s.id, s.name, s.domain,
           count(*) filter (where ci.status::text in ${review})::int as review,
           count(*) filter (where ci.status = 'approved')::int as draft,
           max(coalesce(ci.captured_at, ci.created_at)) as last_captured_at
      from content_items ci
      join sources s on s.id = ci.source_id
     where ci.kind = 'screen'
       and ci.deleted_at is null
       and ci.status::text in ${waiting}
     group by s.id, s.name, s.domain
     order by max(coalesce(ci.captured_at, ci.created_at)) desc
  `);

  const ids = rows.rows.map((row) => row.id);
  const thumbs = ids.length
    ? await db.execute<{ source_id: string; storage_key: string }>(sql`
        select source_id, storage_key from (
          select ci.source_id, d.storage_key,
                 row_number() over (
                   partition by ci.source_id
                   order by coalesce(ci.captured_at, ci.created_at) desc, ci.id desc
                 ) as rn
            from content_items ci
            join media_derivatives d on d.media_id = ci.primary_media_id and d.kind = 'thumbnail'
           where ci.kind = 'screen'
             and ci.deleted_at is null
             and ci.status::text in ${waiting}
             and ci.source_id in ${ids}
        ) ranked
        where rn <= 4
      `)
    : { rows: [] };

  const bySource = new Map<string, string[]>();
  for (const row of thumbs.rows) bySource.set(row.source_id, [...(bySource.get(row.source_id) ?? []), row.storage_key]);

  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    review: row.review,
    draft: row.draft,
    lastCapturedAt: row.last_captured_at ? new Date(row.last_captured_at) : null,
    thumbnailKeys: bySource.get(row.id) ?? [],
  }));
}
