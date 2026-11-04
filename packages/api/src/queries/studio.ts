/**
 * CMS reads for discovery, screens and live sessions (§14).
 *
 * Separate from `queries/cms.ts` because these answer a different question.
 * That module serves the library — things we have decided to keep. This one
 * serves the working surface: what a crawl found, what a researcher captured,
 * and what browser is open right now.
 *
 * Every list here is built for triage speed. A researcher looking at 300
 * candidates makes a decision every couple of seconds, so each query returns
 * the thumbnail key alongside the row rather than leaving the page to resolve
 * media per item — that difference is 300 extra round trips per screenful.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type Db,
  captureSessionCommands,
  captureSessions,
  contentItems,
  discoveredPages,
  flowDetails,
  flowSteps,
  mediaDerivatives,
  screenDetails,
  sources,
  taxonomyAssignments,
  users,
} from "@uxd/database";
import { type OffsetPagination, toOffset } from "@uxd/shared";
import type { DiscoveredPageStatus, LifecycleStatus } from "@uxd/types";

// --- Discovered pages -----------------------------------------------------

export interface DiscoveredPageFilters {
  readonly q?: string;
  readonly statuses?: readonly DiscoveredPageStatus[];
  readonly sourceId?: string;
  readonly jobId?: string;
  readonly host?: string;
  readonly maxDepth?: number;
  readonly sort?: "newest" | "oldest" | "path" | "mostSeen";
}

function discoveredConditions(filters: DiscoveredPageFilters) {
  const conditions = [];
  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(discoveredPages.status, [...filters.statuses]));
  }
  if (filters.sourceId) conditions.push(eq(discoveredPages.sourceId, filters.sourceId));
  if (filters.jobId) conditions.push(eq(discoveredPages.jobId, filters.jobId));
  if (filters.host) conditions.push(eq(discoveredPages.host, filters.host));
  if (typeof filters.maxDepth === "number") {
    conditions.push(sql`${discoveredPages.depth} <= ${filters.maxDepth}`);
  }
  if (filters.q && filters.q.trim().length > 0) {
    const term = `%${filters.q.trim().toLowerCase()}%`;
    // Substring rather than full-text: a researcher filtering candidates is
    // usually typing a path fragment ("/pricing", "/docs/"), and `to_tsquery`
    // does not match inside a URL path the way they expect.
    conditions.push(
      or(
        sql`lower(${discoveredPages.url}) like ${term}`,
        sql`lower(coalesce(${discoveredPages.title}, '')) like ${term}`,
      ),
    );
  }
  return conditions;
}

export async function listDiscoveredPages(
  db: Db,
  filters: DiscoveredPageFilters,
  pagination: OffsetPagination,
) {
  const conditions = discoveredConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const { limit, offset } = toOffset(pagination);

  const order = (() => {
    switch (filters.sort) {
      case "oldest":
        return asc(discoveredPages.createdAt);
      case "path":
        return asc(discoveredPages.path);
      case "mostSeen":
        return desc(discoveredPages.seenCount);
      default:
        return desc(discoveredPages.createdAt);
    }
  })();

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: discoveredPages.id,
        status: discoveredPages.status,
        url: discoveredPages.url,
        path: discoveredPages.path,
        host: discoveredPages.host,
        title: discoveredPages.title,
        description: discoveredPages.description,
        httpStatus: discoveredPages.httpStatus,
        wordCount: discoveredPages.wordCount,
        depth: discoveredPages.depth,
        seenCount: discoveredPages.seenCount,
        screenCount: discoveredPages.screenCount,
        ignoreReason: discoveredPages.ignoreReason,
        firstSeenAt: discoveredPages.firstSeenAt,
        lastSeenAt: discoveredPages.lastSeenAt,
        createdAt: discoveredPages.createdAt,
        sourceId: sources.id,
        sourceName: sources.name,
        sourceDomain: sources.domain,
        previewKey: sql<string | null>`(
          select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
          where ${mediaDerivatives.mediaId} = ${discoveredPages}.preview_media_id
            and ${mediaDerivatives.kind} = 'thumbnail'
          limit 1
        )`,
      })
      .from(discoveredPages)
      .leftJoin(sources, eq(sources.id, discoveredPages.sourceId))
      .where(where)
      .orderBy(order, desc(discoveredPages.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(discoveredPages).where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

/** Counts for the status chips, over the same filters minus status itself. */
export async function discoveredStatusCounts(db: Db, filters: DiscoveredPageFilters = {}) {
  const conditions = discoveredConditions({ ...filters, statuses: undefined });
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({ status: discoveredPages.status, n: sql<number>`count(*)::int` })
    .from(discoveredPages)
    .where(where)
    .groupBy(discoveredPages.status);

  const counts: Record<string, number> = { new: 0, captured: 0, ignored: 0 };
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

export async function getDiscoveredPage(db: Db, id: string) {
  const [row] = await db
    .select({
      id: discoveredPages.id,
      status: discoveredPages.status,
      url: discoveredPages.url,
      normalizedUrl: discoveredPages.normalizedUrl,
      finalUrl: discoveredPages.finalUrl,
      path: discoveredPages.path,
      host: discoveredPages.host,
      title: discoveredPages.title,
      description: discoveredPages.description,
      ogTitle: discoveredPages.ogTitle,
      h1: discoveredPages.h1,
      langAttr: discoveredPages.langAttr,
      httpStatus: discoveredPages.httpStatus,
      wordCount: discoveredPages.wordCount,
      depth: discoveredPages.depth,
      discoveredFromUrl: discoveredPages.discoveredFromUrl,
      seenCount: discoveredPages.seenCount,
      screenCount: discoveredPages.screenCount,
      ignoreReason: discoveredPages.ignoreReason,
      ignoreNote: discoveredPages.ignoreNote,
      firstSeenAt: discoveredPages.firstSeenAt,
      lastSeenAt: discoveredPages.lastSeenAt,
      jobId: discoveredPages.jobId,
      sourceId: sources.id,
      sourceName: sources.name,
      sourceDomain: sources.domain,
      triagedByName: users.name,
      triagedAt: discoveredPages.triagedAt,
    })
    .from(discoveredPages)
    .leftJoin(sources, eq(sources.id, discoveredPages.sourceId))
    .leftJoin(users, eq(users.id, discoveredPages.triagedBy))
    .where(eq(discoveredPages.id, id))
    .limit(1);

  return row ?? null;
}

/** Screens already captured from one candidate, so triage shows the work. */
export async function screensForDiscoveredPage(db: Db, discoveredPageId: string) {
  return db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      status: contentItems.status,
      stateLabel: screenDetails.stateLabel,
      deviceProfile: screenDetails.deviceProfile,
      capturedAt: contentItems.capturedAt,
      thumbnailKey: sql<string | null>`(
        select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
        where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
          and ${mediaDerivatives.kind} = 'thumbnail'
        limit 1
      )`,
    })
    .from(screenDetails)
    .innerJoin(contentItems, eq(contentItems.id, screenDetails.contentItemId))
    .where(and(eq(screenDetails.discoveredPageId, discoveredPageId), isNull(contentItems.deletedAt)))
    .orderBy(desc(contentItems.capturedAt));
}

// --- Screens --------------------------------------------------------------

export interface ScreenFilters {
  readonly q?: string;
  readonly statuses?: readonly LifecycleStatus[];
  readonly sourceId?: string;
  readonly deviceProfile?: string;
  readonly acquisition?: string;
  readonly sort?: "newest" | "oldest" | "title";
}

function screenConditions(filters: ScreenFilters) {
  const conditions = [eq(contentItems.kind, "screen"), isNull(contentItems.deletedAt)];
  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(contentItems.status, [...filters.statuses]));
  }
  if (filters.sourceId) conditions.push(eq(contentItems.sourceId, filters.sourceId));
  if (filters.deviceProfile) conditions.push(eq(screenDetails.deviceProfile, filters.deviceProfile));
  if (filters.acquisition) conditions.push(eq(screenDetails.acquisition, filters.acquisition));
  if (filters.q && filters.q.trim().length > 0) {
    const term = `%${filters.q.trim().toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(coalesce(${contentItems.title}, '')) like ${term}`,
        sql`lower(coalesce(${screenDetails.url}, '')) like ${term}`,
      )!,
    );
  }
  return conditions;
}

export async function listScreens(db: Db, filters: ScreenFilters, pagination: OffsetPagination) {
  const where = and(...screenConditions(filters));
  const { limit, offset } = toOffset(pagination);

  const order = (() => {
    switch (filters.sort) {
      case "oldest":
        return asc(contentItems.capturedAt);
      case "title":
        return asc(contentItems.title);
      default:
        return desc(contentItems.capturedAt);
    }
  })();

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        slug: contentItems.slug,
        status: contentItems.status,
        capturedAt: contentItems.capturedAt,
        updatedAt: contentItems.updatedAt,
        deviceClass: contentItems.deviceClass,
        screenName: screenDetails.screenName,
        stateLabel: screenDetails.stateLabel,
        url: screenDetails.url,
        deviceProfile: screenDetails.deviceProfile,
        viewportWidth: screenDetails.viewportWidth,
        viewportHeight: screenDetails.viewportHeight,
        acquisition: screenDetails.acquisition,
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
        acceptedTags: sql<number>`(
          select count(*)::int from ${taxonomyAssignments} ta
          where ta.content_item_id = ${contentItems}.id and ta.review_status = 'accepted'
        )`,
      })
      .from(contentItems)
      .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where)
      .orderBy(order, desc(contentItems.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItems)
      .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .where(where),
  ]);

  return { rows, total: countRows[0]?.n ?? 0 };
}

export async function screenStatusCounts(db: Db, filters: ScreenFilters = {}) {
  const where = and(...screenConditions({ ...filters, statuses: undefined }));
  const rows = await db
    .select({ status: contentItems.status, n: sql<number>`count(*)::int` })
    .from(contentItems)
    .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
    .where(where)
    .groupBy(contentItems.status);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** Everything the Screen review page needs, in one read. */
export async function getScreenDetail(db: Db, contentItemId: string) {
  const [row] = await db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      slug: contentItems.slug,
      description: contentItems.description,
      status: contentItems.status,
      sourceUrl: contentItems.sourceUrl,
      platform: contentItems.platform,
      deviceClass: contentItems.deviceClass,
      capturedAt: contentItems.capturedAt,
      publishedAt: contentItems.publishedAt,
      updatedAt: contentItems.updatedAt,
      notes: contentItems.notes,
      reviewNotes: contentItems.reviewNotes,
      rightsStatus: contentItems.rightsStatus,
      primaryMediaId: contentItems.primaryMediaId,
      screenName: screenDetails.screenName,
      stateLabel: screenDetails.stateLabel,
      url: screenDetails.url,
      acquisition: screenDetails.acquisition,
      deviceProfile: screenDetails.deviceProfile,
      viewportWidth: screenDetails.viewportWidth,
      viewportHeight: screenDetails.viewportHeight,
      deviceScaleFactor: screenDetails.deviceScaleFactor,
      captureSessionId: screenDetails.captureSessionId,
      discoveredPageId: screenDetails.discoveredPageId,
      sourceId: sources.id,
      sourceName: sources.name,
      sourceDomain: sources.domain,
    })
    .from(contentItems)
    .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(eq(contentItems.id, contentItemId), isNull(contentItems.deletedAt)))
    .limit(1);

  if (!row) return null;

  const flows = await db
    .select({
      flowId: contentItems.id,
      flowTitle: contentItems.title,
      position: flowSteps.position,
      stepCount: flowDetails.stepCount,
    })
    .from(flowSteps)
    .innerJoin(contentItems, eq(contentItems.id, flowSteps.flowId))
    .innerJoin(flowDetails, eq(flowDetails.contentItemId, flowSteps.flowId))
    .where(eq(flowSteps.contentItemId, contentItemId))
    .orderBy(asc(contentItems.title));

  return { ...row, flows };
}

// --- Live sessions --------------------------------------------------------

export async function getSession(db: Db, sessionId: string) {
  const [row] = await db
    .select({
      id: captureSessions.id,
      status: captureSessions.status,
      targetUrl: captureSessions.targetUrl,
      currentUrl: captureSessions.currentUrl,
      currentTitle: captureSessions.currentTitle,
      deviceProfile: captureSessions.deviceProfile,
      deviceClass: captureSessions.deviceClass,
      viewportWidth: captureSessions.viewportWidth,
      viewportHeight: captureSessions.viewportHeight,
      deviceScaleFactor: captureSessions.deviceScaleFactor,
      sourceId: captureSessions.sourceId,
      sourceName: sources.name,
      sourceSite: sources.site,
      discoveredPageId: captureSessions.discoveredPageId,
      flowId: captureSessions.flowId,
      defaultTermIds: captureSessions.defaultTermIds,
      frameSeq: captureSessions.frameSeq,
      frameWidth: captureSessions.frameWidth,
      frameHeight: captureSessions.frameHeight,
      frameAt: captureSessions.frameAt,
      screensCaptured: captureSessions.screensCaptured,
      workerName: captureSessions.workerName,
      errorCode: captureSessions.errorCode,
      errorMessage: captureSessions.errorMessage,
      createdBy: captureSessions.createdBy,
      startedAt: captureSessions.startedAt,
      expiresAt: captureSessions.expiresAt,
      createdAt: captureSessions.createdAt,
    })
    .from(captureSessions)
    .leftJoin(sources, eq(sources.id, captureSessions.sourceId))
    .where(eq(captureSessions.id, sessionId))
    .limit(1);

  return row ?? null;
}

/**
 * The frame alone.
 *
 * Its own query because it is fetched about once a second while the studio is
 * open and is two orders of magnitude larger than the rest of the row —
 * selecting it alongside the session's metadata would mean shipping a JPEG
 * every time the page wants to know the status.
 */
export async function getSessionFrame(db: Db, sessionId: string) {
  const [row] = await db
    .select({
      frame: captureSessions.frame,
      frameSeq: captureSessions.frameSeq,
      frameWidth: captureSessions.frameWidth,
      frameHeight: captureSessions.frameHeight,
      frameAt: captureSessions.frameAt,
      status: captureSessions.status,
      screensCaptured: captureSessions.screensCaptured,
    })
    .from(captureSessions)
    .where(eq(captureSessions.id, sessionId))
    .limit(1);

  return row ?? null;
}

/** Recent commands, for the studio's activity strip and for debugging. */
export async function listSessionCommands(db: Db, sessionId: string, limit = 20) {
  return db
    .select({
      id: captureSessionCommands.id,
      seq: captureSessionCommands.seq,
      type: captureSessionCommands.type,
      status: captureSessionCommands.status,
      errorMessage: captureSessionCommands.errorMessage,
      result: captureSessionCommands.result,
      createdAt: captureSessionCommands.createdAt,
      finishedAt: captureSessionCommands.finishedAt,
    })
    .from(captureSessionCommands)
    .where(eq(captureSessionCommands.sessionId, sessionId))
    .orderBy(desc(captureSessionCommands.seq))
    .limit(limit);
}

/** Sessions this operator has open, for the "you left a browser running" strip. */
export async function listActiveSessions(db: Db, userId: string) {
  return db
    .select({
      id: captureSessions.id,
      status: captureSessions.status,
      targetUrl: captureSessions.targetUrl,
      currentUrl: captureSessions.currentUrl,
      deviceProfile: captureSessions.deviceProfile,
      screensCaptured: captureSessions.screensCaptured,
      startedAt: captureSessions.startedAt,
      createdAt: captureSessions.createdAt,
      flowId: captureSessions.flowId,
    })
    .from(captureSessions)
    .where(
      and(
        eq(captureSessions.createdBy, userId),
        inArray(captureSessions.status, ["pending", "starting", "live"]),
      ),
    )
    .orderBy(desc(captureSessions.createdAt))
    .limit(10);
}
