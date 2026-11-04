/**
 * Capture intake (§10, §11, §12, §14, §23).
 *
 * Takes what a worker reports about one URL and turns it into durable records.
 * This is where the pipeline's two hardest requirements are actually satisfied,
 * and both come down to the same decision:
 *
 * §11 — do not create duplicates. A re-crawl of a page we already have does
 * NOT create a second content record. `page_details.normalized_url_hash` is
 * unique, so the existing record is found and reused.
 *
 * §12 — record versions instead. Every capture attempt inserts a `captures`
 * row against that stable content record, with its own hashes, timestamp,
 * viewport and browser version. So the content record is the page's identity
 * and the capture rows are its history, and "view capture history" is one
 * indexed query rather than a diff of duplicated rows.
 *
 * Change detection compares the new capture's hashes against the previous
 * successful one and stores a `changed` flag plus a plain-English summary, so
 * the dashboard's "what changed recently" is an index scan and a reviewer can
 * see whether the copy moved, the layout moved, or neither.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type Db,
  appendJobEvent,
  captures,
  classificationSuggestions,
  contentItems,
  crawlJobs,
  mediaAssets,
  pageDetails,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
  urlRegistry,
} from "@uxd/database";
import { summariseChange } from "@uxd/crawler";
import {
  AppError,
  ErrorCode,
  dedupeSlug,
  sanitizeText,
  slugify,
  uuidv7,
  validateUrl,
} from "@uxd/shared";
import {
  type CaptureMethod,
  type CaptureStatus,
  type ContentKind,
  type DeviceClass,
  type LifecycleStatus,
  type MediaUsageRole,
  type Platform,
  DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
  deriveSourceHealth,
  nextScheduledCapture,
  statusAfterRecapture,
  taxonomyKindsForContentKind,
} from "@uxd/types";
import { recordAudit } from "../audit.js";
import { type BaseContext, inTransaction } from "../context.js";
import { attachMedia } from "./media-intake.js";
import { resolveSourceForUrl } from "./ingestion.js";
import { sendToReview } from "./publishing.js";

/** What the worker reports for one completed item. */
export interface CaptureReport {
  readonly jobId: string | null;
  readonly jobItemId: string | null;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly httpStatus: number | null;
  readonly redirectChain: readonly { readonly status: number; readonly url: string }[];
  readonly method: CaptureMethod;
  readonly captureLevel: number;
  readonly status: CaptureStatus;

  readonly pageTitle: string | null;
  readonly pageDescription: string | null;
  readonly ogTitle: string | null;
  readonly ogType: string | null;
  readonly canonicalUrl: string | null;
  readonly langAttr: string | null;
  readonly h1: string | null;
  readonly headings: readonly string[];
  readonly wordCount: number | null;

  readonly contentHash: string | null;
  readonly layoutHash: string | null;
  readonly domHash: string | null;

  readonly pageWidth: number | null;
  readonly pageHeight: number | null;
  readonly viewportWidth: number | null;
  readonly viewportHeight: number | null;
  readonly deviceProfile: string | null;
  readonly deviceClass: DeviceClass | null;
  readonly deviceScaleFactor: number | null;
  readonly fullPage: boolean;
  readonly browserName: string | null;
  readonly browserVersion: string | null;
  readonly userAgent: string | null;
  readonly workerName: string | null;

  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly loadTimeMs: number | null;
  readonly resourceCount: number | null;
  readonly bytesTransferred: number | null;

  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly browserErrors: readonly string[];

  /** Media already uploaded via /api/internal/media, by role. */
  readonly media: readonly { readonly mediaId: string; readonly role: MediaUsageRole }[];

  /** Structural signals for the classifier. */
  readonly signals: Record<string, unknown>;

  /** Links found on the page, for discovery. Already guarded by the worker. */
  readonly discoveredUrls: readonly string[];

  readonly depth: number;
  readonly contentKind: ContentKind;
  readonly platform: Platform | null;
}

export interface CaptureIntakeResult {
  readonly captureId: string;
  readonly contentItemId: string;
  readonly sourceId: string;
  /** True when an existing content record was reused rather than created. */
  readonly reusedContent: boolean;
  readonly versionNumber: number;
  readonly changed: boolean | null;
  readonly changeSummary: string;
  readonly classificationCount: number;
  readonly sentToReview: boolean;
  readonly duplicate: boolean;
}

/**
 * Record a capture.
 *
 * Runs in one transaction: the capture row, the content record, the URL
 * registry entry, the media attachments, the source health update and the audit
 * row either all land or none do. A capture that half-committed would leave a
 * screenshot with no provenance, which §10 exists to prevent.
 */
export async function intakeCapture(
  context: BaseContext & { readonly workerName?: string },
  report: CaptureReport,
): Promise<CaptureIntakeResult> {
  const parsed = validateUrl(report.finalUrl || report.requestedUrl, { assumeHttps: true });
  if (!parsed.ok) {
    throw new AppError(ErrorCode.URL_INVALID, "The reported capture URL is not valid.", {
      detail: parsed.error.message,
    });
  }
  const url = parsed.value;

  return inTransaction(context, async (tx) => {
    const db = tx.db;

    // --- 1. Source (§3) -------------------------------------------------
    const source = await resolveSourceForUrl(db, url, { module: "web" });

    // --- 2. Existing content for this URL (§11) -------------------------
    const requestedHash =
      validateUrl(report.requestedUrl, { assumeHttps: true }).ok
        ? validateUrl(report.requestedUrl, { assumeHttps: true })
        : null;
    const requestedUrlHash =
      requestedHash && requestedHash.ok ? requestedHash.value.hash : url.hash;

    // Look up by the *requested* URL first (that is what the queue item was
    // for), then by the final URL. A page that started redirecting should
    // attach to its existing record rather than fork a new one.
    const existing = await findContentForUrl(db, [requestedUrlHash, url.hash]);

    const now = new Date();
    const startedAt = report.startedAt ? new Date(report.startedAt) : now;
    const finishedAt = report.finishedAt ? new Date(report.finishedAt) : now;

    // --- 3. Previous capture, for change detection (§12) ----------------
    const previous = existing
      ? (
          await db
            .select({
              id: captures.id,
              contentHash: captures.contentHash,
              layoutHash: captures.layoutHash,
              pageTitle: captures.pageTitle,
            })
            .from(captures)
            .where(and(eq(captures.contentItemId, existing.id), eq(captures.status, "succeeded")))
            .orderBy(desc(captures.createdAt))
            .limit(1)
        )[0] ?? null
      : null;

    const change = summariseChange(previous, {
      contentHash: report.contentHash,
      layoutHash: report.layoutHash,
      pageTitle: report.pageTitle,
    });

    // An unchanged re-capture is the §11 "duplicate" case: it still records a
    // capture (so history shows we looked and nothing had moved) but does not
    // bump the content version or re-open review.
    const isUnchangedRecapture = previous !== null && !change.changed && report.status === "succeeded";

    // --- 4. Content record ----------------------------------------------
    const title =
      sanitizeText(report.pageTitle ?? report.ogTitle ?? report.h1, { maxLength: 300 }) ??
      `${url.host}${url.path === "/" ? "" : url.path}`;

    let contentItemId: string;
    let versionNumber: number;
    let reusedContent: boolean;

    if (existing) {
      contentItemId = existing.id;
      reusedContent = true;
      versionNumber = isUnchangedRecapture ? existing.version : existing.version + 1;

      await db
        .update(contentItems)
        .set({
          // A capture may only advance a record still in a pre-review pipeline
          // state. Anything a person owns — in the review queue, approved,
          // published, rejected, under a rights hold — keeps its status, so a
          // nightly refresh can neither take content off the public site nor
          // silently empty the review queue.
          status: statusAfterRecapture(
            existing.status as LifecycleStatus,
            report.status === "succeeded",
          ),
          version: versionNumber,
          contentHash: report.contentHash,
          layoutHash: report.layoutHash,
          capturedAt: finishedAt,
          sourceUrl: url.normalized,
          // Only overwrite a title if a human has not curated one.
          title: existing.titleWasCurated ? existing.title : title,
          description: existing.descriptionWasCurated
            ? existing.description
            : sanitizeText(report.pageDescription, { maxLength: 2_000 }),
          platform: report.platform ?? existing.platform,
          deviceClass: report.deviceClass ?? existing.deviceClass,
          updatedAt: now,
        })
        .where(eq(contentItems.id, contentItemId));
    } else {
      contentItemId = uuidv7();
      reusedContent = false;
      versionNumber = 1;

      const taken = await existingSlugs(db, report.contentKind, slugify(title));
      const slug = dedupeSlug(slugify(title), taken);

      await db.insert(contentItems).values({
        id: contentItemId,
        module: "web",
        kind: report.contentKind,
        status: report.status === "succeeded" ? "processed" : "failed",
        sourceId: source.sourceId,
        title,
        slug,
        description: sanitizeText(report.pageDescription, { maxLength: 2_000 }),
        sourceUrl: url.normalized,
        platform: report.platform ?? "web",
        deviceClass: report.deviceClass,
        contentHash: report.contentHash,
        layoutHash: report.layoutHash,
        capturedAt: finishedAt,
        version: 1,
      });

      // Recomputed rather than incremented, for the same reason
      // `recomputeTermUsage` is: a counter is only as correct as its least
      // diligent maintainer, and this one had exactly one — this line. There
      // is no content-delete path today, so nothing has gone wrong yet, but
      // `content_items.deleted_at` exists and is only ever read, which says a
      // delete path is expected. When it arrives, an increment here would
      // leave every source over-reporting for ever, and the number is shown
      // in the CMS sources list where nobody would think to doubt it.
      //
      // The identical mistake was live on `taxonomy_terms.usage_count`: one
      // maintainer on the review path, none on the path that created
      // suggestions, and 20 of 224 terms reporting a usage they did not have.
      await db.update(sources)
        .set({
          contentCount: sql`(
            select count(*)::int from ${contentItems} ci
            where ci.source_id = ${sources}.id and ci.deleted_at is null
          )`,
        })
        .where(eq(sources.id, source.sourceId));
    }

    // --- 5. Capture row (§12: the version record) -----------------------
    const captureId = uuidv7();
    await db.insert(captures).values({
      id: captureId,
      sourceId: source.sourceId,
      contentItemId,
      crawlJobId: report.jobId,
      crawlJobItemId: report.jobItemId,
      method: report.method,
      captureLevel: report.captureLevel,
      status: report.status,
      requestedUrl: report.requestedUrl.slice(0, 2_048),
      finalUrl: url.normalized,
      httpStatus: report.httpStatus,
      redirectChain: [...report.redirectChain],
      viewportWidth: report.viewportWidth,
      viewportHeight: report.viewportHeight,
      deviceScaleFactor: report.deviceScaleFactor,
      deviceProfile: report.deviceProfile,
      deviceClass: report.deviceClass,
      fullPage: report.fullPage,
      browserName: report.browserName,
      browserVersion: report.browserVersion,
      userAgent: report.userAgent,
      workerName: report.workerName ?? context.workerName ?? null,
      pageTitle: sanitizeText(report.pageTitle, { maxLength: 500 }),
      pageDescription: sanitizeText(report.pageDescription, { maxLength: 2_000 }),
      pageWidth: report.pageWidth,
      pageHeight: report.pageHeight,
      contentHash: report.contentHash,
      layoutHash: report.layoutHash,
      domHash: report.domHash,
      changed: previous ? change.changed : null,
      changedFromCaptureId: previous?.id ?? null,
      changeSummary: {
        description: change.description,
        contentChanged: change.contentChanged,
        layoutChanged: change.layoutChanged,
        titleChanged: change.titleChanged,
      },
      startedAt,
      finishedAt,
      durationMs: report.durationMs,
      loadTimeMs: report.loadTimeMs,
      resourceCount: report.resourceCount,
      bytesTransferred: report.bytesTransferred,
      screenshotCount: report.media.filter((m) => m.role.startsWith("screenshot")).length,
      mediaCount: report.media.length,
      errorCode: report.errorCode,
      errorMessage: sanitizeText(report.errorMessage, { maxLength: 2_000 }),
      warnings: [...report.warnings],
      browserErrors: [...report.browserErrors],
      metadata: {
        headings: report.headings.slice(0, 25),
        langAttr: report.langAttr,
        ogType: report.ogType,
        canonicalUrl: report.canonicalUrl,
        signals: report.signals,
        depth: report.depth,
      },
    });

    await db
      .update(contentItems)
      .set({ latestCaptureId: captureId })
      .where(eq(contentItems.id, contentItemId));

    // --- 6. Page detail --------------------------------------------------
    const canonical = report.canonicalUrl
      ? validateUrl(report.canonicalUrl, { assumeHttps: true })
      : null;

    await db
      .insert(pageDetails)
      .values({
        contentItemId,
        url: report.requestedUrl.slice(0, 2_048),
        normalizedUrl: url.normalized,
        normalizedUrlHash: requestedUrlHash,
        finalUrl: url.normalized,
        finalUrlHash: url.hash,
        canonicalUrl: canonical?.ok ? canonical.value.normalized : null,
        canonicalUrlHash: canonical?.ok ? canonical.value.hash : null,
        httpStatus: report.httpStatus,
        pageTitle: sanitizeText(report.pageTitle, { maxLength: 500 }),
        metaDescription: sanitizeText(report.pageDescription, { maxLength: 2_000 }),
        ogTitle: sanitizeText(report.ogTitle, { maxLength: 500 }),
        ogType: sanitizeText(report.ogType, { maxLength: 100 }),
        langAttr: sanitizeText(report.langAttr, { maxLength: 20 }),
        h1: sanitizeText(report.h1, { maxLength: 300 }),
        wordCount: report.wordCount,
        pageWidth: report.pageWidth,
        pageHeight: report.pageHeight,
        viewportWidth: report.viewportWidth,
        viewportHeight: report.viewportHeight,
        depth: report.depth,
      })
      .onConflictDoUpdate({
        target: pageDetails.contentItemId,
        set: {
          finalUrl: url.normalized,
          finalUrlHash: url.hash,
          httpStatus: report.httpStatus,
          pageTitle: sanitizeText(report.pageTitle, { maxLength: 500 }),
          metaDescription: sanitizeText(report.pageDescription, { maxLength: 2_000 }),
          h1: sanitizeText(report.h1, { maxLength: 300 }),
          wordCount: report.wordCount,
          pageWidth: report.pageWidth,
          pageHeight: report.pageHeight,
        },
      });

    // --- 7. Media attachment and provenance backfill --------------------
    let primaryMediaId: string | null = null;
    for (const [index, item] of report.media.entries()) {
      await attachMedia(db, {
        mediaId: item.mediaId,
        contentItemId,
        role: item.role,
        position: index,
      });
      // The worker uploaded these before the capture row existed, so link them
      // back now that it does — this is what makes "which capture produced this
      // screenshot?" answerable (§10).
      await db
        .update(mediaAssets)
        .set({
          captureId,
          parentContentId: contentItemId,
          sourceId: source.sourceId,
          crawlJobId: report.jobId,
          capturedAt: finishedAt,
        })
        .where(eq(mediaAssets.id, item.mediaId));

      const isDesktopFullPage = item.role === "screenshot_full_page" || item.role === "screenshot_desktop";
      if (primaryMediaId === null && isDesktopFullPage) primaryMediaId = item.mediaId;
    }
    primaryMediaId ??= report.media[0]?.mediaId ?? null;

    // The worker uploads media before the source is resolved, so
    // `ingestMedia` could not increment this. Recount rather than add: the
    // same file may serve several roles after deduplication, and an
    // incrementing counter would double-count it.
    if (report.media.length > 0) {
      await db
        .update(sources)
        .set({
          mediaCount: sql`(select count(*)::int from ${mediaAssets} where ${mediaAssets.sourceId} = ${source.sourceId} and ${mediaAssets.deletedAt} is null)`,
        })
        .where(eq(sources.id, source.sourceId));
    }

    if (primaryMediaId) {
      await db
        .update(contentItems)
        .set({ primaryMediaId })
        .where(and(eq(contentItems.id, contentItemId), isNull(contentItems.primaryMediaId)));
    }

    // --- 8. URL registry (§11) -------------------------------------------
    await db
      .insert(urlRegistry)
      .values({
        normalizedUrlHash: requestedUrlHash,
        normalizedUrl: url.normalized,
        host: url.host,
        registrableDomain: url.registrableDomain,
        resolvedUrlHash: url.hash !== requestedUrlHash ? url.hash : null,
        canonicalUrlHash: canonical?.ok ? canonical.value.hash : null,
        sourceId: source.sourceId,
        contentItemId,
        lastCapturedAt: finishedAt,
        captureCount: 1,
        lastHttpStatus: report.httpStatus,
        failureCount: report.status === "failed" ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: urlRegistry.normalizedUrlHash,
        set: {
          lastSeenAt: now,
          lastCapturedAt: finishedAt,
          captureCount: sql`${urlRegistry.captureCount} + 1`,
          contentItemId,
          sourceId: source.sourceId,
          lastHttpStatus: report.httpStatus,
          failureCount:
            report.status === "failed"
              ? sql`${urlRegistry.failureCount} + 1`
              : sql`0`,
        },
      });

    // --- 9. Source health (§17) ------------------------------------------
    await updateSourceHealth(db, source.sourceId, {
      succeeded: report.status === "succeeded",
      httpStatus: report.httpStatus,
      loadTimeMs: report.loadTimeMs,
      changed: change.changed,
      errorCode: report.errorCode,
      errorMessage: report.errorMessage,
      at: finishedAt,
    });

    // --- 10. Job counters and log ----------------------------------------
    if (report.jobId) {
      await db
        .update(crawlJobs)
        .set({
          screenshotCount: sql`${crawlJobs.screenshotCount} + ${report.media.filter((m) => m.role.startsWith("screenshot")).length}`,
          mediaCount: sql`${crawlJobs.mediaCount} + ${report.media.length}`,
          contentCreatedCount: reusedContent
            ? crawlJobs.contentCreatedCount
            : sql`${crawlJobs.contentCreatedCount} + 1`,
          discoveredCount: sql`${crawlJobs.discoveredCount} + ${report.discoveredUrls.length}`,
          updatedAt: now,
        })
        .where(eq(crawlJobs.id, report.jobId));

      await appendJobEvent(db, {
        jobId: report.jobId,
        itemId: report.jobItemId,
        level: "info",
        code: reusedContent ? (isUnchangedRecapture ? "item_duplicate" : "version_created") : "content_created",
        message: isUnchangedRecapture ? "Captured again; nothing had changed." : change.description,
        data: {
          contentItemId,
          captureId,
          version: versionNumber,
          changed: change.changed,
          media: report.media.length,
        },
      });
    }

    await recordAudit(db, context, {
      action: reusedContent ? "content.version_created" : "content.created",
      entityType: "content",
      entityId: contentItemId,
      entityLabel: title,
      context: {
        captureId,
        version: versionNumber,
        url: url.normalized,
        changed: change.changed,
      },
    });

    return {
      captureId,
      contentItemId,
      sourceId: source.sourceId,
      reusedContent,
      versionNumber,
      changed: previous ? change.changed : null,
      changeSummary: change.description,
      classificationCount: 0,
      sentToReview: false,
      duplicate: isUnchangedRecapture,
    };
  });
}

interface ExistingContent {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly platform: Platform | null;
  readonly deviceClass: DeviceClass | null;
  /** True when a person has edited the title, so a re-capture must not
   * overwrite their wording with the page's current <title>. */
  readonly titleWasCurated: boolean;
  readonly descriptionWasCurated: boolean;
}

async function findContentForUrl(
  db: Db,
  urlHashes: readonly string[],
): Promise<ExistingContent | null> {
  for (const hash of [...new Set(urlHashes)]) {
    const [row] = await db
      .select({
        id: contentItems.id,
        version: contentItems.version,
        status: contentItems.status,
        title: contentItems.title,
        description: contentItems.description,
        platform: contentItems.platform,
        deviceClass: contentItems.deviceClass,
        updatedBy: contentItems.updatedBy,
        reviewedAt: contentItems.reviewedAt,
      })
      .from(pageDetails)
      .innerJoin(contentItems, eq(contentItems.id, pageDetails.contentItemId))
      .where(and(eq(pageDetails.normalizedUrlHash, hash), isNull(contentItems.deletedAt)))
      .limit(1);

    if (row) {
      // "Curated" means a person has touched the record — they edited it, or
      // they reviewed it. Either way their wording wins over the page's.
      const curated = row.updatedBy !== null || row.reviewedAt !== null;
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        title: row.title,
        description: row.description,
        platform: row.platform,
        deviceClass: row.deviceClass,
        titleWasCurated: curated,
        descriptionWasCurated: curated,
      };
    }
  }
  return null;
}

async function existingSlugs(db: Db, kind: ContentKind, base: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: contentItems.slug })
    .from(contentItems)
    .where(and(eq(contentItems.kind, kind), sql`${contentItems.slug} like ${`${base}%`}`))
    .limit(200);
  return new Set(rows.map((r) => r.slug).filter((s): s is string => s !== null));
}

/**
 * Recompute a source's health from this capture's outcome (§17).
 *
 * Derived rather than set by hand, so the "needs recapture" worklist is always
 * accurate rather than as-remembered.
 */
async function updateSourceHealth(
  db: Db,
  sourceId: string,
  outcome: {
    readonly succeeded: boolean;
    readonly httpStatus: number | null;
    readonly loadTimeMs: number | null;
    readonly changed: boolean;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly at: Date;
  },
): Promise<void> {
  const [current] = await db
    .select({
      id: sources.id,
      health: sources.health,
      consecutiveFailures: sources.consecutiveFailures,
      firstCapturedAt: sources.firstCapturedAt,
      lastSuccessfulCaptureAt: sources.lastSuccessfulCaptureAt,
      lastChangedAt: sources.lastChangedAt,
      captureIntervalDays: sources.captureIntervalDays,
      robotsStatus: sources.robotsStatus,
    })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  if (!current) return;

  const consecutiveFailures = outcome.succeeded ? 0 : current.consecutiveFailures + 1;
  const lastSuccessfulCaptureAt = outcome.succeeded ? outcome.at : current.lastSuccessfulCaptureAt;
  const lastChangedAt = outcome.changed ? outcome.at : current.lastChangedAt;

  const health = deriveSourceHealth({
    current: current.health,
    consecutiveFailures,
    lastResponseStatus: outcome.httpStatus,
    lastCapturedAt: outcome.at,
    lastSuccessfulCaptureAt,
    captureIntervalDays: current.captureIntervalDays,
    lastChangedAt,
    robotsDisallowed: current.robotsStatus === "disallowed",
    canonicalRedirected: false,
    now: outcome.at,
  });

  await db
    .update(sources)
    .set({
      health,
      firstCapturedAt: current.firstCapturedAt ?? outcome.at,
      lastCapturedAt: outcome.at,
      lastSuccessfulCaptureAt,
      lastChangedAt,
      consecutiveFailures,
      lastResponseStatus: outcome.httpStatus,
      lastLoadTimeMs: outcome.loadTimeMs,
      lastErrorCode: outcome.succeeded ? null : outcome.errorCode,
      lastErrorMessage: outcome.succeeded
        ? null
        : sanitizeText(outcome.errorMessage, { maxLength: 1_000 }),
      captureCount: sql`${sources.captureCount} + 1`,
      nextScheduledCaptureAt: nextScheduledCapture(lastSuccessfulCaptureAt, current.captureIntervalDays),
      updatedAt: new Date(),
    })
    .where(eq(sources.id, sourceId));
}

/**
 * Attach classification suggestions and route the record to review (§14, §23).
 *
 * Deliberately a separate step from `intakeCapture`, outside its transaction:
 * classification may call a model over the network, and holding a database
 * transaction open across an API call is a good way to exhaust the connection
 * pool. A failure here leaves a captured, stored, provenanced record that a
 * human can still review — just without suggestions.
 */
export async function classifyAndQueueForReview(
  context: BaseContext,
  input: {
    readonly contentItemId: string;
    readonly jobId: string | null;
    readonly autoClassify: boolean;
    readonly sendToReviewQueue: boolean;
    readonly signals: Record<string, unknown>;
    readonly isUnchangedRecapture: boolean;
  },
): Promise<{ classificationCount: number; sentToReview: boolean; error: string | null }> {
  let classificationCount = 0;
  let error: string | null = null;

  if (input.autoClassify) {
    try {
      classificationCount = await runClassification(context, input.contentItemId, input.signals);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "classification failed";
      context.logger.warn("Classification step failed", { contentItemId: input.contentItemId, error });
      if (input.jobId) {
        await appendJobEvent(context.db, {
          jobId: input.jobId,
          level: "warn",
          code: "classification_skipped",
          message: "Classification did not run for this capture; it can be requested again from the CMS.",
          data: { contentItemId: input.contentItemId },
        });
      }
    }
  }

  let sentToReview = false;
  // An unchanged re-capture does not re-open review: a reviewer already
  // approved this exact content, and asking them to look again because a
  // nightly refresh ran is exactly the friction §40 is about.
  if (input.sendToReviewQueue && !input.isUnchangedRecapture) {
    await sendToReview(
      context.db,
      input.contentItemId,
      input.isUnchangedRecapture ? "recapture_changed" : "new_capture",
    );
    sentToReview = true;
  }

  return { classificationCount, sentToReview, error };
}

async function runClassification(
  context: BaseContext,
  contentItemId: string,
  signals: Record<string, unknown>,
): Promise<number> {
  const [content] = await context.db
    .select({
      id: contentItems.id,
      kind: contentItems.kind,
      title: contentItems.title,
      description: contentItems.description,
      sourceUrl: contentItems.sourceUrl,
      originalCompany: contentItems.originalCompany,
      sourceId: contentItems.sourceId,
    })
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .limit(1);
  if (!content) return 0;

  // Only offer the model vocabularies relevant to this content kind.
  const relevantKinds = taxonomyKindsForContentKind(content.kind);
  if (relevantKinds.length === 0) return 0;

  const terms = await context.db
    .select({
      id: taxonomyTerms.id,
      kind: taxonomyTerms.kind,
      name: taxonomyTerms.name,
      slug: taxonomyTerms.slug,
      path: taxonomyTerms.path,
      aliases: taxonomyTerms.aliases,
      description: taxonomyTerms.description,
    })
    .from(taxonomyTerms)
    .where(
      and(
        eq(taxonomyTerms.status, "active"),
        sql`${taxonomyTerms.kind}::text in ${relevantKinds}`,
      ),
    )
    .limit(1_000);

  if (terms.length === 0) return 0;

  const { TAXONOMY_KIND_META } = await import("@uxd/types");
  const vocabulary = relevantKinds
    .map((kind) => ({
      kind,
      singleValue: TAXONOMY_KIND_META[kind].singleValue,
      terms: terms.filter((t) => t.kind === kind),
    }))
    .filter((v) => v.terms.length > 0);

  const [detail] = await context.db
    .select({ h1: pageDetails.h1, wordCount: pageDetails.wordCount })
    .from(pageDetails)
    .where(eq(pageDetails.contentItemId, contentItemId))
    .limit(1);

  const [source] = content.sourceId
    ? await context.db
        .select({ companyName: sources.companyName, domain: sources.domain })
        .from(sources)
        .where(eq(sources.id, content.sourceId))
        .limit(1)
    : [undefined];

  const result = await context.classifier.classify({
    contentKind: content.kind,
    url: content.sourceUrl,
    title: content.title,
    description: content.description,
    h1: detail?.h1 ?? null,
    headings: [],
    signals,
    wordCount: detail?.wordCount ?? 0,
    companyName: source?.companyName ?? content.originalCompany ?? null,
    domain: source?.domain ?? null,
    vocabulary,
  });

  if (result.suggestions.length === 0 && result.fieldSuggestions.length === 0) return 0;

  const now = new Date();
  let written = 0;

  for (const suggestion of result.suggestions) {
    // Every suggestion lands as pending. Nothing is applied automatically,
    // regardless of confidence — the floor exists so that even a future
    // auto-apply feature cannot act on a low-confidence guess (§14).
    await context.db
      .insert(taxonomyAssignments)
      .values({
        id: uuidv7(),
        termId: suggestion.termId,
        target: "content",
        contentItemId,
        origin: "ai_suggested",
        confidence: suggestion.confidence,
        model: result.model,
        promptVersion: result.promptVersion,
        suggestedAt: now,
        reviewStatus: "pending",
        note: suggestion.rationale,
        isPrimary: false,
      })
      .onConflictDoNothing();
    written += 1;
  }

  for (const field of result.fieldSuggestions) {
    await context.db
      .insert(classificationSuggestions)
      .values({
        id: uuidv7(),
        target: "content",
        contentItemId,
        field: field.field,
        suggestedValue: field.value,
        confidence: field.confidence,
        rationale: field.rationale,
        model: result.model ?? result.provider,
        promptVersion: result.promptVersion,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        reviewStatus: "pending",
      })
      .onConflictDoNothing();
  }

  const lowestConfidence = result.suggestions.reduce(
    (min, s) => Math.min(min, s.confidence),
    1,
  );

  await context.db
    .update(contentItems)
    .set({
      // Only a freshly `processed` record advances to `ai_classified`. One
      // already in review, approved or published keeps its status: attaching a
      // suggestion is not a pipeline transition.
      status: sql`case when ${contentItems.status} = 'processed' then 'ai_classified'::lifecycle_status else ${contentItems.status} end`,
      aiClassifiedAt: now,
      classificationModel: result.model ?? result.provider,
      classificationConfidence: result.suggestions.length > 0 ? lowestConfidence : null,
      updatedAt: now,
    })
    .where(eq(contentItems.id, contentItemId));

  return written;
}

/** Confidence floor, exposed so the CMS can explain why nothing auto-applied. */
export const AUTO_APPLY_FLOOR = DEFAULT_MIN_AUTO_APPLY_CONFIDENCE;
