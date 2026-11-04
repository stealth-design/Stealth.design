/**
 * Review, approval and publishing (§15, §16, §18).
 *
 * The only code in the system that moves a content record toward `published`.
 * Both entry points — the HTTP admin API and the CMS's server actions — call
 * these functions, so there is one implementation of the publish decision and
 * it cannot be bypassed by using a different door.
 *
 * Three checks run on every transition, in this order:
 *
 *   1. Permission (`requirePermission`) — can this actor do this at all?
 *   2. Transition validity (`canTransition`) — is this move legal from the
 *      record's current status?
 *   3. Publishability (`canPublish`) — for a publish specifically, is the
 *      record complete and free of rights holds?
 *
 * And a fourth, behind all of them: the `content_items_publishable` and
 * `content_items_approval_attributable` CHECK constraints, which make an
 * unpublishable published row impossible even for a direct SQL write.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { requirePermission } from "@uxd/auth";
import { type Db, contentItems, mediaUsages, reviews, sources } from "@uxd/database";
import { AppError, ErrorCode, conflict, notFound, uuidv7 } from "@uxd/shared";
import {
  CONTENT_KIND_META,
  type LifecycleStatus,
  LIFECYCLE_STATUS_META,
  type PublishabilityResult,
  type ReviewDecision,
  REVIEW_DECISION_META,
  type ReviewReason,
  canPublish,
  canTransition,
} from "@uxd/types";
import { recordAudit, recordBulkAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";

/**
 * Content kinds whose public page is meaningless without an image.
 *
 * A page or screen with no screenshot is not a usable reference. A flow is
 * (its steps carry the images), and so is an interaction record that documents
 * a behaviour in prose.
 */
function requiresMedia(kind: string): boolean {
  return kind === "page" || kind === "screen" || kind === "website" || kind === "app";
}

interface PublishabilityRow {
  readonly id: string;
  readonly kind: string;
  readonly status: LifecycleStatus;
  readonly rightsStatus: Parameters<typeof canPublish>[0]["rightsStatus"];
  readonly title: string | null;
  readonly slug: string | null;
  readonly primaryMediaId: string | null;
  readonly approvedAt: Date | null;
  readonly approvedBy: string | null;
}

/** Evaluate a record's publishability without changing anything. */
export async function checkPublishability(
  db: Db,
  contentId: string,
): Promise<{ row: PublishabilityRow; result: PublishabilityResult } | null> {
  const [row] = await db
    .select({
      id: contentItems.id,
      kind: contentItems.kind,
      status: contentItems.status,
      rightsStatus: contentItems.rightsStatus,
      title: contentItems.title,
      slug: contentItems.slug,
      primaryMediaId: contentItems.primaryMediaId,
      approvedAt: contentItems.approvedAt,
      approvedBy: contentItems.approvedBy,
    })
    .from(contentItems)
    .where(and(eq(contentItems.id, contentId), isNull(contentItems.deletedAt)))
    .limit(1);

  if (!row) return null;

  // A record can have media attached through `media_usages` without a
  // `primaryMediaId` set — a reviewer who uploaded a replacement but has not
  // chosen it as primary yet. Count both.
  const hasPrimaryMedia =
    row.primaryMediaId !== null ||
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(mediaUsages)
        .where(eq(mediaUsages.contentItemId, contentId))
    )[0]!.n > 0;

  return {
    row,
    result: canPublish({
      status: row.status,
      rightsStatus: row.rightsStatus,
      title: row.title,
      slug: row.slug,
      hasPrimaryMedia,
      requiresMedia: requiresMedia(row.kind),
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy,
    }),
  };
}

// --- Review decisions -----------------------------------------------------

export interface RecordDecisionInput {
  readonly contentId: string;
  readonly decision: ReviewDecision;
  readonly notes?: string | null;
  /** Wall-clock the reviewer spent on this item, from the review UI. */
  readonly durationMs?: number | null;
  /** Publish immediately after approving, for the review screen's "approve
   * and publish" shortcut. */
  readonly publishImmediately?: boolean;
}

export interface DecisionResult {
  readonly contentId: string;
  readonly status: LifecycleStatus;
  readonly published: boolean;
  /** Set when `publishImmediately` was asked for but refused. */
  readonly publishBlockers: PublishabilityResult["blockers"];
}

/**
 * Record a review decision (§15).
 *
 * The decision's target status comes from `REVIEW_DECISION_META`, so the
 * keyboard shortcut, the button, the resulting status and the note requirement
 * are all one declaration rather than four places to keep in sync.
 */
export async function recordDecision(
  context: AdminContext,
  input: RecordDecisionInput,
): Promise<DecisionResult> {
  requirePermission(context.actor, "review.decide");
  const meta = REVIEW_DECISION_META[input.decision];

  const notes = input.notes?.trim() ?? "";
  if (meta.requiresNote && notes.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `A note is required to ${meta.label.toLowerCase()}.`, {
      issues: [{ path: "notes", message: "Say why, so the record explains itself later." }],
    });
  }

  return inTransaction(context, async (tx) => {
    const check = await checkPublishability(tx.db, input.contentId);
    if (!check) throw notFound("Content");

    const { row } = check;
    const target = meta.resultingStatus as LifecycleStatus;

    if (row.status !== target && !canTransition(row.status, target)) {
      throw conflict(
        `This record is ${LIFECYCLE_STATUS_META[row.status].label.toLowerCase()} and cannot move to ${LIFECYCLE_STATUS_META[target].label.toLowerCase()}.`,
        { detail: `illegal transition ${row.status} -> ${target}` },
      );
    }

    const now = new Date();
    const patch: Record<string, unknown> = {
      status: target,
      reviewedBy: context.actor.id,
      reviewedAt: now,
      reviewNotes: notes.length > 0 ? notes : row.status === target ? undefined : null,
      updatedBy: context.actor.id,
      updatedAt: now,
    };

    if (input.decision === "approved") {
      patch.approvedBy = context.actor.id;
      patch.approvedAt = now;
      patch.rejectedBy = null;
      patch.rejectedAt = null;
      patch.rejectionReason = null;
    } else if (input.decision === "rejected") {
      patch.rejectedBy = context.actor.id;
      patch.rejectedAt = now;
      patch.rejectionReason = notes;
      // Clear the approval so a later re-approval has to be recorded afresh.
      patch.approvedBy = null;
      patch.approvedAt = null;
    } else if (input.decision === "escalated") {
      // Escalation is a rights hold, not just a status: it must block
      // publishing even if someone later approves the record.
      patch.rightsStatus = "pending_review";
      patch.legalReviewStatus = "queued";
      patch.rightsNotes = notes;
    }

    await tx.db.update(contentItems).set(patch).where(eq(contentItems.id, input.contentId));

    // Close any open review assignment and record the decision.
    await tx.db
      .update(reviews)
      .set({
        status: "done",
        decision: input.decision,
        decidedBy: context.actor.id,
        decidedAt: now,
        notes: notes.length > 0 ? notes : null,
        durationMs: input.durationMs ?? null,
        updatedAt: now,
      })
      .where(and(eq(reviews.contentItemId, input.contentId), inArray(reviews.status, ["pending", "in_progress"])));

    // If there was no open assignment (an unassigned queue item reviewed
    // directly), record one so the history is complete either way.
    const openCount = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(reviews)
      .where(and(eq(reviews.contentItemId, input.contentId), eq(reviews.decision, input.decision)));
    if ((openCount[0]?.n ?? 0) === 0) {
      await tx.db.insert(reviews).values({
        id: uuidv7(),
        contentItemId: input.contentId,
        reason: "manual",
        status: "done",
        decision: input.decision,
        decidedBy: context.actor.id,
        decidedAt: now,
        notes: notes.length > 0 ? notes : null,
        durationMs: input.durationMs ?? null,
      });
    }

    await recordAudit(tx.db, context, {
      action:
        input.decision === "approved"
          ? "content.approved"
          : input.decision === "rejected"
            ? "content.rejected"
            : "review.decided",
      entityType: "content",
      entityId: input.contentId,
      entityLabel: row.title,
      before: { status: row.status },
      after: { status: target },
      context: { decision: input.decision, ...(notes ? { notes } : {}) },
    });

    // --- Optional immediate publish -----------------------------------
    if (input.decision === "approved" && input.publishImmediately) {
      if (!context.actor || !hasPublishPermission(context)) {
        return { contentId: input.contentId, status: target, published: false, publishBlockers: [] };
      }
      const after = await checkPublishability(tx.db, input.contentId);
      if (after && after.result.allowed) {
        await publishInTransaction(tx.db, context, input.contentId, row.title);
        return { contentId: input.contentId, status: "published", published: true, publishBlockers: [] };
      }
      return {
        contentId: input.contentId,
        status: target,
        published: false,
        publishBlockers: after?.result.blockers ?? [],
      };
    }

    return { contentId: input.contentId, status: target, published: false, publishBlockers: [] };
  });
}

function hasPublishPermission(context: AdminContext): boolean {
  try {
    requirePermission(context.actor, "content.publish");
    return true;
  } catch {
    return false;
  }
}

// --- Publish / unpublish --------------------------------------------------

/** Publish one record. Throws with every blocker listed if it cannot. */
export async function publishContent(
  context: AdminContext,
  contentId: string,
): Promise<{ contentId: string; publishedAt: Date }> {
  requirePermission(context.actor, "content.publish");

  return inTransaction(context, async (tx) => {
    const check = await checkPublishability(tx.db, contentId);
    if (!check) throw notFound("Content");

    if (!check.result.allowed) {
      throw new AppError(ErrorCode.PRECONDITION_FAILED, "This cannot be published yet.", {
        detail: check.result.blockers.map((b) => b.code).join(", "),
        issues: check.result.blockers.map((b) => ({
          path: b.field ?? "status",
          message: b.message,
        })),
      });
    }

    const publishedAt = await publishInTransaction(tx.db, context, contentId, check.row.title);
    return { contentId, publishedAt };
  });
}

async function publishInTransaction(
  db: Db,
  context: AdminContext,
  contentId: string,
  label: string | null,
): Promise<Date> {
  const now = new Date();
  await db
    .update(contentItems)
    .set({
      status: "published",
      publishedAt: now,
      // `firstPublishedAt` is set once and never moved, so "how long has this
      // been live" survives an unpublish/republish cycle.
      firstPublishedAt: sql`coalesce(${contentItems.firstPublishedAt}, ${now})`,
      publishedBy: context.actor.id,
      unpublishedAt: null,
      updatedBy: context.actor.id,
      updatedAt: now,
    })
    .where(eq(contentItems.id, contentId));

  await recordAudit(db, context, {
    action: "content.published",
    entityType: "content",
    entityId: contentId,
    entityLabel: label,
  });

  return now;
}

/**
 * Put a live screen in (or take it out of) its website's featured section.
 *
 * Featuring is a publishing decision — it changes what a visitor sees first —
 * so it sits behind the same permission as publishing, and only something
 * already live can be featured.
 */
export async function setFeatured(context: AdminContext, contentId: string, featured: boolean): Promise<void> {
  requirePermission(context.actor, "content.publish");

  await inTransaction(context, async (tx) => {
    const [row] = await tx.db
      .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status, featuredAt: contentItems.featuredAt })
      .from(contentItems)
      .where(and(eq(contentItems.id, contentId), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Content");
    if (featured && row.status !== "published") throw conflict("Only something live can be featured. Publish it first.");
    if ((row.featuredAt !== null) === featured) return;

    await tx.db
      .update(contentItems)
      .set({ featuredAt: featured ? new Date() : null, updatedBy: context.actor.id, updatedAt: new Date() })
      .where(eq(contentItems.id, contentId));
    await recordAudit(tx.db, context, {
      action: featured ? "content.featured" : "content.unfeatured",
      entityType: "content",
      entityId: contentId,
      entityLabel: row.title,
    });
  });
}

/**
 * Unpublish.
 *
 * Returns the record to `approved` rather than to a draft state: it was
 * reviewed and signed off, and that fact should not be discarded because it was
 * temporarily withdrawn.
 */
export async function unpublishContent(
  context: AdminContext,
  contentId: string,
  reason: string,
): Promise<void> {
  requirePermission(context.actor, "content.unpublish");
  if (reason.trim().length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Give a reason for unpublishing.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }

  await inTransaction(context, async (tx) => {
    const [row] = await tx.db
      .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status })
      .from(contentItems)
      .where(and(eq(contentItems.id, contentId), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Content");
    if (row.status !== "published") throw conflict("This is not published.");

    const now = new Date();
    await tx.db
      .update(contentItems)
      .set({
        status: "approved",
        unpublishedAt: now,
        publishedAt: null,
        // Off the site means off its website's featured section too.
        featuredAt: null,
        internalNotes: sql`coalesce(${contentItems.internalNotes} || E'\n\n', '') || ${`Unpublished ${now.toISOString()}: ${reason.trim()}`}`,
        updatedBy: context.actor.id,
        updatedAt: now,
      })
      .where(eq(contentItems.id, contentId));

    await recordAudit(tx.db, context, {
      action: "content.unpublished",
      entityType: "content",
      entityId: contentId,
      entityLabel: row.title,
      context: { reason: reason.trim() },
    });
  });
}

// --- Bulk operations (§16) ------------------------------------------------

export interface BulkResult {
  readonly requested: number;
  readonly succeeded: readonly string[];
  /** Per-record failures, so a partial bulk operation is legible. */
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
  readonly batchId: string | null;
}

/**
 * Bulk publish.
 *
 * Each record is evaluated independently and the results are reported
 * per-record. A bulk publish of 40 items where 3 lack a title publishes 37 and
 * tells the operator exactly which 3 failed and why — the alternative,
 * failing the whole batch, means a reviewer cannot make progress until every
 * record is perfect.
 */
export async function bulkPublish(
  context: AdminContext,
  contentIds: readonly string[],
): Promise<BulkResult> {
  requirePermission(context.actor, "content.publish");
  return bulkApply(context, contentIds, "content.published", async (tx, id) => {
    const check = await checkPublishability(tx, id);
    if (!check) return { ok: false, reason: "Not found." };
    if (!check.result.allowed) {
      return { ok: false, reason: check.result.blockers.map((b) => b.message).join(" ") };
    }
    await publishInTransaction(tx, context, id, check.row.title);
    return { ok: true, label: check.row.title };
  });
}

export async function bulkApprove(
  context: AdminContext,
  contentIds: readonly string[],
): Promise<BulkResult> {
  requirePermission(context.actor, "content.approve");
  return bulkApply(context, contentIds, "content.approved", async (tx, id) => {
    const [row] = await tx
      .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status })
      .from(contentItems)
      .where(and(eq(contentItems.id, id), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row) return { ok: false, reason: "Not found." };
    if (row.status === "approved") return { ok: false, reason: "Already approved." };
    if (!canTransition(row.status, "approved")) {
      return {
        ok: false,
        reason: `Cannot approve from ${LIFECYCLE_STATUS_META[row.status].label.toLowerCase()}.`,
      };
    }
    const now = new Date();
    await tx
      .update(contentItems)
      .set({
        status: "approved",
        approvedBy: context.actor.id,
        approvedAt: now,
        reviewedBy: context.actor.id,
        reviewedAt: now,
        updatedBy: context.actor.id,
        updatedAt: now,
      })
      .where(eq(contentItems.id, id));
    return { ok: true, label: row.title };
  });
}

export async function bulkReject(
  context: AdminContext,
  contentIds: readonly string[],
  reason: string,
): Promise<BulkResult> {
  requirePermission(context.actor, "content.reject");
  if (reason.trim().length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Give a reason for rejecting.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }
  return bulkApply(context, contentIds, "content.rejected", async (tx, id) => {
    const [row] = await tx
      .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status })
      .from(contentItems)
      .where(and(eq(contentItems.id, id), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row) return { ok: false, reason: "Not found." };
    if (!canTransition(row.status, "rejected")) {
      return {
        ok: false,
        reason: `Cannot reject from ${LIFECYCLE_STATUS_META[row.status].label.toLowerCase()}.`,
      };
    }
    const now = new Date();
    await tx
      .update(contentItems)
      .set({
        status: "rejected",
        rejectedBy: context.actor.id,
        rejectedAt: now,
        rejectionReason: reason.trim(),
        approvedBy: null,
        approvedAt: null,
        updatedBy: context.actor.id,
        updatedAt: now,
      })
      .where(eq(contentItems.id, id));
    return { ok: true, label: row.title };
  });
}

export async function bulkArchive(
  context: AdminContext,
  contentIds: readonly string[],
): Promise<BulkResult> {
  requirePermission(context.actor, "content.archive");
  return bulkApply(context, contentIds, "content.archived", async (tx, id) => {
    const [row] = await tx
      .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status })
      .from(contentItems)
      .where(and(eq(contentItems.id, id), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row) return { ok: false, reason: "Not found." };
    if (!canTransition(row.status, "archived")) {
      return {
        ok: false,
        reason: `Cannot archive from ${LIFECYCLE_STATUS_META[row.status].label.toLowerCase()}.`,
      };
    }
    await tx
      .update(contentItems)
      .set({
        status: "archived",
        publishedAt: null,
        updatedBy: context.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, id));
    return { ok: true, label: row.title };
  });
}

/**
 * Change status in bulk, for any transition the actor is allowed to make.
 *
 * Validates the target against the transition map per record, so a mixed
 * selection produces per-record failures rather than an all-or-nothing result.
 */
export async function bulkSetStatus(
  context: AdminContext,
  contentIds: readonly string[],
  target: LifecycleStatus,
): Promise<BulkResult> {
  // Publishing has its own gate and its own permission; route it there.
  if (target === "published") return bulkPublish(context, contentIds);
  if (target === "approved") return bulkApprove(context, contentIds);
  if (target === "archived") return bulkArchive(context, contentIds);
  requirePermission(context.actor, "content.update");

  return bulkApply(context, contentIds, "content.status_changed", async (tx, id) => {
    const [row] = await tx
      .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status })
      .from(contentItems)
      .where(and(eq(contentItems.id, id), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row) return { ok: false, reason: "Not found." };
    if (row.status === target) return { ok: false, reason: "Already in that state." };
    if (!canTransition(row.status, target)) {
      return {
        ok: false,
        reason: `Cannot move from ${LIFECYCLE_STATUS_META[row.status].label.toLowerCase()} to ${LIFECYCLE_STATUS_META[target].label.toLowerCase()}.`,
      };
    }
    await tx
      .update(contentItems)
      .set({ status: target, updatedBy: context.actor.id, updatedAt: new Date() })
      .where(eq(contentItems.id, id));
    return { ok: true, label: row.title };
  });
}

const MAX_BULK_ITEMS = 500;

async function bulkApply(
  context: AdminContext,
  contentIds: readonly string[],
  action: Parameters<typeof recordBulkAudit>[2]["action"],
  apply: (tx: Db, id: string) => Promise<{ ok: true; label: string | null } | { ok: false; reason: string }>,
): Promise<BulkResult> {
  const ids = [...new Set(contentIds)].slice(0, MAX_BULK_ITEMS);
  if (contentIds.length > MAX_BULK_ITEMS) {
    throw new AppError(
      ErrorCode.LIMIT_EXCEEDED,
      `Bulk operations are limited to ${MAX_BULK_ITEMS} records at a time.`,
    );
  }
  if (ids.length === 0) {
    return { requested: 0, succeeded: [], failed: [], batchId: null };
  }

  return inTransaction(context, async (tx) => {
    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const labels: { id: string; label?: string | null }[] = [];

    for (const id of ids) {
      const result = await apply(tx.db, id);
      if (result.ok) {
        succeeded.push(id);
        labels.push({ id, label: result.label });
      } else {
        failed.push({ id, reason: result.reason });
      }
    }

    const batchId =
      succeeded.length > 0
        ? await recordBulkAudit(tx.db, context, {
            action,
            entityType: "content",
            items: labels,
            summary: `${action.replace("content.", "")} ${succeeded.length} content record${succeeded.length === 1 ? "" : "s"}`,
            context: { failedCount: failed.length },
          })
        : null;

    return { requested: ids.length, succeeded, failed, batchId };
  });
}

// --- Review queue management ---------------------------------------------

/** Put a record into the review queue. */
export async function sendToReview(
  db: Db,
  contentId: string,
  reason: ReviewReason,
  options: { assignedTo?: string | null } = {},
): Promise<void> {
  const now = new Date();
  await db
    .update(contentItems)
    .set({ status: "needs_review", updatedAt: now })
    .where(
      and(
        eq(contentItems.id, contentId),
        inArray(contentItems.status, ["draft", "processed", "ai_classified", "failed", "discovered"]),
      ),
    );

  // One open assignment per record; re-queuing does not stack up duplicates.
  const existing = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviews)
    .where(and(eq(reviews.contentItemId, contentId), inArray(reviews.status, ["pending", "in_progress"])));

  if ((existing[0]?.n ?? 0) === 0) {
    await db.insert(reviews).values({
      id: uuidv7(),
      contentItemId: contentId,
      reason,
      status: "pending",
      assignedTo: options.assignedTo ?? null,
      assignedAt: options.assignedTo ? now : null,
    });
  }
}

/** Assign reviewers to a set of records (§16). */
export async function bulkAssignReviewer(
  context: AdminContext,
  contentIds: readonly string[],
  assignedTo: string | null,
): Promise<BulkResult> {
  requirePermission(context.actor, "review.assign");
  return bulkApply(context, contentIds, "review.assigned", async (tx, id) => {
    const now = new Date();
    const updated = await tx
      .update(reviews)
      .set({
        assignedTo,
        assignedBy: context.actor.id,
        assignedAt: now,
        status: assignedTo ? "in_progress" : "pending",
        updatedAt: now,
      })
      .where(and(eq(reviews.contentItemId, id), inArray(reviews.status, ["pending", "in_progress"])))
      .returning({ id: reviews.id });

    if (updated.length === 0) {
      await tx.insert(reviews).values({
        id: uuidv7(),
        contentItemId: id,
        reason: "manual",
        status: assignedTo ? "in_progress" : "pending",
        assignedTo,
        assignedBy: context.actor.id,
        assignedAt: now,
      });
    }
    return { ok: true, label: null };
  });
}

/**
 * Update the rights fields on a record (§22).
 *
 * Separated from general content editing because it needs its own permission
 * and its own audit action: a change from `unknown` to `restricted` withdraws
 * something from the public API, which is a materially different act from
 * fixing a typo in a description.
 */
export async function updateRights(
  context: AdminContext,
  contentId: string,
  patch: {
    readonly rightsStatus?: Parameters<typeof canPublish>[0]["rightsStatus"];
    readonly rightsOwner?: string | null;
    readonly attribution?: string | null;
    readonly permissionStatus?: string;
    readonly takedownStatus?: string;
    readonly legalReviewStatus?: string;
    readonly rightsNotes?: string | null;
  },
): Promise<void> {
  requirePermission(context.actor, "rights.update");

  await inTransaction(context, async (tx) => {
    const [before] = await tx.db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        status: contentItems.status,
        rightsStatus: contentItems.rightsStatus,
        rightsOwner: contentItems.rightsOwner,
        attribution: contentItems.attribution,
        permissionStatus: contentItems.permissionStatus,
        takedownStatus: contentItems.takedownStatus,
        legalReviewStatus: contentItems.legalReviewStatus,
        rightsNotes: contentItems.rightsNotes,
      })
      .from(contentItems)
      .where(eq(contentItems.id, contentId))
      .limit(1);
    if (!before) throw notFound("Content");

    const update: Record<string, unknown> = {
      ...patch,
      updatedBy: context.actor.id,
      updatedAt: new Date(),
    };

    // A rights hold on published content withdraws it. Doing this implicitly
    // is correct — the alternative is leaving restricted material live until
    // someone remembers to unpublish it separately.
    const newRights = patch.rightsStatus ?? before.rightsStatus;
    const nowBlocks = (
      ["pending_review", "restricted", "removed", "do_not_republish"] as const
    ).includes(newRights as never);
    if (nowBlocks && before.status === "published") {
      update.status = newRights === "removed" ? "removed" : "restricted";
      update.publishedAt = null;
      update.unpublishedAt = new Date();
    }

    await tx.db.update(contentItems).set(update).where(eq(contentItems.id, contentId));

    await recordAudit(tx.db, context, {
      action: "content.rights_changed",
      entityType: "content",
      entityId: contentId,
      entityLabel: before.title,
      before: {
        rightsStatus: before.rightsStatus,
        permissionStatus: before.permissionStatus,
        takedownStatus: before.takedownStatus,
        legalReviewStatus: before.legalReviewStatus,
      },
      after: patch as Record<string, unknown>,
      context: nowBlocks && before.status === "published" ? { withdrawnFromPublic: true } : {},
    });
  });
}

/** Kinds whose publish gate requires media, for the CMS to explain the rule. */
export const KINDS_REQUIRING_MEDIA = Object.keys(CONTENT_KIND_META).filter((k) => requiresMedia(k));

/** Mark a source as needing attention, from the review screen's "flag" action. */
export async function flagSource(
  context: AdminContext,
  sourceId: string,
  reason: string,
): Promise<void> {
  requirePermission(context.actor, "source.flag");
  await inTransaction(context, async (tx) => {
    const [row] = await tx.db
      .select({ id: sources.id, name: sources.name, health: sources.health })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (!row) throw notFound("Source");

    await tx.db
      .update(sources)
      .set({
        health: "requires_review",
        internalNotes: sql`coalesce(${sources.internalNotes} || E'\n\n', '') || ${`Flagged by ${context.actor.name}: ${reason.trim()}`}`,
        updatedBy: context.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, sourceId));

    await recordAudit(tx.db, context, {
      action: "source.flagged",
      entityType: "source",
      entityId: sourceId,
      entityLabel: row.name,
      context: { reason: reason.trim() },
    });
  });
}
