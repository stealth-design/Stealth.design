/**
 * The publishing gate.
 *
 * This is the load-bearing rule of the whole product: the CMS is the source of
 * truth, and nothing reaches the public API or the public frontend unless a
 * CMS record says it may (§"CORE PRODUCT PRINCIPLE", §18, §19).
 *
 * `canPublish` answers "may this become public?" and `isPubliclyVisible`
 * answers "is this public right now?". Both are pure functions of a record's
 * own fields, which matters for three reasons:
 *
 *   1. There is exactly one implementation. The publish action, the bulk
 *      publish action, the public API's row filter and the frontend's type
 *      contract all call the same function, so they cannot disagree.
 *   2. It is trivially testable, and it is tested exhaustively across every
 *      status × rights-status combination.
 *   3. Both are *conjunctions*, not disjunctions. Review state alone is never
 *      enough, and rights state alone is never enough. A reviewer's approval
 *      cannot override a rights hold, and a clean rights status cannot skip
 *      review.
 *
 * The public API additionally re-applies `publishedContentFilter` at the SQL
 * level, so a bug in application code cannot leak a draft. Defence in depth:
 * the query cannot select it, and the serialiser would refuse it.
 */
import { type LifecycleStatus, LIFECYCLE_STATUS_META } from "./lifecycle.js";
import { type RightsStatus, RIGHTS_STATUS_META } from "./rights.js";

/** The minimum a record must carry to be considered for publication. */
export interface PublishabilityInput {
  readonly status: LifecycleStatus;
  readonly rightsStatus: RightsStatus;
  /** Publishing a record with no title produces an unusable public page. */
  readonly title: string | null;
  readonly slug: string | null;
  /** Whether a media asset is attached. Required for visual content kinds. */
  readonly hasPrimaryMedia: boolean;
  /** Content kinds that are meaningful without an image (flow, interaction). */
  readonly requiresMedia: boolean;
  /** Set when a reviewer has signed off. */
  readonly approvedAt: Date | null;
  readonly approvedBy: string | null;
}

export const PUBLISH_BLOCKER_CODES = {
  NOT_APPROVED: "NOT_APPROVED",
  NO_APPROVAL_RECORD: "NO_APPROVAL_RECORD",
  RIGHTS_HOLD: "RIGHTS_HOLD",
  MISSING_TITLE: "MISSING_TITLE",
  MISSING_SLUG: "MISSING_SLUG",
  MISSING_MEDIA: "MISSING_MEDIA",
  ALREADY_PUBLISHED: "ALREADY_PUBLISHED",
} as const;
export type PublishBlockerCode = (typeof PUBLISH_BLOCKER_CODES)[keyof typeof PUBLISH_BLOCKER_CODES];

export interface PublishBlocker {
  readonly code: PublishBlockerCode;
  /** Shown next to the disabled Publish button, so the operator knows why. */
  readonly message: string;
  /** Which CMS field or action fixes it. */
  readonly field?: string;
}

export interface PublishabilityResult {
  readonly allowed: boolean;
  readonly blockers: readonly PublishBlocker[];
}

/**
 * May this record be published?
 *
 * `published` is only reachable from `approved` (see `LIFECYCLE_TRANSITIONS`),
 * which is enforced here rather than left to the caller.
 */
export function canPublish(input: PublishabilityInput): PublishabilityResult {
  const blockers: PublishBlocker[] = [];

  if (input.status === "published") {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.ALREADY_PUBLISHED,
      message: "This is already published.",
    });
  } else if (input.status !== "approved") {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.NOT_APPROVED,
      message: `Only approved content can be published. This is ${LIFECYCLE_STATUS_META[input.status].label.toLowerCase()}.`,
      field: "status",
    });
  }

  // An `approved` status with no approval record means the status was set by
  // something other than a review decision. Refuse it: the audit trail must be
  // able to name who signed this off.
  if (input.status === "approved" && (input.approvedAt === null || input.approvedBy === null)) {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.NO_APPROVAL_RECORD,
      message: "This is marked approved but has no recorded approver. Re-approve it through review.",
      field: "status",
    });
  }

  if (RIGHTS_STATUS_META[input.rightsStatus].blocksPublishing) {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.RIGHTS_HOLD,
      message: `Rights status is "${RIGHTS_STATUS_META[input.rightsStatus].label}", which blocks publishing.`,
      field: "rightsStatus",
    });
  }

  if (input.title === null || input.title.trim().length === 0) {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.MISSING_TITLE,
      message: "Give this a title before publishing.",
      field: "title",
    });
  }

  if (input.slug === null || input.slug.trim().length === 0) {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.MISSING_SLUG,
      message: "This needs a slug to have a public URL.",
      field: "slug",
    });
  }

  if (input.requiresMedia && !input.hasPrimaryMedia) {
    blockers.push({
      code: PUBLISH_BLOCKER_CODES.MISSING_MEDIA,
      message: "Attach a primary image before publishing.",
      field: "primaryMediaId",
    });
  }

  return { allowed: blockers.length === 0, blockers };
}

/**
 * Is this record public right now?
 *
 * Used by the public API serialiser as a final assertion, and by the CMS to
 * show whether something is live. Intentionally strict and intentionally
 * boring: `published` status AND a rights status that does not block.
 */
export function isPubliclyVisible(input: {
  readonly status: LifecycleStatus;
  readonly rightsStatus: RightsStatus;
}): boolean {
  return (
    LIFECYCLE_STATUS_META[input.status].isPublic && !RIGHTS_STATUS_META[input.rightsStatus].blocksPublishing
  );
}

/**
 * The status/rights pairs the public API is allowed to select.
 *
 * Returned as data so the database layer can build a WHERE clause from it. It
 * is derived from the same metadata `isPubliclyVisible` reads, so the SQL
 * filter and the application check cannot drift.
 */
export function publishedContentFilter(): {
  readonly statuses: readonly LifecycleStatus[];
  readonly excludedRightsStatuses: readonly RightsStatus[];
} {
  const statuses = (Object.keys(LIFECYCLE_STATUS_META) as LifecycleStatus[]).filter(
    (s) => LIFECYCLE_STATUS_META[s].isPublic,
  );
  const excludedRightsStatuses = (Object.keys(RIGHTS_STATUS_META) as RightsStatus[]).filter(
    (r) => RIGHTS_STATUS_META[r].blocksPublishing,
  );
  return { statuses, excludedRightsStatuses };
}

/**
 * Fields that must never appear in a public API response (§19).
 *
 * Enforced by the public serialisers, which build their output from an
 * allowlist of fields rather than by deleting these from a full row —
 * allowlisting fails closed when a new internal column is added, whereas a
 * denylist silently leaks it.
 *
 * This list exists so that the leak test has something to assert against: it
 * walks every public response shape and fails if any of these names appear.
 */
export const NEVER_PUBLIC_FIELDS: readonly string[] = [
  "internalNotes",
  "reviewNotes",
  "rightsNotes",
  "legalReviewStatus",
  "permissionStatus",
  "takedownStatus",
  "notes",
  "createdBy",
  "updatedBy",
  "approvedBy",
  "publishedBy",
  "reviewedBy",
  "assignedTo",
  "crawlJobId",
  "crawlJobItemId",
  "captureId",
  "leaseToken",
  "leasedBy",
  "errorMessage",
  "errorCode",
  "resultSummary",
  "storageKey",
  "storageBucket",
  "storageDriver",
  "scanStatus",
  "scanNotes",
  "passwordHash",
  "tokenHash",
  "userAgent",
  "ip",
  "consecutiveFailures",
  "robotsStatus",
  "crawlStatus",
  "health",
];
