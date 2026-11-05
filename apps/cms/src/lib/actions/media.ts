"use server";

/**
 * Media actions (§9, §30).
 *
 * Upload goes through `ingestMedia`, the same service the capture worker's
 * uploads use, so an operator's file gets identical treatment: type sniffed
 * from magic bytes, checked against the allowlist, hashed, deduplicated,
 * thumbnailed, and recorded with provenance. There is no second, more
 * permissive upload path.
 */
import { refreshAll as refresh } from "@/lib/public-site";
import { and, eq } from "drizzle-orm";
import { mediaAssets } from "@uxd/database";
import {
  attachMedia,
  deleteMediaBytes,
  detachMedia,
  ingestMedia,
  recordAudit,
} from "@uxd/api";
import { AppError, sanitizeText } from "@uxd/shared";
import { UPLOADABLE_MIME_TYPES, type MediaUsageRole } from "@uxd/types";
import { getAdminContext, getAdminContextWith } from "@/lib/server";

export interface MediaActionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly mediaId?: string;
  readonly deduplicated?: boolean;
}

const failed = (error: unknown, fallback: string): MediaActionResult => ({
  ok: false,
  message: null,
  error: AppError.is(error) ? error.publicMessage : fallback,
});

/**
 * Upload one file.
 *
 * A rejected file is reported with the reason the validator gave — "the file's
 * actual contents do not match its claimed type", "the SVG contains script" —
 * rather than a generic failure, because the operator usually needs to know
 * whether to convert the file or stop trying.
 */
export async function uploadMediaAction(formData: FormData): Promise<MediaActionResult> {
  try {
    const context = await getAdminContextWith("media.upload");

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: null, error: "Choose a file to upload." };
    }

    const maxBytes = context.env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      return {
        ok: false,
        message: null,
        error: `That file is ${Math.round(file.size / 1_048_576)}MB, over the ${context.env.MEDIA_MAX_UPLOAD_MB}MB limit.`,
      };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestMedia(context, {
      bytes,
      originalFilename: file.name,
      altText: sanitizeText(formData.get("altText"), { maxLength: 500 }),
      caption: sanitizeText(formData.get("caption"), { maxLength: 1_000 }),
      title: sanitizeText(formData.get("title"), { maxLength: 300 }),
      uploadedBy: context.actor.id,
      maxBytes,
      provenance: { uploadSource: "manual_upload", captureMethod: "manual_upload" },
    });

    await recordAudit(context.db, context, {
      action: result.deduplicated ? "media.dedupe_reused" : "media.uploaded",
      entityType: "media",
      entityId: result.mediaId,
      entityLabel: file.name,
      context: { byteSize: result.byteSize, mimeType: result.mimeType },
    });

    // Attach it immediately when the upload came from a content record.
    const contentId = formData.get("contentItemId");
    const role = formData.get("role");
    if (typeof contentId === "string" && contentId.length > 0) {
      await attachMedia(context.db, {
        mediaId: result.mediaId,
        contentItemId: contentId,
        role: (typeof role === "string" ? role : "attachment") as MediaUsageRole,
        createdBy: context.actor.id,
      });
    }

    refresh();
    return {
      ok: true,
      mediaId: result.mediaId,
      deduplicated: result.deduplicated,
      error: null,
      message: result.deduplicated
        ? "That exact file was already in the library, so the existing record was reused."
        : `Uploaded. ${result.derivativeCount} preview size${result.derivativeCount === 1 ? "" : "s"} generated.${
            result.nearDuplicates.length > 0
              ? ` ${result.nearDuplicates.length} visually similar file${result.nearDuplicates.length === 1 ? "" : "s"} already exist — worth a look.`
              : ""
          }`,
    };
  } catch (error) {
    return failed(error, "Could not upload that file.");
  }
}

/** The accept attribute and limits, so the form and the validator agree. */
export async function uploadConstraintsAction(): Promise<{
  maxMb: number;
  mimeTypes: readonly string[];
}> {
  const context = await getAdminContext();
  return { maxMb: context.env.MEDIA_MAX_UPLOAD_MB, mimeTypes: UPLOADABLE_MIME_TYPES };
}

export async function updateMediaAction(
  mediaId: string,
  patch: { title?: string | null; altText?: string | null; caption?: string | null; internalNotes?: string | null },
): Promise<MediaActionResult> {
  try {
    const context = await getAdminContextWith("media.update");
    const [before] = await context.db
      .select({
        id: mediaAssets.id,
        title: mediaAssets.title,
        altText: mediaAssets.altText,
        caption: mediaAssets.caption,
        originalFilename: mediaAssets.originalFilename,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, mediaId))
      .limit(1);
    if (!before) return { ok: false, message: null, error: "That file no longer exists." };

    const next = {
      title: sanitizeText(patch.title, { maxLength: 300 }),
      altText: sanitizeText(patch.altText, { maxLength: 500 }),
      caption: sanitizeText(patch.caption, { maxLength: 1_000 }),
      internalNotes: sanitizeText(patch.internalNotes, { maxLength: 4_000, singleLine: false }),
    };

    await context.db
      .update(mediaAssets)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(mediaAssets.id, mediaId));

    await recordAudit(context.db, context, {
      action: "media.updated",
      entityType: "media",
      entityId: mediaId,
      entityLabel: before.originalFilename,
      before: { title: before.title, altText: before.altText, caption: before.caption },
      after: next,
    });

    refresh();
    return { ok: true, message: "Saved.", error: null };
  } catch (error) {
    return failed(error, "Could not save those details.");
  }
}

export async function archiveMediaAction(mediaId: string): Promise<MediaActionResult> {
  try {
    const context = await getAdminContextWith("media.archive");
    await context.db
      .update(mediaAssets)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mediaAssets.id, mediaId), eq(mediaAssets.status, "ready")));
    await recordAudit(context.db, context, {
      action: "media.archived",
      entityType: "media",
      entityId: mediaId,
    });
    refresh();
    return { ok: true, message: "Archived. It stays stored and stays linked; it is just hidden.", error: null };
  } catch (error) {
    return failed(error, "Could not archive that file.");
  }
}

/**
 * Delete a file's bytes.
 *
 * The row survives, because §10's provenance requirement outlives the file:
 * "where did this come from and when did we capture it" has to stay answerable
 * for something we removed, including after a takedown.
 */
export async function deleteMediaAction(
  mediaId: string,
  reason: string,
): Promise<MediaActionResult> {
  try {
    const context = await getAdminContextWith("media.delete");
    if (reason.trim().length === 0) {
      return { ok: false, message: null, error: "Give a reason for deleting this file." };
    }
    await deleteMediaBytes(context, mediaId, reason.trim());
    refresh();
    return {
      ok: true,
      message:
        "The file was deleted from storage. Its record stays, so where it came from is still answerable.",
      error: null,
    };
  } catch (error) {
    return failed(error, "Could not delete that file.");
  }
}

export async function detachMediaAction(
  mediaId: string,
  contentItemId: string,
): Promise<MediaActionResult> {
  try {
    const context = await getAdminContextWith("media.update");
    await detachMedia(context.db, mediaId, contentItemId);
    refresh();
    return { ok: true, message: "Detached from that record.", error: null };
  } catch (error) {
    return failed(error, "Could not detach that file.");
  }
}
