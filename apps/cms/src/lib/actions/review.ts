"use server";

/**
 * Review and publishing actions (§15, §16).
 *
 * Every one of these delegates to a service in `@uxd/api`, which is where the
 * permission check, the transition check, the publish gate and the audit write
 * live. The action's own job is to translate an `AppError` into something the
 * review interface can show without losing the operator's place in the queue.
 */
import { refresh } from "next/cache";
import {
  bulkApprove,
  bulkArchive,
  bulkAssignReviewer,
  bulkPublish,
  bulkReject,
  bulkSetStatus,
  checkPublishability,
  flagSource,
  publishContent,
  recordDecision,
  setFeatured,
  unpublishContent,
  updateRights,
} from "@uxd/api";
import { AppError } from "@uxd/shared";
import type { LifecycleStatus, ReviewDecision } from "@uxd/types";
import { getAdminContext, getAdminContextWith } from "@/lib/server";

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
  /** Field-level reasons, so the UI can point at what is blocking. */
  readonly issues: readonly { path: string; message: string }[];
}

const ok = (message: string): ActionResult => ({ ok: true, message, error: null, issues: [] });

const failed = (error: unknown, fallback: string): ActionResult => ({
  ok: false,
  message: null,
  error: AppError.is(error) ? error.publicMessage : fallback,
  issues: AppError.is(error) ? (error.issues ?? []) : [],
});

/**
 * Record a review decision, optionally publishing in the same step.
 *
 * The "approve and publish" path is one action rather than two so a reviewer
 * working the queue with the keyboard does not have to leave it, and so the
 * two writes share a transaction.
 */
export async function decideAction(input: {
  contentId: string;
  decision: ReviewDecision;
  notes?: string;
  durationMs?: number;
  publishImmediately?: boolean;
}): Promise<ActionResult> {
  try {
    const context = await getAdminContext();
    const result = await recordDecision(context, {
      contentId: input.contentId,
      decision: input.decision,
      notes: input.notes ?? null,
      durationMs: input.durationMs ?? null,
      publishImmediately: input.publishImmediately ?? false,
    });
    refresh();

    if (input.publishImmediately && !result.published && result.publishBlockers.length > 0) {
      return {
        ok: true,
        message: "Approved, but not published yet.",
        error: null,
        issues: result.publishBlockers.map((blocker) => ({
          path: blocker.field ?? "status",
          message: blocker.message,
        })),
      };
    }

    return ok(
      result.published
        ? "Approved and published."
        : input.decision === "approved"
          ? "Approved."
          : input.decision === "rejected"
            ? "Rejected."
            : input.decision === "escalated"
              ? "Escalated — held back pending a rights decision."
              : "Sent back for changes.",
    );
  } catch (error) {
    return failed(error, "Could not record that decision.");
  }
}

export async function publishAction(contentId: string): Promise<ActionResult> {
  try {
    const context = await getAdminContext();
    await publishContent(context, contentId);
    refresh();
    return ok("Published. It is now live on the public API.");
  } catch (error) {
    return failed(error, "Could not publish that record.");
  }
}

/** In or out of its website's featured section. */
export async function setFeaturedAction(contentId: string, featured: boolean): Promise<ActionResult> {
  try {
    await setFeatured(await getAdminContext(), contentId, featured);
    refresh();
    return ok(featured ? "Featured." : "No longer featured.");
  } catch (error) {
    return failed(error, "That couldn't be changed.");
  }
}

export async function unpublishAction(contentId: string, reason: string): Promise<ActionResult> {
  try {
    const context = await getAdminContext();
    await unpublishContent(context, contentId, reason);
    refresh();
    return ok("Unpublished. It is no longer on the public API, and stays approved.");
  } catch (error) {
    return failed(error, "Could not unpublish that record.");
  }
}

/** Why a record cannot be published, for the disabled button's explanation. */
export async function publishabilityAction(contentId: string): Promise<{
  allowed: boolean;
  blockers: readonly { code: string; message: string; field?: string }[];
}> {
  const context = await getAdminContext();
  const result = await checkPublishability(context.db, contentId);
  if (!result) return { allowed: false, blockers: [{ code: "NOT_FOUND", message: "Not found." }] };
  return { allowed: result.result.allowed, blockers: result.result.blockers };
}

// --- Bulk operations (§16) ------------------------------------------------

export interface BulkActionResult extends ActionResult {
  readonly succeeded: number;
  readonly failures: readonly { id: string; reason: string }[];
}

/**
 * Summarise a bulk result.
 *
 * A partial success is reported as a partial success, with the per-record
 * reasons. Approving 40 items where 3 lack a title should publish 37 and say
 * which 3 failed — telling a reviewer "the operation failed" would leave them
 * unable to make progress without inspecting every record by hand.
 */
function summariseBulk(
  verb: string,
  result: { requested: number; succeeded: readonly string[]; failed: readonly { id: string; reason: string }[] },
): BulkActionResult {
  const done = result.succeeded.length;
  const failedCount = result.failed.length;

  return {
    ok: done > 0,
    succeeded: done,
    failures: result.failed,
    message:
      done > 0
        ? failedCount > 0
          ? `${verb} ${done} of ${result.requested}. ${failedCount} could not be ${verb.toLowerCase()} — see the reasons below.`
          : `${verb} ${done} ${done === 1 ? "record" : "records"}.`
        : null,
    error: done === 0 ? `Nothing could be ${verb.toLowerCase()}.` : null,
    issues: [],
  };
}

const emptyBulk = (error: unknown, fallback: string): BulkActionResult => ({
  ...failed(error, fallback),
  succeeded: 0,
  failures: [],
});

export async function bulkApproveAction(contentIds: string[]): Promise<BulkActionResult> {
  try {
    const context = await getAdminContext();
    const result = await bulkApprove(context, contentIds);
    refresh();
    return summariseBulk("Approved", result);
  } catch (error) {
    return emptyBulk(error, "Could not approve those records.");
  }
}

export async function bulkRejectAction(
  contentIds: string[],
  reason: string,
): Promise<BulkActionResult> {
  try {
    const context = await getAdminContext();
    const result = await bulkReject(context, contentIds, reason);
    refresh();
    return summariseBulk("Rejected", result);
  } catch (error) {
    return emptyBulk(error, "Could not reject those records.");
  }
}

export async function bulkPublishAction(contentIds: string[]): Promise<BulkActionResult> {
  try {
    const context = await getAdminContext();
    const result = await bulkPublish(context, contentIds);
    refresh();
    return summariseBulk("Published", result);
  } catch (error) {
    return emptyBulk(error, "Could not publish those records.");
  }
}

export async function bulkArchiveAction(contentIds: string[]): Promise<BulkActionResult> {
  try {
    const context = await getAdminContext();
    const result = await bulkArchive(context, contentIds);
    refresh();
    return summariseBulk("Archived", result);
  } catch (error) {
    return emptyBulk(error, "Could not archive those records.");
  }
}

export async function bulkSetStatusAction(
  contentIds: string[],
  status: LifecycleStatus,
): Promise<BulkActionResult> {
  try {
    const context = await getAdminContext();
    const result = await bulkSetStatus(context, contentIds, status);
    refresh();
    return summariseBulk("Updated", result);
  } catch (error) {
    return emptyBulk(error, "Could not change those statuses.");
  }
}

export async function bulkAssignAction(
  contentIds: string[],
  assignedTo: string | null,
): Promise<BulkActionResult> {
  try {
    const context = await getAdminContext();
    const result = await bulkAssignReviewer(context, contentIds, assignedTo);
    refresh();
    return summariseBulk("Assigned", result);
  } catch (error) {
    return emptyBulk(error, "Could not assign those records.");
  }
}

// --- Rights (§22) --------------------------------------------------------

export async function updateRightsAction(
  contentId: string,
  patch: {
    rightsStatus?: string;
    rightsOwner?: string | null;
    attribution?: string | null;
    permissionStatus?: string;
    takedownStatus?: string;
    legalReviewStatus?: string;
    rightsNotes?: string | null;
  },
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("rights.update");
    await updateRights(context, contentId, patch as never);
    refresh();
    return ok("Rights information updated.");
  } catch (error) {
    return failed(error, "Could not update the rights information.");
  }
}

export async function flagSourceAction(sourceId: string, reason: string): Promise<ActionResult> {
  try {
    const context = await getAdminContext();
    await flagSource(context, sourceId, reason);
    refresh();
    return ok("Source flagged for review.");
  } catch (error) {
    return failed(error, "Could not flag that source.");
  }
}
