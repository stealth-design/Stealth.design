/**
 * CMS read queries (§2, §9, §28, §31).
 *
 * Shaped for an operator's screens rather than for the shape of the tables:
 * every list returns the columns its table renders plus the joined labels it
 * shows, in one query. §28 asks for dense, fast, predictable tables, and the
 * way to get that is to avoid the N+1 that "fetch rows, then fetch each row's
 * source name" produces on a 200-row page.
 *
 * Counters (`content_count`, `usage_count`, job counters) are read from their
 * denormalised columns rather than recomputed, which is why those columns
 * exist.
 */
import {
  type SQL,
  type SQLWrapper,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  type Db,
  captures,
  classificationSuggestions,
  collectionItems,
  collections,
  contentItems,
  crawlJobEvents,
  crawlJobItems,
  crawlJobUrls,
  crawlJobs,
  flowDetails,
  flowSteps,
  interactionDetails,
  mediaAssets,
  mediaDerivatives,
  mediaUsages,
  pageDetails,
  reviews,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
  urlRegistry,
  users,
  workerInstances,
} from "@uxd/database";
import {
  type ContentSortKey,
  type JobSortKey,
  type LifecycleStatus,
  type MediaSortKey,
  type SortDirection,
  type SourceSortKey,
  ATTENTION_STATUSES,
} from "@uxd/types";
import { type OffsetPagination, toOffset } from "@uxd/shared";

// --- Content --------------------------------------------------------------

export interface ContentFilters {
  readonly q?: string;
  readonly statuses?: readonly LifecycleStatus[];
  readonly kinds?: readonly string[];
  readonly modules?: readonly string[];
  readonly sourceId?: string;
  readonly experienceId?: string;
  readonly parentId?: string;
  readonly platform?: string;
  readonly deviceClass?: string;
  readonly rightsStatuses?: readonly string[];
  readonly termIds?: readonly string[];
  readonly crawlJobId?: string;
  readonly collectionId?: string;
  readonly assignedTo?: string;
  readonly capturedFrom?: Date;
  readonly capturedTo?: Date;
  readonly hasMedia?: boolean;
  readonly changedOnly?: boolean;
  readonly includeDeleted?: boolean;
  readonly sort?: ContentSortKey;
  readonly direction?: SortDirection;
}

/**
 * Build the WHERE conditions for a content query.
 *
 * Note the `::text in ${array}` idiom used throughout. Drizzle's `sql` template
 * expands an interpolated JS array into a parenthesised parameter list —
 * `($1, $2, $3)` — which is an IN list, not a Postgres array. So `in` is
 * correct and `= any(...)` is a runtime error ("op ANY/ALL (array) requires
 * array on right side"). The `::text` cast lets a plain string array filter an
 * enum column without the caller having to carry the enum type.
 *
 * Every caller checks `.length` first: an empty array would render as `in ()`,
 * which is a syntax error.
 */
function contentConditions(filters: ContentFilters): SQL[] {
  const conditions: SQL[] = [];
  if (!filters.includeDeleted) conditions.push(isNull(contentItems.deletedAt));
  if (filters.statuses?.length) conditions.push(inArray(contentItems.status, [...filters.statuses]));
  if (filters.kinds?.length) conditions.push(sql`${contentItems.kind}::text in ${filters.kinds}`);
  if (filters.modules?.length) conditions.push(sql`${contentItems.module}::text in ${filters.modules}`);
  if (filters.sourceId) conditions.push(eq(contentItems.sourceId, filters.sourceId));
  if (filters.experienceId) conditions.push(eq(contentItems.experienceId, filters.experienceId));
  if (filters.parentId) conditions.push(eq(contentItems.parentId, filters.parentId));
  if (filters.platform) conditions.push(sql`${contentItems.platform}::text = ${filters.platform}`);
  if (filters.deviceClass) conditions.push(sql`${contentItems.deviceClass}::text = ${filters.deviceClass}`);
  if (filters.rightsStatuses?.length) {
    conditions.push(sql`${contentItems.rightsStatus}::text in ${filters.rightsStatuses}`);
  }
  if (filters.capturedFrom) conditions.push(gte(contentItems.capturedAt, filters.capturedFrom));
  if (filters.capturedTo) conditions.push(lte(contentItems.capturedAt, filters.capturedTo));
  if (filters.hasMedia === true) conditions.push(isNotNull(contentItems.primaryMediaId));
  if (filters.hasMedia === false) conditions.push(isNull(contentItems.primaryMediaId));

  if (filters.q?.trim()) {
    const term = filters.q.trim().slice(0, 200);
    // Full-text for words, plus a prefix ILIKE so typing part of a URL or
    // title finds it before the whole word is typed — which is what an
    // operator scanning a table actually does.
    conditions.push(
      or(
        sql`${contentItems.searchVector} @@ websearch_to_tsquery('english', ${term})`,
        sql`${contentItems.title} ilike ${`%${term}%`}`,
        sql`${contentItems.sourceUrl} ilike ${`%${term}%`}`,
      )!,
    );
  }

  if (filters.termIds?.length) {
    for (const termId of filters.termIds.slice(0, 10)) {
      conditions.push(sql`exists (
        select 1 from ${taxonomyAssignments} ta
        where ta.content_item_id = ${contentItems.id} and ta.term_id = ${termId}
      )`);
    }
  }
  if (filters.crawlJobId) {
    conditions.push(sql`exists (
      select 1 from ${crawlJobItems} cji
      where cji.content_item_id = ${contentItems.id} and cji.job_id = ${filters.crawlJobId}
    )`);
  }
  if (filters.collectionId) {
    conditions.push(sql`exists (
      select 1 from ${collectionItems} ci
      where ci.content_item_id = ${contentItems.id} and ci.collection_id = ${filters.collectionId}
    )`);
  }
  if (filters.assignedTo) {
    conditions.push(sql`exists (
      select 1 from ${reviews} r
      where r.content_item_id = ${contentItems.id}
        and r.assigned_to = ${filters.assignedTo}
        and r.status in ('pending','in_progress')
    )`);
  }
  if (filters.changedOnly) {
    conditions.push(sql`exists (
      select 1 from ${captures} cap
      where cap.content_item_id = ${contentItems.id} and cap.changed = true
    )`);
  }
  return conditions;
}

/** Allowlisted sort columns. A sort key becomes part of an ORDER BY, so the
 * API accepts only keys that appear here. */
const CONTENT_SORT_COLUMNS: Record<ContentSortKey, SQLWrapper> = {
  updatedAt: contentItems.updatedAt,
  createdAt: contentItems.createdAt,
  capturedAt: contentItems.capturedAt,
  publishedAt: contentItems.publishedAt,
  title: contentItems.title,
  status: contentItems.status,
  kind: contentItems.kind,
  sourceName: sources.name,
};

export async function listContent(
  db: Db,
  filters: ContentFilters,
  pagination: OffsetPagination,
) {
  const conditions = contentConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const { limit, offset } = toOffset(pagination);

  const sortKey = filters.sort ?? "updatedAt";
  const column = CONTENT_SORT_COLUMNS[sortKey];
  const orderBy = filters.direction === "asc" ? asc(column) : desc(column);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        kind: contentItems.kind,
        module: contentItems.module,
        status: contentItems.status,
        title: contentItems.title,
        slug: contentItems.slug,
        sourceUrl: contentItems.sourceUrl,
        platform: contentItems.platform,
        deviceClass: contentItems.deviceClass,
        rightsStatus: contentItems.rightsStatus,
        version: contentItems.version,
        capturedAt: contentItems.capturedAt,
        publishedAt: contentItems.publishedAt,
        updatedAt: contentItems.updatedAt,
        createdAt: contentItems.createdAt,
        primaryMediaId: contentItems.primaryMediaId,
        classificationConfidence: contentItems.classificationConfidence,
        aiClassifiedAt: contentItems.aiClassifiedAt,
        sourceId: sources.id,
        sourceName: sources.name,
        sourceDomain: sources.domain,
        thumbnailKey: sql<string | null>`(
          select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
          where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
            and ${mediaDerivatives.kind} = 'thumbnail'
          limit 1
        )`,
        pendingSuggestions: sql<number>`(
          select count(*)::int from ${taxonomyAssignments} ta
          where ta.content_item_id = ${contentItems}.id and ta.review_status = 'pending'
        )`,
        assignedToName: sql<string | null>`(
          select u.name from ${reviews} r
          join ${users} u on u.id = r.assigned_to
          where r.content_item_id = ${contentItems}.id and r.status in ('pending','in_progress')
          limit 1
        )`,
      })
      .from(contentItems)
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where)
      .orderBy(orderBy, desc(contentItems.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItems)
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

/** Status counts for the filter chips, computed with one grouped query. */
export async function contentStatusCounts(db: Db, filters: ContentFilters = {}) {
  const base = contentConditions({ ...filters, statuses: undefined });
  const rows = await db
    .select({ status: contentItems.status, n: sql<number>`count(*)::int` })
    .from(contentItems)
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(base.length > 0 ? and(...base) : undefined)
    .groupBy(contentItems.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
    Record<LifecycleStatus, number>
  >;
}

/**
 * Everything the content detail page shows (§29).
 *
 * One function rather than a dozen loaders, because the page is a single
 * server-rendered view and issuing twelve sequential round trips would make it
 * feel slow for no reason.
 */
export async function getContentDetail(db: Db, contentId: string) {
  const [row] = await db
    .select({
      content: contentItems,
      source: sources,
      page: pageDetails,
      flow: flowDetails,
      interaction: interactionDetails,
      createdByName: sql<string | null>`(select name from ${users} where id = ${contentItems}.created_by)`,
      updatedByName: sql<string | null>`(select name from ${users} where id = ${contentItems}.updated_by)`,
      approvedByName: sql<string | null>`(select name from ${users} where id = ${contentItems}.approved_by)`,
      publishedByName: sql<string | null>`(select name from ${users} where id = ${contentItems}.published_by)`,
      reviewedByName: sql<string | null>`(select name from ${users} where id = ${contentItems}.reviewed_by)`,
    })
    .from(contentItems)
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .leftJoin(pageDetails, eq(pageDetails.contentItemId, contentItems.id))
    .leftJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
    .leftJoin(interactionDetails, eq(interactionDetails.contentItemId, contentItems.id))
    .where(eq(contentItems.id, contentId))
    .limit(1);

  if (!row) return null;

  const [media, taxonomy, suggestions, captureHistory, reviewHistory, relatedRows, childRows, flowMemberships, collectionRows] =
    await Promise.all([
      db
        .select({
          usage: mediaUsages,
          media: mediaAssets,
          thumbnailKey: sql<string | null>`(
            select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
            where ${mediaDerivatives.mediaId} = ${mediaAssets}.id and ${mediaDerivatives.kind} = 'thumbnail'
            limit 1
          )`,
        })
        .from(mediaUsages)
        .innerJoin(mediaAssets, eq(mediaAssets.id, mediaUsages.mediaId))
        .where(eq(mediaUsages.contentItemId, contentId))
        .orderBy(asc(mediaUsages.position)),

      db
        .select({
          assignment: taxonomyAssignments,
          term: taxonomyTerms,
          reviewerName: sql<string | null>`(select name from ${users} where id = ${taxonomyAssignments}.reviewed_by)`,
        })
        .from(taxonomyAssignments)
        .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
        .where(eq(taxonomyAssignments.contentItemId, contentId))
        .orderBy(asc(taxonomyTerms.kind), desc(taxonomyAssignments.confidence)),

      db
        .select()
        .from(classificationSuggestions)
        .where(
          and(
            eq(classificationSuggestions.contentItemId, contentId),
            eq(classificationSuggestions.reviewStatus, "pending"),
          ),
        ),

      db
        .select({
          capture: captures,
          jobReference: crawlJobs.reference,
        })
        .from(captures)
        .leftJoin(crawlJobs, eq(crawlJobs.id, captures.crawlJobId))
        .where(eq(captures.contentItemId, contentId))
        .orderBy(desc(captures.createdAt))
        .limit(50),

      db
        .select({
          review: reviews,
          assigneeName: sql<string | null>`(select name from ${users} where id = ${reviews}.assigned_to)`,
          deciderName: sql<string | null>`(select name from ${users} where id = ${reviews}.decided_by)`,
        })
        .from(reviews)
        .where(eq(reviews.contentItemId, contentId))
        .orderBy(desc(reviews.createdAt))
        .limit(25),

      db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          kind: contentItems.kind,
          status: contentItems.status,
          primaryMediaId: contentItems.primaryMediaId,
        })
        .from(contentItems)
        .where(
          and(
            or(
              sql`${contentItems.id} in (select to_id from content_relations where from_id = ${contentId})`,
              sql`${contentItems.id} in (select from_id from content_relations where to_id = ${contentId})`,
            ),
            isNull(contentItems.deletedAt),
          ),
        )
        .limit(24),

      db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          kind: contentItems.kind,
          status: contentItems.status,
          primaryMediaId: contentItems.primaryMediaId,
        })
        .from(contentItems)
        .where(and(eq(contentItems.parentId, contentId), isNull(contentItems.deletedAt)))
        .orderBy(asc(contentItems.kind), asc(contentItems.title))
        .limit(100),

      db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          status: contentItems.status,
          position: flowSteps.position,
        })
        .from(flowSteps)
        .innerJoin(contentItems, eq(contentItems.id, flowSteps.flowId))
        .where(eq(flowSteps.contentItemId, contentId))
        .limit(25),

      db
        .select({ id: collections.id, name: collections.name, visibility: collections.visibility })
        .from(collectionItems)
        .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
        .where(eq(collectionItems.contentItemId, contentId))
        .limit(50),
    ]);

  return {
    ...row,
    media,
    taxonomy,
    suggestions,
    captureHistory,
    reviewHistory,
    related: relatedRows,
    children: childRows,
    flowMemberships,
    collections: collectionRows,
  };
}

// --- Media ----------------------------------------------------------------

export interface MediaFilters {
  readonly q?: string;
  readonly kinds?: readonly string[];
  readonly statuses?: readonly string[];
  readonly mimeTypes?: readonly string[];
  readonly sourceId?: string;
  readonly crawlJobId?: string;
  readonly contentItemId?: string;
  readonly unusedOnly?: boolean;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly minBytes?: number;
  readonly deviceClass?: string;
  readonly includeDeleted?: boolean;
  readonly includeArchived?: boolean;
  readonly sort?: MediaSortKey;
  readonly direction?: SortDirection;
}

const MEDIA_SORT_COLUMNS: Record<MediaSortKey, SQLWrapper> = {
  createdAt: mediaAssets.createdAt,
  capturedAt: mediaAssets.capturedAt,
  byteSize: mediaAssets.byteSize,
  width: mediaAssets.width,
  originalFilename: mediaAssets.originalFilename,
  mimeType: mediaAssets.mimeType,
};

export async function listMedia(db: Db, filters: MediaFilters, pagination: OffsetPagination) {
  const conditions: SQL[] = [];
  if (!filters.includeDeleted) conditions.push(isNull(mediaAssets.deletedAt));
  if (!filters.includeArchived) conditions.push(isNull(mediaAssets.archivedAt));
  if (filters.kinds?.length) conditions.push(sql`${mediaAssets.kind}::text in ${filters.kinds}`);
  if (filters.statuses?.length) conditions.push(sql`${mediaAssets.status}::text in ${filters.statuses}`);
  if (filters.mimeTypes?.length) conditions.push(inArray(mediaAssets.mimeType, [...filters.mimeTypes]));
  if (filters.sourceId) conditions.push(eq(mediaAssets.sourceId, filters.sourceId));
  if (filters.crawlJobId) conditions.push(eq(mediaAssets.crawlJobId, filters.crawlJobId));
  if (filters.deviceClass) conditions.push(sql`${mediaAssets.deviceClass}::text = ${filters.deviceClass}`);
  if (filters.unusedOnly) conditions.push(eq(mediaAssets.usageCount, 0));
  if (filters.createdFrom) conditions.push(gte(mediaAssets.createdAt, filters.createdFrom));
  if (filters.createdTo) conditions.push(lte(mediaAssets.createdAt, filters.createdTo));
  if (filters.minBytes) conditions.push(gte(mediaAssets.byteSize, filters.minBytes));
  if (filters.contentItemId) {
    conditions.push(sql`exists (
      select 1 from ${mediaUsages} mu
      where mu.media_id = ${mediaAssets.id} and mu.content_item_id = ${filters.contentItemId}
    )`);
  }
  if (filters.q?.trim()) {
    const term = filters.q.trim().slice(0, 200);
    conditions.push(
      or(
        sql`${mediaAssets.searchVector} @@ websearch_to_tsquery('english', ${term})`,
        sql`${mediaAssets.originalFilename} ilike ${`%${term}%`}`,
        sql`${mediaAssets.sourceUrl} ilike ${`%${term}%`}`,
      )!,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const { limit, offset } = toOffset(pagination);
  const column = MEDIA_SORT_COLUMNS[filters.sort ?? "createdAt"];
  const orderBy = filters.direction === "asc" ? asc(column) : desc(column);

  const [rows, countRows, sizeRows] = await Promise.all([
    db
      .select({
        id: mediaAssets.id,
        kind: mediaAssets.kind,
        status: mediaAssets.status,
        mimeType: mediaAssets.mimeType,
        originalFilename: mediaAssets.originalFilename,
        title: mediaAssets.title,
        altText: mediaAssets.altText,
        byteSize: mediaAssets.byteSize,
        width: mediaAssets.width,
        height: mediaAssets.height,
        usageCount: mediaAssets.usageCount,
        storageKey: mediaAssets.storageKey,
        dominantColorHex: mediaAssets.dominantColorHex,
        sourceUrl: mediaAssets.sourceUrl,
        originDomain: mediaAssets.originDomain,
        deviceClass: mediaAssets.deviceClass,
        deviceProfile: mediaAssets.deviceProfile,
        screenshotScope: mediaAssets.screenshotScope,
        capturedAt: mediaAssets.capturedAt,
        createdAt: mediaAssets.createdAt,
        sourceName: sources.name,
        thumbnailKey: sql<string | null>`(
          select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
          where ${mediaDerivatives.mediaId} = ${mediaAssets}.id and ${mediaDerivatives.kind} = 'thumbnail'
          limit 1
        )`,
      })
      .from(mediaAssets)
      .leftJoin(sources, eq(sources.id, mediaAssets.sourceId))
      .where(where)
      .orderBy(orderBy, desc(mediaAssets.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(mediaAssets).where(where),
    db
      .select({ bytes: sql<number>`coalesce(sum(${mediaAssets.byteSize}), 0)::bigint` })
      .from(mediaAssets)
      .where(where),
  ]);

  return {
    rows,
    total: countRows[0]?.n ?? 0,
    totalBytes: Number(sizeRows[0]?.bytes ?? 0),
  };
}

/** Everything the media detail page shows (§30). */
export async function getMediaDetail(db: Db, mediaId: string) {
  const [row] = await db
    .select({
      media: mediaAssets,
      source: sources,
      uploaderName: sql<string | null>`(select name from ${users} where id = ${mediaAssets}.uploaded_by)`,
      jobReference: crawlJobs.reference,
    })
    .from(mediaAssets)
    .leftJoin(sources, eq(sources.id, mediaAssets.sourceId))
    .leftJoin(crawlJobs, eq(crawlJobs.id, mediaAssets.crawlJobId))
    .where(eq(mediaAssets.id, mediaId))
    .limit(1);
  if (!row) return null;

  const [derivatives, usages, capture, similar] = await Promise.all([
    db.select().from(mediaDerivatives).where(eq(mediaDerivatives.mediaId, mediaId)),
    db
      .select({
        usage: mediaUsages,
        contentId: contentItems.id,
        contentTitle: contentItems.title,
        contentKind: contentItems.kind,
        contentStatus: contentItems.status,
      })
      .from(mediaUsages)
      .innerJoin(contentItems, eq(contentItems.id, mediaUsages.contentItemId))
      .where(eq(mediaUsages.mediaId, mediaId)),
    row.media.captureId
      ? db.select().from(captures).where(eq(captures.id, row.media.captureId)).limit(1)
      : Promise.resolve([]),
    // Visually similar assets, by shared perceptual-hash prefix. Narrowed in
    // SQL, exact distance computed by the caller.
    row.media.perceptualHash
      ? db
          .select({
            id: mediaAssets.id,
            perceptualHash: mediaAssets.perceptualHash,
            originalFilename: mediaAssets.originalFilename,
            createdAt: mediaAssets.createdAt,
            storageKey: mediaAssets.storageKey,
          })
          .from(mediaAssets)
          .where(
            and(
              ne(mediaAssets.id, mediaId),
              isNull(mediaAssets.deletedAt),
              sql`${mediaAssets.perceptualHash} like ${`${row.media.perceptualHash.slice(0, 4)}%`}`,
            ),
          )
          .limit(50)
      : Promise.resolve([]),
  ]);

  return { ...row, derivatives, usages, capture: capture[0] ?? null, similar };
}

// --- Sources --------------------------------------------------------------

export interface SourceFilters {
  readonly q?: string;
  readonly statuses?: readonly string[];
  readonly healths?: readonly string[];
  readonly types?: readonly string[];
  readonly modules?: readonly string[];
  readonly rightsStatuses?: readonly string[];
  readonly needsAttention?: boolean;
  readonly sort?: SourceSortKey;
  readonly direction?: SortDirection;
}

const SOURCE_SORT_COLUMNS: Record<SourceSortKey, SQLWrapper> = {
  name: sources.name,
  lastCapturedAt: sources.lastCapturedAt,
  firstCapturedAt: sources.firstCapturedAt,
  health: sources.health,
  contentCount: sources.contentCount,
  createdAt: sources.createdAt,
};

export async function listSources(db: Db, filters: SourceFilters, pagination: OffsetPagination) {
  const conditions: SQL[] = [isNull(sources.deletedAt)];
  if (filters.statuses?.length) conditions.push(sql`${sources.status}::text in ${filters.statuses}`);
  if (filters.healths?.length) conditions.push(sql`${sources.health}::text in ${filters.healths}`);
  if (filters.types?.length) conditions.push(sql`${sources.type}::text in ${filters.types}`);
  if (filters.modules?.length) conditions.push(sql`${sources.module}::text in ${filters.modules}`);
  if (filters.rightsStatuses?.length) {
    conditions.push(sql`${sources.rightsStatus}::text in ${filters.rightsStatuses}`);
  }
  if (filters.needsAttention) {
    conditions.push(
      sql`${sources.health}::text in ('changed','needs_recapture','unavailable','blocked','redirected','requires_review')`,
    );
  }
  if (filters.q?.trim()) {
    const term = filters.q.trim().slice(0, 200);
    conditions.push(
      or(
        sql`${sources.searchVector} @@ websearch_to_tsquery('english', ${term})`,
        sql`${sources.name} ilike ${`%${term}%`}`,
        sql`${sources.domain} ilike ${`%${term}%`}`,
      )!,
    );
  }

  const where = and(...conditions);
  const { limit, offset } = toOffset(pagination);
  const column = SOURCE_SORT_COLUMNS[filters.sort ?? "name"];
  const orderBy = filters.direction === "desc" ? desc(column) : asc(column);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: sources.id,
        name: sources.name,
        slug: sources.slug,
        domain: sources.domain,
        type: sources.type,
        module: sources.module,
        status: sources.status,
        health: sources.health,
        companyName: sources.companyName,
        rightsStatus: sources.rightsStatus,
        robotsStatus: sources.robotsStatus,
        contentCount: sources.contentCount,
        mediaCount: sources.mediaCount,
        captureCount: sources.captureCount,
        consecutiveFailures: sources.consecutiveFailures,
        lastCapturedAt: sources.lastCapturedAt,
        lastSuccessfulCaptureAt: sources.lastSuccessfulCaptureAt,
        lastChangedAt: sources.lastChangedAt,
        lastResponseStatus: sources.lastResponseStatus,
        lastLoadTimeMs: sources.lastLoadTimeMs,
        nextScheduledCaptureAt: sources.nextScheduledCaptureAt,
        captureIntervalDays: sources.captureIntervalDays,
        publishedCount: sql<number>`(
          select count(*)::int from ${contentItems} ci
          where ci.source_id = ${sources}.id and ci.status = 'published' and ci.deleted_at is null
        )`,
      })
      .from(sources)
      .where(where)
      .orderBy(orderBy, asc(sources.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(sources).where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

/** A source's overview: "show me everything from this product" (§3). */
export async function getSourceDetail(db: Db, sourceId: string) {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) return null;

  const [byKind, byStatus, recentCaptures, jobs, mediaSample] = await Promise.all([
    db
      .select({ kind: contentItems.kind, n: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(and(eq(contentItems.sourceId, sourceId), isNull(contentItems.deletedAt)))
      .groupBy(contentItems.kind),
    db
      .select({ status: contentItems.status, n: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(and(eq(contentItems.sourceId, sourceId), isNull(contentItems.deletedAt)))
      .groupBy(contentItems.status),
    db
      .select({
        capture: captures,
        contentTitle: contentItems.title,
        contentId: contentItems.id,
      })
      .from(captures)
      .leftJoin(contentItems, eq(contentItems.id, captures.contentItemId))
      .where(eq(captures.sourceId, sourceId))
      .orderBy(desc(captures.createdAt))
      .limit(25),
    db
      .select({
        id: crawlJobs.id,
        reference: crawlJobs.reference,
        name: crawlJobs.name,
        status: crawlJobs.status,
        completedCount: crawlJobs.completedCount,
        failedCount: crawlJobs.failedCount,
        createdAt: crawlJobs.createdAt,
      })
      .from(crawlJobs)
      .where(eq(crawlJobs.sourceId, sourceId))
      .orderBy(desc(crawlJobs.createdAt))
      .limit(10),
    db
      .select({
        id: mediaAssets.id,
        storageKey: mediaAssets.storageKey,
        thumbnailKey: sql<string | null>`(
          select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
          where ${mediaDerivatives.mediaId} = ${mediaAssets}.id and ${mediaDerivatives.kind} = 'thumbnail'
          limit 1
        )`,
      })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.sourceId, sourceId), isNull(mediaAssets.deletedAt)))
      .orderBy(desc(mediaAssets.createdAt))
      .limit(12),
  ]);

  return {
    source,
    contentByKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
    contentByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    recentCaptures,
    jobs,
    mediaSample,
  };
}

// --- Crawl jobs -----------------------------------------------------------

export interface JobFilters {
  readonly q?: string;
  readonly statuses?: readonly string[];
  readonly createdBy?: string;
  readonly sourceId?: string;
  readonly sort?: JobSortKey;
  readonly direction?: SortDirection;
}

export async function listJobs(db: Db, filters: JobFilters, pagination: OffsetPagination) {
  const conditions: SQL[] = [];
  if (filters.statuses?.length) conditions.push(sql`${crawlJobs.status}::text in ${filters.statuses}`);
  if (filters.createdBy) conditions.push(eq(crawlJobs.createdBy, filters.createdBy));
  if (filters.sourceId) conditions.push(eq(crawlJobs.sourceId, filters.sourceId));
  if (filters.q?.trim()) {
    const term = `%${filters.q.trim().slice(0, 100)}%`;
    conditions.push(or(sql`${crawlJobs.name} ilike ${term}`, sql`${crawlJobs.reference} ilike ${term}`)!);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const { limit, offset } = toOffset(pagination);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: crawlJobs.id,
        reference: crawlJobs.reference,
        name: crawlJobs.name,
        status: crawlJobs.status,
        priority: crawlJobs.priority,
        module: crawlJobs.module,
        submittedCount: crawlJobs.submittedCount,
        queuedCount: crawlJobs.queuedCount,
        runningCount: crawlJobs.runningCount,
        completedCount: crawlJobs.completedCount,
        failedCount: crawlJobs.failedCount,
        skippedCount: crawlJobs.skippedCount,
        blockedCount: crawlJobs.blockedCount,
        retriedCount: crawlJobs.retriedCount,
        discoveredCount: crawlJobs.discoveredCount,
        acceptedCount: crawlJobs.acceptedCount,
        screenshotCount: crawlJobs.screenshotCount,
        mediaCount: crawlJobs.mediaCount,
        duplicateCount: crawlJobs.duplicateCount,
        contentCreatedCount: crawlJobs.contentCreatedCount,
        startedAt: crawlJobs.startedAt,
        finishedAt: crawlJobs.finishedAt,
        durationMs: crawlJobs.durationMs,
        createdAt: crawlJobs.createdAt,
        createdByName: sql<string | null>`(select name from ${users} where id = ${crawlJobs}.created_by)`,
        totalItems: sql<number>`(select count(*)::int from ${crawlJobItems} where job_id = ${crawlJobs}.id)`,
      })
      .from(crawlJobs)
      .where(where)
      .orderBy(desc(crawlJobs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(crawlJobs).where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

export async function getJobDetail(db: Db, jobId: string) {
  const [job] = await db
    .select({
      job: crawlJobs,
      createdByName: sql<string | null>`(select name from ${users} where id = ${crawlJobs}.created_by)`,
      sourceName: sources.name,
    })
    .from(crawlJobs)
    .leftJoin(sources, eq(sources.id, crawlJobs.sourceId))
    .where(eq(crawlJobs.id, jobId))
    .limit(1);
  if (!job) return null;

  const [itemsByStatus, urlOutcomes, byHost, timing] = await Promise.all([
    db
      .select({ status: crawlJobItems.status, n: sql<number>`count(*)::int` })
      .from(crawlJobItems)
      .where(eq(crawlJobItems.jobId, jobId))
      .groupBy(crawlJobItems.status),
    db
      .select({ outcome: crawlJobUrls.outcome, n: sql<number>`count(*)::int` })
      .from(crawlJobUrls)
      .where(eq(crawlJobUrls.jobId, jobId))
      .groupBy(crawlJobUrls.outcome),
    db
      .select({
        host: crawlJobItems.host,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${crawlJobItems.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${crawlJobItems.status} in ('failed','dead_letter'))::int`,
      })
      .from(crawlJobItems)
      .where(eq(crawlJobItems.jobId, jobId))
      .groupBy(crawlJobItems.host)
      .orderBy(desc(sql`count(*)`))
      .limit(25),
    // Throughput for the §24 observability panel.
    db
      .select({
        avgMs: sql<number | null>`avg(${crawlJobItems.durationMs})::int`,
        p95Ms: sql<number | null>`percentile_disc(0.95) within group (order by ${crawlJobItems.durationMs})::int`,
        maxMs: sql<number | null>`max(${crawlJobItems.durationMs})::int`,
        completedLastMinute: sql<number>`count(*) filter (where ${crawlJobItems.finishedAt} > now() - interval '1 minute')::int`,
      })
      .from(crawlJobItems)
      .where(and(eq(crawlJobItems.jobId, jobId), isNotNull(crawlJobItems.durationMs))),
  ]);

  return {
    ...job,
    itemsByStatus: Object.fromEntries(itemsByStatus.map((r) => [r.status, r.n])),
    urlOutcomes: Object.fromEntries(urlOutcomes.map((r) => [r.outcome, r.n])),
    byHost,
    timing: timing[0] ?? null,
  };
}

export async function listJobItems(
  db: Db,
  jobId: string,
  filters: { statuses?: readonly string[]; q?: string },
  pagination: OffsetPagination,
) {
  const conditions: SQL[] = [eq(crawlJobItems.jobId, jobId)];
  if (filters.statuses?.length) {
    conditions.push(sql`${crawlJobItems.status}::text in ${filters.statuses}`);
  }
  if (filters.q?.trim()) {
    conditions.push(sql`${crawlJobItems.url} ilike ${`%${filters.q.trim().slice(0, 200)}%`}`);
  }
  const where = and(...conditions);
  const { limit, offset } = toOffset(pagination);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        item: crawlJobItems,
        contentTitle: contentItems.title,
        contentStatus: contentItems.status,
      })
      .from(crawlJobItems)
      .leftJoin(contentItems, eq(contentItems.id, crawlJobItems.contentItemId))
      .where(where)
      .orderBy(asc(crawlJobItems.depth), asc(crawlJobItems.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(crawlJobItems).where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

export async function listJobUrls(
  db: Db,
  jobId: string,
  outcome: string | undefined,
  pagination: OffsetPagination,
) {
  const conditions: SQL[] = [eq(crawlJobUrls.jobId, jobId)];
  if (outcome) conditions.push(sql`${crawlJobUrls.outcome}::text = ${outcome}`);
  const where = and(...conditions);
  const { limit, offset } = toOffset(pagination);

  const [rows, countRows] = await Promise.all([
    db.select().from(crawlJobUrls).where(where).orderBy(asc(crawlJobUrls.lineNumber)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(crawlJobUrls).where(where),
  ]);
  return { rows, total: countRows[0]?.n ?? 0 };
}

export async function listJobLog(
  db: Db,
  jobId: string,
  levels: readonly string[] | undefined,
  limit = 200,
) {
  const conditions: SQL[] = [eq(crawlJobEvents.jobId, jobId)];
  if (levels?.length) conditions.push(sql`${crawlJobEvents.level}::text in ${levels}`);
  return db
    .select()
    .from(crawlJobEvents)
    .where(and(...conditions))
    .orderBy(desc(crawlJobEvents.createdAt))
    .limit(limit);
}

// --- Review queue ---------------------------------------------------------

export async function listReviewQueue(
  db: Db,
  filters: {
    assignedTo?: string | null;
    unassignedOnly?: boolean;
    reasons?: readonly string[];
    kinds?: readonly string[];
    sourceId?: string;
    lowConfidenceFirst?: boolean;
  },
  pagination: OffsetPagination,
) {
  const conditions: SQL[] = [
    eq(contentItems.status, "needs_review"),
    isNull(contentItems.deletedAt),
  ];
  if (filters.kinds?.length) conditions.push(sql`${contentItems.kind}::text in ${filters.kinds}`);
  if (filters.sourceId) conditions.push(eq(contentItems.sourceId, filters.sourceId));
  if (filters.assignedTo) {
    conditions.push(sql`exists (
      select 1 from ${reviews} r where r.content_item_id = ${contentItems.id}
        and r.assigned_to = ${filters.assignedTo} and r.status in ('pending','in_progress')
    )`);
  }
  if (filters.unassignedOnly) {
    conditions.push(sql`not exists (
      select 1 from ${reviews} r where r.content_item_id = ${contentItems.id}
        and r.assigned_to is not null and r.status in ('pending','in_progress')
    )`);
  }
  if (filters.reasons?.length) {
    conditions.push(sql`exists (
      select 1 from ${reviews} r where r.content_item_id = ${contentItems.id}
        and r.reason::text in ${filters.reasons} and r.status in ('pending','in_progress')
    )`);
  }

  const where = and(...conditions);
  const { limit, offset } = toOffset(pagination);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        kind: contentItems.kind,
        title: contentItems.title,
        sourceUrl: contentItems.sourceUrl,
        primaryMediaId: contentItems.primaryMediaId,
        rightsStatus: contentItems.rightsStatus,
        capturedAt: contentItems.capturedAt,
        createdAt: contentItems.createdAt,
        classificationConfidence: contentItems.classificationConfidence,
        version: contentItems.version,
        sourceName: sources.name,
        sourceId: sources.id,
        thumbnailKey: sql<string | null>`(
          select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
          where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
            and ${mediaDerivatives.kind} = 'thumbnail' limit 1
        )`,
        reviewReason: sql<string | null>`(
          select r.reason::text from ${reviews} r
          where r.content_item_id = ${contentItems}.id and r.status in ('pending','in_progress')
          limit 1
        )`,
        assignedToName: sql<string | null>`(
          select u.name from ${reviews} r join ${users} u on u.id = r.assigned_to
          where r.content_item_id = ${contentItems}.id and r.status in ('pending','in_progress')
          limit 1
        )`,
        pendingSuggestions: sql<number>`(
          select count(*)::int from ${taxonomyAssignments} ta
          where ta.content_item_id = ${contentItems}.id and ta.review_status = 'pending'
        )`,
      })
      .from(contentItems)
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where)
      // Lowest-confidence first when asked: those are where a reviewer's
      // judgement adds the most, so they are worth the first pass.
      .orderBy(
        filters.lowConfidenceFirst
          ? asc(sql`coalesce(${contentItems.classificationConfidence}, 0)`)
          : asc(contentItems.createdAt),
        asc(contentItems.id),
      )
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItems)
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

// --- Taxonomy -------------------------------------------------------------

export async function listTaxonomyTerms(
  db: Db,
  filters: { kinds?: readonly string[]; statuses?: readonly string[]; q?: string; parentId?: string | null },
) {
  const conditions: SQL[] = [];
  if (filters.kinds?.length) conditions.push(sql`${taxonomyTerms.kind}::text in ${filters.kinds}`);
  if (filters.statuses?.length) {
    conditions.push(sql`${taxonomyTerms.status}::text in ${filters.statuses}`);
  }
  if (filters.parentId !== undefined) {
    conditions.push(
      filters.parentId === null
        ? isNull(taxonomyTerms.parentId)
        : eq(taxonomyTerms.parentId, filters.parentId),
    );
  }
  if (filters.q?.trim()) {
    const term = filters.q.trim().slice(0, 100);
    conditions.push(
      or(
        sql`${taxonomyTerms.searchVector} @@ websearch_to_tsquery('english', ${term})`,
        sql`${taxonomyTerms.name} ilike ${`%${term}%`}`,
        sql`exists (select 1 from unnest(${taxonomyTerms.aliases}) a where a ilike ${`%${term}%`})`,
      )!,
    );
  }

  return db
    .select({
      id: taxonomyTerms.id,
      kind: taxonomyTerms.kind,
      parentId: taxonomyTerms.parentId,
      name: taxonomyTerms.name,
      slug: taxonomyTerms.slug,
      description: taxonomyTerms.description,
      aliases: taxonomyTerms.aliases,
      status: taxonomyTerms.status,
      path: taxonomyTerms.path,
      depth: taxonomyTerms.depth,
      sortOrder: taxonomyTerms.sortOrder,
      usageCount: taxonomyTerms.usageCount,
      color: taxonomyTerms.color,
      isSeed: taxonomyTerms.isSeed,
      createdAt: taxonomyTerms.createdAt,
      updatedAt: taxonomyTerms.updatedAt,
      childCount: sql<number>`(select count(*)::int from ${taxonomyTerms} c where c.parent_id = ${taxonomyTerms}.id)`,
    })
    .from(taxonomyTerms)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(taxonomyTerms.kind), asc(taxonomyTerms.path))
    .limit(2_000);
}

/** Suggestions awaiting a human, for the classification review screen (§14). */
export async function listPendingSuggestions(db: Db, pagination: OffsetPagination) {
  const { limit, offset } = toOffset(pagination);
  const [rows, countRows] = await Promise.all([
    db
      .select({
        assignment: taxonomyAssignments,
        term: taxonomyTerms,
        contentId: contentItems.id,
        contentTitle: contentItems.title,
        contentKind: contentItems.kind,
        contentStatus: contentItems.status,
      })
      .from(taxonomyAssignments)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
      .innerJoin(contentItems, eq(contentItems.id, taxonomyAssignments.contentItemId))
      .where(and(eq(taxonomyAssignments.reviewStatus, "pending"), isNull(contentItems.deletedAt)))
      .orderBy(desc(taxonomyAssignments.confidence))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(taxonomyAssignments)
      .where(eq(taxonomyAssignments.reviewStatus, "pending")),
  ]);
  return { rows, total: countRows[0]?.n ?? 0 };
}

// --- Failed / needs attention (§12 of the IA) -----------------------------

/**
 * Everything that needs a person, in one list.
 *
 * The CMS's "Failed / Needs Attention" section. Deliberately a union of
 * different problems — failed captures, dead-lettered queue items, rights
 * holds, unhealthy sources — because an operator's question is "what needs me
 * today", not "show me failed captures specifically".
 */
export async function listNeedsAttention(db: Db) {
  const [failedContent, deadItems, blockedItems, rightsHolds, unhealthySources, failedCaptures] =
    await Promise.all([
      db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          status: contentItems.status,
          sourceUrl: contentItems.sourceUrl,
          updatedAt: contentItems.updatedAt,
          sourceName: sources.name,
        })
        .from(contentItems)
        .leftJoin(sources, eq(sources.id, contentItems.sourceId))
        .where(
          and(
            inArray(contentItems.status, [...ATTENTION_STATUSES]),
            isNull(contentItems.deletedAt),
          ),
        )
        .orderBy(desc(contentItems.updatedAt))
        .limit(50),

      db
        .select({
          id: crawlJobItems.id,
          url: crawlJobItems.url,
          errorCode: crawlJobItems.errorCode,
          errorMessage: crawlJobItems.errorMessage,
          attempts: crawlJobItems.attempts,
          finishedAt: crawlJobItems.finishedAt,
          jobId: crawlJobs.id,
          jobReference: crawlJobs.reference,
        })
        .from(crawlJobItems)
        .innerJoin(crawlJobs, eq(crawlJobs.id, crawlJobItems.jobId))
        .where(eq(crawlJobItems.status, "dead_letter"))
        .orderBy(desc(crawlJobItems.finishedAt))
        .limit(50),

      db
        .select({
          id: crawlJobItems.id,
          url: crawlJobItems.url,
          errorCode: crawlJobItems.errorCode,
          errorMessage: crawlJobItems.errorMessage,
          finishedAt: crawlJobItems.finishedAt,
          jobReference: crawlJobs.reference,
        })
        .from(crawlJobItems)
        .innerJoin(crawlJobs, eq(crawlJobs.id, crawlJobItems.jobId))
        .where(eq(crawlJobItems.status, "blocked"))
        .orderBy(desc(crawlJobItems.finishedAt))
        .limit(50),

      db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          rightsStatus: contentItems.rightsStatus,
          legalReviewStatus: contentItems.legalReviewStatus,
          takedownStatus: contentItems.takedownStatus,
          updatedAt: contentItems.updatedAt,
        })
        .from(contentItems)
        .where(
          and(
            sql`${contentItems.rightsStatus}::text in ('pending_review','restricted')`,
            isNull(contentItems.deletedAt),
          ),
        )
        .orderBy(desc(contentItems.updatedAt))
        .limit(50),

      db
        .select({
          id: sources.id,
          name: sources.name,
          domain: sources.domain,
          health: sources.health,
          consecutiveFailures: sources.consecutiveFailures,
          lastErrorMessage: sources.lastErrorMessage,
          lastCapturedAt: sources.lastCapturedAt,
        })
        .from(sources)
        .where(
          and(
            sql`${sources.health}::text in ('unavailable','blocked','redirected','requires_review','needs_recapture')`,
            isNull(sources.deletedAt),
          ),
        )
        .orderBy(desc(sources.consecutiveFailures))
        .limit(50),

      db
        .select({
          id: captures.id,
          requestedUrl: captures.requestedUrl,
          errorCode: captures.errorCode,
          errorMessage: captures.errorMessage,
          createdAt: captures.createdAt,
          contentItemId: captures.contentItemId,
        })
        .from(captures)
        .where(eq(captures.status, "failed"))
        .orderBy(desc(captures.createdAt))
        .limit(50),
    ]);

  return { failedContent, deadItems, blockedItems, rightsHolds, unhealthySources, failedCaptures };
}

// --- Collections ----------------------------------------------------------

export async function listCollections(db: Db) {
  return db
    .select({
      id: collections.id,
      name: collections.name,
      slug: collections.slug,
      description: collections.description,
      visibility: collections.visibility,
      status: collections.status,
      itemCount: collections.itemCount,
      module: collections.module,
      createdAt: collections.createdAt,
      updatedAt: collections.updatedAt,
      publishedAt: collections.publishedAt,
      curatorName: sql<string | null>`(select name from ${users} where id = ${collections}.curated_by)`,
      publishedItemCount: sql<number>`(
        select count(*)::int from ${collectionItems} ci
        join ${contentItems} c on c.id = ci.content_item_id
        where ci.collection_id = ${collections}.id and c.status = 'published' and c.deleted_at is null
      )`,
    })
    .from(collections)
    .where(isNull(collections.deletedAt))
    .orderBy(asc(collections.sortOrder), asc(collections.name));
}

// --- Global search (§31) --------------------------------------------------

/**
 * Cross-entity search for the CMS command palette.
 *
 * Runs one bounded query per entity type in parallel rather than a UNION,
 * because each has a different shape and ranking, and a UNION would force them
 * into a lowest-common-denominator row.
 */
export async function globalSearch(db: Db, query: string, limitPerType = 5) {
  const term = query.trim().slice(0, 200);
  if (term.length < 2) {
    return { content: [], sources: [], media: [], terms: [], jobs: [], collections: [] };
  }
  const like = `%${term}%`;
  const tsq = sql`websearch_to_tsquery('english', ${term})`;

  const [content, sourceRows, media, terms, jobs, collectionRows] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        kind: contentItems.kind,
        status: contentItems.status,
        sourceUrl: contentItems.sourceUrl,
        rank: sql<number>`ts_rank(${contentItems.searchVector}, ${tsq})`,
      })
      .from(contentItems)
      .where(
        and(
          isNull(contentItems.deletedAt),
          or(sql`${contentItems.searchVector} @@ ${tsq}`, sql`${contentItems.title} ilike ${like}`)!,
        ),
      )
      .orderBy(desc(sql`ts_rank(${contentItems.searchVector}, ${tsq})`))
      .limit(limitPerType),
    db
      .select({ id: sources.id, name: sources.name, domain: sources.domain, health: sources.health })
      .from(sources)
      .where(
        and(
          isNull(sources.deletedAt),
          or(sql`${sources.searchVector} @@ ${tsq}`, sql`${sources.name} ilike ${like}`, sql`${sources.domain} ilike ${like}`)!,
        ),
      )
      .limit(limitPerType),
    db
      .select({
        id: mediaAssets.id,
        originalFilename: mediaAssets.originalFilename,
        mimeType: mediaAssets.mimeType,
        kind: mediaAssets.kind,
      })
      .from(mediaAssets)
      .where(
        and(
          isNull(mediaAssets.deletedAt),
          or(sql`${mediaAssets.searchVector} @@ ${tsq}`, sql`${mediaAssets.originalFilename} ilike ${like}`)!,
        ),
      )
      .limit(limitPerType),
    db
      .select({
        id: taxonomyTerms.id,
        name: taxonomyTerms.name,
        kind: taxonomyTerms.kind,
        path: taxonomyTerms.path,
        usageCount: taxonomyTerms.usageCount,
      })
      .from(taxonomyTerms)
      .where(or(sql`${taxonomyTerms.searchVector} @@ ${tsq}`, sql`${taxonomyTerms.name} ilike ${like}`))
      .limit(limitPerType),
    db
      .select({
        id: crawlJobs.id,
        reference: crawlJobs.reference,
        name: crawlJobs.name,
        status: crawlJobs.status,
      })
      .from(crawlJobs)
      .where(or(sql`${crawlJobs.name} ilike ${like}`, sql`${crawlJobs.reference} ilike ${like}`))
      .limit(limitPerType),
    db
      .select({ id: collections.id, name: collections.name, visibility: collections.visibility })
      .from(collections)
      .where(and(isNull(collections.deletedAt), sql`${collections.name} ilike ${like}`))
      .limit(limitPerType),
  ]);

  // A URL search should find the page it belongs to, which full-text will not
  // do for a long URL — so try the URL registry too.
  const byUrl = /^https?:\/\//i.test(term)
    ? await db
        .select({ contentItemId: urlRegistry.contentItemId, normalizedUrl: urlRegistry.normalizedUrl })
        .from(urlRegistry)
        .where(sql`${urlRegistry.normalizedUrl} ilike ${like}`)
        .limit(limitPerType)
    : [];

  return { content, sources: sourceRows, media, terms, jobs, collections: collectionRows, byUrl };
}

// --- Workers (§24) --------------------------------------------------------

export async function listWorkers(db: Db) {
  return db
    .select({
      id: workerInstances.id,
      name: workerInstances.name,
      hostname: workerInstances.hostname,
      version: workerInstances.version,
      capabilities: workerInstances.capabilities,
      startedAt: workerInstances.startedAt,
      lastHeartbeatAt: workerInstances.lastHeartbeatAt,
      itemsInFlight: workerInstances.itemsInFlight,
      itemsCompleted: workerInstances.itemsCompleted,
      itemsFailed: workerInstances.itemsFailed,
      stoppedAt: workerInstances.stoppedAt,
      isStale: sql<boolean>`${workerInstances.lastHeartbeatAt} < now() - interval '2 minutes'`,
    })
    .from(workerInstances)
    .where(isNull(workerInstances.stoppedAt))
    .orderBy(desc(workerInstances.lastHeartbeatAt))
    .limit(50);
}

// --- Patterns -------------------------------------------------------------

/**
 * The pattern vocabularies, with what they have been attached to (§13).
 *
 * "Patterns" is a view over taxonomy rather than a table of its own, which is
 * the whole point of §2's instruction that UX/UI is a classification layer
 * applied to content rather than a top-level content source. A pattern is a
 * taxonomy term; what makes it interesting is the set of pages and screens
 * carrying it.
 *
 * Counts are split by provenance because §14's distinction between a machine
 * suggestion and a human decision is exactly what a curator needs here: a term
 * with 200 suggested and 3 confirmed uses is a term nobody has validated, and
 * that is invisible if the two are added together.
 */
export async function listPatterns(
  db: Db,
  filters: { kinds?: readonly string[]; q?: string; unusedOnly?: boolean },
) {
  const conditions: SQL[] = [
    sql`${taxonomyTerms.kind}::text in ${filters.kinds?.length ? filters.kinds : ["ux_pattern", "ui_pattern", "component", "interaction_type"]}`,
    ne(taxonomyTerms.status, "archived"),
  ];
  if (filters.q?.trim()) {
    const term = filters.q.trim().slice(0, 100);
    conditions.push(
      or(
        sql`${taxonomyTerms.name} ilike ${`%${term}%`}`,
        sql`exists (select 1 from unnest(${taxonomyTerms.aliases}) a where a ilike ${`%${term}%`})`,
      )!,
    );
  }

  const rows = await db
    .select({
      id: taxonomyTerms.id,
      kind: taxonomyTerms.kind,
      name: taxonomyTerms.name,
      slug: taxonomyTerms.slug,
      description: taxonomyTerms.description,
      path: taxonomyTerms.path,
      depth: taxonomyTerms.depth,
      status: taxonomyTerms.status,
      color: taxonomyTerms.color,
      aliases: taxonomyTerms.aliases,
      confirmedCount: sql<number>`(
        select count(distinct ta.content_item_id)::int
        from ${taxonomyAssignments} ta
        join ${contentItems} ci on ci.id = ta.content_item_id
        where ta.term_id = ${taxonomyTerms}.id
          and ta.origin in ('human_verified','human_modified','human_added')
          and ci.deleted_at is null
      )`,
      suggestedCount: sql<number>`(
        select count(distinct ta.content_item_id)::int
        from ${taxonomyAssignments} ta
        join ${contentItems} ci on ci.id = ta.content_item_id
        where ta.term_id = ${taxonomyTerms}.id
          and ta.origin = 'ai_suggested'
          and ta.review_status = 'pending'
          and ci.deleted_at is null
      )`,
      publishedCount: sql<number>`(
        select count(distinct ta.content_item_id)::int
        from ${taxonomyAssignments} ta
        join ${contentItems} ci on ci.id = ta.content_item_id
        where ta.term_id = ${taxonomyTerms}.id
          and ta.origin in ('human_verified','human_modified','human_added')
          and ci.status = 'published'
          and ci.deleted_at is null
      )`,
    })
    .from(taxonomyTerms)
    .where(and(...conditions))
    .orderBy(asc(taxonomyTerms.kind), asc(taxonomyTerms.path))
    .limit(1_000);

  return filters.unusedOnly
    ? rows.filter((row) => row.confirmedCount === 0 && row.suggestedCount === 0)
    : rows;
}

/** Content carrying one pattern, for the pattern detail view. */
export async function listContentForPattern(
  db: Db,
  termId: string,
  pagination: OffsetPagination,
) {
  const { limit, offset } = toOffset(pagination);
  const where = and(
    eq(taxonomyAssignments.termId, termId),
    isNull(contentItems.deletedAt),
  );

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        kind: contentItems.kind,
        status: contentItems.status,
        sourceName: sources.name,
        sourceId: sources.id,
        origin: taxonomyAssignments.origin,
        confidence: taxonomyAssignments.confidence,
        reviewStatus: taxonomyAssignments.reviewStatus,
        capturedAt: contentItems.capturedAt,
        primaryMediaId: contentItems.primaryMediaId,
        thumbnailKey: sql<string | null>`(
          select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
          where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
            and ${mediaDerivatives.kind} = 'thumbnail'
          limit 1
        )`,
      })
      .from(taxonomyAssignments)
      .innerJoin(contentItems, eq(contentItems.id, taxonomyAssignments.contentItemId))
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where)
      .orderBy(desc(contentItems.capturedAt), desc(contentItems.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(taxonomyAssignments)
      .innerJoin(contentItems, eq(contentItems.id, taxonomyAssignments.contentItemId))
      .where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

// --- Collections ----------------------------------------------------------

/** One collection with its ordered membership (§11). */
export async function getCollectionDetail(db: Db, collectionId: string) {
  const [collection] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
    .limit(1);
  if (!collection) return null;

  const items = await db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      kind: contentItems.kind,
      status: contentItems.status,
      rightsStatus: contentItems.rightsStatus,
      capturedAt: contentItems.capturedAt,
      publishedAt: contentItems.publishedAt,
      sourceId: sources.id,
      sourceName: sources.name,
      position: collectionItems.position,
      note: collectionItems.note,
      addedAt: collectionItems.createdAt,
      thumbnailKey: sql<string | null>`(
        select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
        where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
          and ${mediaDerivatives.kind} = 'thumbnail'
        limit 1
      )`,
    })
    .from(collectionItems)
    .innerJoin(contentItems, eq(contentItems.id, collectionItems.contentItemId))
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(eq(collectionItems.collectionId, collectionId), isNull(contentItems.deletedAt)))
    .orderBy(asc(collectionItems.position), asc(collectionItems.createdAt))
    .limit(500);

  return { collection, items };
}

// --- Flows ----------------------------------------------------------------

/**
 * Flows, with their step counts (§2).
 *
 * A flow is a content record of kind `flow` — same spine, same lifecycle, same
 * publish gate — whose distinguishing detail is an ordered path through other
 * records. So this is a content query with a join to `flow_details`, not a
 * separate subsystem.
 *
 * `stepCount` is read from the detail row rather than counted, because it is
 * maintained when steps change and a flow list would otherwise pay a count per
 * row. `actualStepCount` is counted alongside it so a drift between the two is
 * visible instead of silent.
 */
export async function listFlows(
  db: Db,
  filters: { q?: string; statuses?: readonly string[]; sourceId?: string },
  pagination: OffsetPagination,
) {
  const conditions: SQL[] = [eq(contentItems.kind, "flow"), isNull(contentItems.deletedAt)];
  if (filters.statuses?.length) {
    conditions.push(sql`${contentItems.status}::text in ${filters.statuses}`);
  }
  if (filters.sourceId) conditions.push(eq(contentItems.sourceId, filters.sourceId));
  if (filters.q?.trim()) {
    const term = filters.q.trim().slice(0, 200);
    conditions.push(
      or(
        sql`${contentItems.searchVector} @@ websearch_to_tsquery('english', ${term})`,
        sql`${contentItems.title} ilike ${`%${term}%`}`,
      )!,
    );
  }

  const where = and(...conditions);
  const { limit, offset } = toOffset(pagination);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        slug: contentItems.slug,
        status: contentItems.status,
        module: contentItems.module,
        rightsStatus: contentItems.rightsStatus,
        capturedAt: contentItems.capturedAt,
        publishedAt: contentItems.publishedAt,
        updatedAt: contentItems.updatedAt,
        sourceId: sources.id,
        sourceName: sources.name,
        goal: flowDetails.goal,
        stepCount: flowDetails.stepCount,
        observations: flowDetails.observations,
        actualStepCount: sql<number>`(
          select count(*)::int from ${flowSteps} fs where fs.flow_id = ${contentItems}.id
        )`,
        publishedStepCount: sql<number>`(
          select count(*)::int from ${flowSteps} fs
          join ${contentItems} step on step.id = fs.content_item_id
          where fs.flow_id = ${contentItems}.id
            and step.status = 'published'
            and step.deleted_at is null
        )`,
      })
      .from(contentItems)
      .leftJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where)
      .orderBy(desc(contentItems.updatedAt), desc(contentItems.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(contentItems).where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

/** One flow's ordered steps, for the flow viewer. */
export async function getFlowSteps(db: Db, flowId: string) {
  return db
    .select({
      stepId: flowSteps.id,
      position: flowSteps.position,
      label: flowSteps.label,
      note: flowSteps.note,
      contentId: contentItems.id,
      title: contentItems.title,
      kind: contentItems.kind,
      status: contentItems.status,
      sourceUrl: contentItems.sourceUrl,
      capturedAt: contentItems.capturedAt,
      thumbnailKey: sql<string | null>`(
        select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
        where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
          and ${mediaDerivatives.kind} = 'thumbnail'
        limit 1
      )`,
      fullKey: mediaAssets.storageKey,
    })
    .from(flowSteps)
    .innerJoin(contentItems, eq(contentItems.id, flowSteps.contentItemId))
    .leftJoin(mediaAssets, eq(mediaAssets.id, contentItems.primaryMediaId))
    .where(and(eq(flowSteps.flowId, flowId), isNull(contentItems.deletedAt)))
    .orderBy(asc(flowSteps.position))
    .limit(200);
}
