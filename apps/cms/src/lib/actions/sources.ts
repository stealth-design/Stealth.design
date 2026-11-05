"use server";

/**
 * Source actions (§3, §22, §40).
 *
 * Thin wrappers, for the same reason as the review actions: the permission
 * check, the validation, the SSRF guard and the audit write all live in the
 * service. What is added here is the translation of an `AppError` into
 * something the source screen can show.
 */
import { refreshAll as refresh } from "@/lib/public-site";
import { flagSource, recaptureSource, updateSourceRights } from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContext } from "@/lib/server";

export interface SourceActionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly issues: readonly { path: string; message: string }[];
  /** Set when a recapture created a job, so the UI can link to it. */
  readonly jobId: string | null;
}

const ok = (message: string, jobId: string | null = null): SourceActionResult => ({
  ok: true,
  message,
  error: null,
  issues: [],
  jobId,
});

const failed = (error: unknown, fallback: string): SourceActionResult => ({
  ok: false,
  message: null,
  error: AppError.is(error) ? error.publicMessage : fallback,
  issues: AppError.is(error) ? (error.issues ?? []) : [],
  jobId: null,
});

/** Queue a recapture of everything already held for this source. */
export async function recaptureSourceAction(
  sourceId: string,
  options: { statuses?: string[] } = {},
): Promise<SourceActionResult> {
  try {
    const context = await getAdminContext();
    const result = await recaptureSource(context, sourceId, {
      statuses: options.statuses,
      startNow: true,
    });
    refresh();
    return ok(
      `Queued ${result.queuedCount.toLocaleString("en-US")} URL${result.queuedCount === 1 ? "" : "s"} as ${result.reference}.`,
      result.jobId,
    );
  } catch (error) {
    return failed(error, "Could not queue a recapture for that source.");
  }
}

export async function flagSourceAction(
  sourceId: string,
  reason: string,
): Promise<SourceActionResult> {
  try {
    const context = await getAdminContext();
    await flagSource(context, sourceId, reason);
    refresh();
    return ok("Flagged for review.");
  } catch (error) {
    return failed(error, "Could not flag that source.");
  }
}

export async function updateSourceRightsAction(
  sourceId: string,
  patch: {
    rightsStatus?: string;
    rightsOwner?: string | null;
    attribution?: string | null;
    rightsNotes?: string | null;
  },
): Promise<SourceActionResult> {
  try {
    const context = await getAdminContext();
    await updateSourceRights(context, sourceId, patch);
    refresh();
    return ok("Rights position updated. Content records keep their own.");
  } catch (error) {
    return failed(error, "Could not update the rights position.");
  }
}
