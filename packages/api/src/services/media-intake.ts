/**
 * Media intake (§9, §10, §11).
 *
 * The single path by which bytes enter the media library, whether they came
 * from an operator's upload or from the capture worker. Having one path means
 * validation, hashing, deduplication, derivative generation and provenance
 * recording cannot be skipped by whichever caller happens to be easier.
 *
 * Order of operations:
 *
 *   1. Validate (`validateMedia`) — sniffed type against the allowlist, size,
 *      decodability. A rejected file is stored nowhere.
 *   2. Exact dedupe on sha256. An identical file already in the library is
 *      *reused*: the existing row is returned and a new usage is recorded. This
 *      is what stops a nightly re-crawl from accumulating thousands of
 *      byte-identical screenshots (§11).
 *   3. Store the bytes, then generate derivatives.
 *   4. Record provenance (§10) on the row: source URL, origin domain, parent
 *      content, crawl job, capture, viewport, browser, device profile.
 *   5. Perceptual hash, and a near-duplicate lookup that *flags* rather than
 *      discards.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  type Db,
  mediaAssets,
  mediaDerivatives,
  mediaUsages,
  sources,
} from "@uxd/database";
import {
  NEAR_DUPLICATE_THRESHOLD,
  buildStorageKey,
  dispositionFor,
  dominantColor,
  generateDerivatives,
  hammingDistance,
  perceptualHash,
  validateMedia,
} from "@uxd/media";
import { AppError, ErrorCode, type Logger, sanitizeText, uuidv7 } from "@uxd/shared";
import {
  type CaptureMethod,
  type DeviceClass,
  type MediaUploadSource,
  type MediaUsageRole,
  type ScreenshotScope,
  mediaKindFor,
} from "@uxd/types";
import { recordAudit } from "../audit.js";
import type { AnyContext, BaseContext } from "../context.js";

/** Provenance recorded on every stored asset (§10). */
export interface MediaProvenance {
  readonly sourceUrl?: string | null;
  readonly originDomain?: string | null;
  readonly sourceId?: string | null;
  readonly parentContentId?: string | null;
  readonly crawlJobId?: string | null;
  readonly captureId?: string | null;
  readonly captureMethod?: CaptureMethod;
  readonly uploadSource?: MediaUploadSource;
  readonly capturedAt?: Date | null;
  readonly viewportWidth?: number | null;
  readonly viewportHeight?: number | null;
  readonly deviceScaleFactor?: number | null;
  readonly deviceProfile?: string | null;
  readonly deviceClass?: DeviceClass | null;
  readonly browserName?: string | null;
  readonly browserVersion?: string | null;
  readonly screenshotScope?: ScreenshotScope | null;
}

export interface IngestMediaInput {
  readonly bytes: Uint8Array;
  readonly originalFilename?: string | null;
  readonly altText?: string | null;
  readonly caption?: string | null;
  readonly title?: string | null;
  readonly internalNotes?: string | null;
  readonly provenance?: MediaProvenance;
  /** Permit types the pipeline produces but operators cannot upload. */
  readonly allowCaptureOnlyTypes?: boolean;
  readonly maxBytes?: number;
  /** The user who uploaded it. Null for worker captures, which have no user. */
  readonly uploadedBy?: string | null;
}

export interface IngestMediaResult {
  readonly mediaId: string;
  /** True when an identical file already existed and was reused. */
  readonly deduplicated: boolean;
  readonly sha256: string;
  readonly perceptualHash: string | null;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly mimeType: string;
  readonly derivativeCount: number;
  /** Visually similar assets, for the reviewer's duplicate check. */
  readonly nearDuplicates: readonly { readonly mediaId: string; readonly distance: number }[];
}

/**
 * Store a file and record it in the library.
 *
 * Throws `MEDIA_REJECTED` with an operator-readable reason if validation fails.
 * The bytes are never written to storage before validation passes, so a
 * rejected upload leaves nothing behind to clean up.
 */
export async function ingestMedia(
  context: BaseContext,
  input: IngestMediaInput,
): Promise<IngestMediaResult> {
  const validation = await validateMedia(input.bytes, {
    filename: input.originalFilename,
    maxBytes: input.maxBytes ?? context.env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024,
    allowCaptureOnlyTypes: input.allowCaptureOnlyTypes ?? false,
    logger: context.logger,
  });

  if (!validation.ok) {
    throw new AppError(ErrorCode.MEDIA_REJECTED, validation.rejection.message, {
      detail: validation.rejection.detail,
      context: { reason: validation.rejection.reason, filename: input.originalFilename },
    });
  }

  const media = validation.media;
  const provenance = input.provenance ?? {};

  // --- Exact dedupe -----------------------------------------------------
  const [existing] = await context.db
    .select({
      id: mediaAssets.id,
      sha256: mediaAssets.sha256,
      perceptualHash: mediaAssets.perceptualHash,
      byteSize: mediaAssets.byteSize,
      width: mediaAssets.width,
      height: mediaAssets.height,
      mimeType: mediaAssets.mimeType,
      status: mediaAssets.status,
    })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.sha256, media.sha256), isNull(mediaAssets.deletedAt)))
    .limit(1);

  if (existing) {
    // Reuse. A re-crawl that produces byte-identical output costs one row
    // lookup, not a second copy of the file.
    context.logger.debug("Reused an identical existing media asset", {
      mediaId: existing.id,
      sha256: media.sha256.slice(0, 12),
    });

    // Re-archived assets come back into use if something references them again.
    if (existing.status === "archived") {
      await context.db
        .update(mediaAssets)
        .set({ status: "ready", archivedAt: null, updatedAt: new Date() })
        .where(eq(mediaAssets.id, existing.id));
    }

    const derivativeCount = await countDerivatives(context.db, existing.id);
    return {
      mediaId: existing.id,
      deduplicated: true,
      sha256: existing.sha256,
      perceptualHash: existing.perceptualHash,
      byteSize: existing.byteSize,
      width: existing.width,
      height: existing.height,
      mimeType: existing.mimeType,
      derivativeCount,
      nearDuplicates: [],
    };
  }

  // --- Store ------------------------------------------------------------
  const mediaId = uuidv7();
  const storageKey = buildStorageKey({
    extension: media.extension,
    id: mediaId,
    at: provenance.capturedAt ?? new Date(),
  });

  await context.storage.put({
    key: storageKey,
    body: input.bytes,
    contentType: media.mimeType,
    contentLength: media.byteSize,
    contentDisposition: dispositionFor(media.mimeType, input.originalFilename ?? undefined),
    metadata: {
      sha256: media.sha256,
      ...(provenance.originDomain ? { origin: provenance.originDomain } : {}),
    },
  });

  // --- Perceptual hash and near-duplicate detection ---------------------
  const phash = media.kind === "image" ? await perceptualHash(input.bytes) : null;
  const nearDuplicates = phash ? await findNearDuplicates(context.db, phash, mediaId) : [];
  const colour = media.kind === "image" ? await dominantColor(input.bytes) : null;

  await context.db.insert(mediaAssets).values({
    id: mediaId,
    kind: mediaKindFor(media.mimeType),
    status: "processing",
    storageDriver: context.storage.name,
    storageBucket: context.storage.bucket,
    storageKey,
    mimeType: media.mimeType,
    originalFilename: sanitizeText(input.originalFilename, { maxLength: 300 }),
    byteSize: media.byteSize,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    hasAlpha: media.hasAlpha,
    isAnimated: media.isAnimated,
    colorProfile: media.colorProfile,
    dominantColorHex: colour,
    sha256: media.sha256,
    perceptualHash: phash,

    // Provenance (§10).
    sourceUrl: provenance.sourceUrl ?? null,
    originDomain: provenance.originDomain ?? null,
    sourceId: provenance.sourceId ?? null,
    parentContentId: provenance.parentContentId ?? null,
    crawlJobId: provenance.crawlJobId ?? null,
    captureId: provenance.captureId ?? null,
    captureMethod: provenance.captureMethod ?? "manual_upload",
    uploadSource: provenance.uploadSource ?? "manual_upload",
    capturedAt: provenance.capturedAt ?? null,
    viewportWidth: provenance.viewportWidth ?? null,
    viewportHeight: provenance.viewportHeight ?? null,
    deviceScaleFactor: provenance.deviceScaleFactor ?? null,
    deviceProfile: provenance.deviceProfile ?? null,
    deviceClass: provenance.deviceClass ?? null,
    browserName: provenance.browserName ?? null,
    browserVersion: provenance.browserVersion ?? null,
    screenshotScope: provenance.screenshotScope ?? null,

    title: sanitizeText(input.title, { maxLength: 300 }),
    altText: sanitizeText(input.altText, { maxLength: 500 }),
    caption: sanitizeText(input.caption, { maxLength: 1_000 }),
    internalNotes: sanitizeText(input.internalNotes, { maxLength: 4_000, singleLine: false }),
    scanStatus: "passed",
    metadata: media.metadata,
    uploadedBy: input.uploadedBy ?? null,
  });

  // --- Derivatives ------------------------------------------------------
  let derivativeCount = 0;
  try {
    const derivatives = await generateDerivatives(input.bytes, {
      mimeType: media.mimeType,
      width: media.width,
      height: media.height,
      logger: context.logger,
    });

    for (const derivative of derivatives) {
      const derivativeKey = buildStorageKey({
        extension: derivative.extension,
        id: mediaId,
        variant: derivative.kind,
        at: provenance.capturedAt ?? new Date(),
      });
      await context.storage.put({
        key: derivativeKey,
        body: derivative.bytes,
        contentType: derivative.mimeType,
        contentLength: derivative.byteSize,
      });
      await context.db.insert(mediaDerivatives).values({
        id: uuidv7(),
        mediaId,
        kind: derivative.kind,
        storageKey: derivativeKey,
        mimeType: derivative.mimeType,
        width: derivative.width,
        height: derivative.height,
        byteSize: derivative.byteSize,
      });
      derivativeCount += 1;
    }
  } catch (error) {
    // The original is stored and usable; a missing thumbnail is a degraded
    // grid cell, not a failed upload.
    context.logger.warn("Derivative generation failed after the original was stored", {
      mediaId,
      error,
    });
  }

  await context.db
    .update(mediaAssets)
    .set({ status: "ready", updatedAt: new Date() })
    .where(eq(mediaAssets.id, mediaId));

  if (provenance.sourceId) {
    await context.db
      .update(sources)
      .set({ mediaCount: sql`${sources.mediaCount} + 1` })
      .where(eq(sources.id, provenance.sourceId));
  }

  return {
    mediaId,
    deduplicated: false,
    sha256: media.sha256,
    perceptualHash: phash,
    byteSize: media.byteSize,
    width: media.width,
    height: media.height,
    mimeType: media.mimeType,
    derivativeCount,
    nearDuplicates,
  };
}

async function countDerivatives(db: Db, mediaId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaDerivatives)
    .where(eq(mediaDerivatives.mediaId, mediaId));
  return row?.n ?? 0;
}

/**
 * Find visually similar assets by Hamming distance.
 *
 * A dHash cannot be range-queried in SQL, so this narrows by prefix first —
 * similar images usually share leading hex characters — then computes exact
 * distances in application code over a bounded candidate set. It is a
 * heuristic pre-filter, not an exhaustive search, which is the right trade for
 * something whose only job is to raise a "possible duplicate" flag for a
 * reviewer.
 */
export async function findNearDuplicates(
  db: Db,
  phash: string,
  excludeMediaId?: string,
  threshold = NEAR_DUPLICATE_THRESHOLD,
): Promise<{ mediaId: string; distance: number }[]> {
  // Two 4-character prefixes: the leading 16 bits and the trailing 16. An
  // image whose top rows changed still matches on the tail, and vice versa.
  const headPrefix = `${phash.slice(0, 4)}%`;
  const tailSuffix = `%${phash.slice(-4)}`;

  const candidates = await db
    .select({ id: mediaAssets.id, perceptualHash: mediaAssets.perceptualHash })
    .from(mediaAssets)
    .where(
      and(
        isNull(mediaAssets.deletedAt),
        sql`${mediaAssets.perceptualHash} is not null`,
        excludeMediaId ? ne(mediaAssets.id, excludeMediaId) : undefined,
        sql`(${mediaAssets.perceptualHash} like ${headPrefix} or ${mediaAssets.perceptualHash} like ${tailSuffix})`,
      ),
    )
    .limit(500);

  return candidates
    .map((row) => ({
      mediaId: row.id,
      distance: row.perceptualHash ? hammingDistance(phash, row.perceptualHash) : Number.MAX_SAFE_INTEGER,
    }))
    .filter((row) => row.distance <= threshold)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);
}

/** Attach an asset to a content record in a given role. */
export async function attachMedia(
  db: Db,
  input: {
    readonly mediaId: string;
    readonly contentItemId: string;
    readonly role: MediaUsageRole;
    readonly position?: number;
    readonly createdBy?: string | null;
  },
): Promise<void> {
  await db
    .insert(mediaUsages)
    .values({
      mediaId: input.mediaId,
      contentItemId: input.contentItemId,
      role: input.role,
      position: input.position ?? 0,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing();

  // Recount rather than increment: the insert may have been a no-op, and a
  // usage count that drifts makes the library's "unused media" view wrong.
  await db
    .update(mediaAssets)
    .set({
      usageCount: sql`(select count(*)::int from ${mediaUsages} where ${mediaUsages.mediaId} = ${input.mediaId})`,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.id, input.mediaId));
}

export async function detachMedia(db: Db, mediaId: string, contentItemId: string): Promise<void> {
  await db
    .delete(mediaUsages)
    .where(and(eq(mediaUsages.mediaId, mediaId), eq(mediaUsages.contentItemId, contentItemId)));
  await db
    .update(mediaAssets)
    .set({
      usageCount: sql`(select count(*)::int from ${mediaUsages} where ${mediaUsages.mediaId} = ${mediaId})`,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.id, mediaId));
}

/**
 * Delete an asset's bytes, keeping its row.
 *
 * §10's provenance requirement outlives the file: "where did this screenshot
 * come from and when did we capture it" has to stay answerable for something
 * we removed, including for a takedown. So the bytes go and the row stays,
 * marked `deleted` with `bytesDeletedAt` set.
 */
export async function deleteMediaBytes(
  context: AnyContext,
  mediaId: string,
  reason: string,
): Promise<void> {
  const [row] = await context.db
    .select({
      id: mediaAssets.id,
      storageKey: mediaAssets.storageKey,
      originalFilename: mediaAssets.originalFilename,
      usageCount: mediaAssets.usageCount,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, mediaId))
    .limit(1);
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Media not found");

  const derivatives = await context.db
    .select({ storageKey: mediaDerivatives.storageKey })
    .from(mediaDerivatives)
    .where(eq(mediaDerivatives.mediaId, mediaId));

  // Storage first: if it fails we have not yet claimed the file is gone.
  for (const key of [row.storageKey, ...derivatives.map((d) => d.storageKey)]) {
    await context.storage.delete(key).catch((error: unknown) => {
      context.logger.warn("Could not delete an object from storage", { key, error });
    });
  }

  await context.db
    .update(mediaAssets)
    .set({
      status: "deleted",
      bytesDeletedAt: new Date(),
      deletedAt: new Date(),
      internalNotes: sql`coalesce(${mediaAssets.internalNotes} || E'\n\n', '') || ${`Deleted: ${reason}`}`,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.id, mediaId));

  await context.db.delete(mediaDerivatives).where(eq(mediaDerivatives.mediaId, mediaId));

  await recordAudit(context.db, context, {
    action: "media.deleted",
    entityType: "media",
    entityId: mediaId,
    entityLabel: row.originalFilename,
    context: { reason, usageCount: row.usageCount },
  });
}

/** Quarantine a rejected upload for inspection, without serving it. */
export async function quarantineUpload(
  context: AnyContext,
  input: { readonly reason: string; readonly detail: string | null; readonly filename: string | null },
): Promise<void> {
  await recordAudit(context.db, context, {
    action: "media.quarantined",
    entityType: "media",
    entityId: null,
    entityLabel: input.filename,
    context: { reason: input.reason, detail: input.detail },
  });
}

/** Recompute usage counts across the library, for the repair action. */
export async function recomputeMediaUsageCounts(db: Db, mediaIds?: readonly string[]): Promise<void> {
  await db
    .update(mediaAssets)
    .set({
      usageCount: sql`(select count(*)::int from ${mediaUsages} where ${mediaUsages.mediaId} = ${mediaAssets}.id)`,
    })
    .where(mediaIds && mediaIds.length > 0 ? inArray(mediaAssets.id, [...mediaIds]) : undefined);
}

/** Log a media-related warning with consistent shape. */
export function logMediaWarning(logger: Logger, message: string, fields: Record<string, unknown>): void {
  logger.warn(message, fields);
}
