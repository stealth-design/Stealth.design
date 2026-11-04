/**
 * Rights and provenance vocabulary (§22).
 *
 * These are OPERATIONAL LABELS recording what our team knows and has decided
 * about a piece of content. They are not legal determinations, and nothing in
 * this system computes one. There is deliberately no status meaning "cleared"
 * or "legally safe": the closest available label is `reference_use`, which
 * records how we are treating an item, not a conclusion about whether we may.
 *
 * The one automated behaviour is restrictive: `blocksPublishing` states stop a
 * record from going public even when a reviewer has approved it. Publishing is
 * gated by the conjunction of review state AND rights state, never by either
 * alone.
 */

export const RIGHTS_STATUSES = [
  "unknown",
  "pending_review",
  "permissioned",
  "licensed",
  "public_submission",
  "reference_use",
  "restricted",
  "removed",
  "do_not_republish",
] as const;

export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

export interface RightsStatusMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "warning" | "success" | "danger";
  /** Publishing is refused while a record carries this status. */
  readonly blocksPublishing: boolean;
  /** Surfaced in the "needs attention" queue. */
  readonly needsAttention: boolean;
}

export const RIGHTS_STATUS_META: Record<RightsStatus, RightsStatusMeta> = {
  unknown: {
    label: "Unknown",
    description: "No rights information has been recorded yet. The default for new captures.",
    tone: "neutral",
    blocksPublishing: false,
    needsAttention: false,
  },
  pending_review: {
    label: "Pending review",
    description: "Flagged for someone to look at the rights position before this goes further.",
    tone: "warning",
    blocksPublishing: true,
    needsAttention: true,
  },
  permissioned: {
    label: "Permissioned",
    description: "The owner gave us explicit permission. Record who, when and where in the notes.",
    tone: "success",
    blocksPublishing: false,
    needsAttention: false,
  },
  licensed: {
    label: "Licensed",
    description: "Covered by a licence we hold. Record the licence reference in the notes.",
    tone: "success",
    blocksPublishing: false,
    needsAttention: false,
  },
  public_submission: {
    label: "Public submission",
    description: "Submitted to us by someone claiming the right to do so.",
    tone: "info",
    blocksPublishing: false,
    needsAttention: false,
  },
  reference_use: {
    label: "Reference use",
    description:
      "How we are treating this item operationally: as an attributed reference. An internal handling label, not a legal conclusion.",
    tone: "info",
    blocksPublishing: false,
    needsAttention: false,
  },
  restricted: {
    label: "Restricted",
    description: "Held back by our own decision. Not to be published while this is set.",
    tone: "danger",
    blocksPublishing: true,
    needsAttention: true,
  },
  removed: {
    label: "Removed",
    description: "Taken down. Retained only as a record that it existed.",
    tone: "danger",
    blocksPublishing: true,
    needsAttention: false,
  },
  do_not_republish: {
    label: "Do not republish",
    description: "Permanently excluded from publishing, including future recaptures.",
    tone: "danger",
    blocksPublishing: true,
    needsAttention: false,
  },
};

export const PUBLISH_BLOCKING_RIGHTS_STATUSES = RIGHTS_STATUSES.filter(
  (s) => RIGHTS_STATUS_META[s].blocksPublishing,
);

export function rightsBlocksPublishing(status: RightsStatus): boolean {
  return RIGHTS_STATUS_META[status].blocksPublishing;
}

/** Where a permission conversation with an owner currently stands. */
export const PERMISSION_STATUSES = [
  "not_requested",
  "requested",
  "granted",
  "declined",
  "expired",
  "not_applicable",
] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export const PERMISSION_STATUS_LABELS: Record<PermissionStatus, string> = {
  not_requested: "Not requested",
  requested: "Requested",
  granted: "Granted",
  declined: "Declined",
  expired: "Expired",
  not_applicable: "Not applicable",
};

/** Takedown request tracking. */
export const TAKEDOWN_STATUSES = ["none", "received", "in_progress", "actioned", "disputed"] as const;
export type TakedownStatus = (typeof TAKEDOWN_STATUSES)[number];

export const TAKEDOWN_STATUS_LABELS: Record<TakedownStatus, string> = {
  none: "None",
  received: "Request received",
  in_progress: "Being actioned",
  actioned: "Actioned",
  disputed: "Disputed",
};

/**
 * Internal review workflow state.
 *
 * Note the absence of a "cleared" or "approved" terminal state. `reviewed`
 * means a person has looked and written down what they found; it does not
 * assert an outcome. Any conclusion lives in the free-text notes attached to
 * the record, authored by a person.
 */
export const LEGAL_REVIEW_STATUSES = ["not_started", "queued", "in_review", "reviewed", "escalated"] as const;
export type LegalReviewStatus = (typeof LEGAL_REVIEW_STATUSES)[number];

export const LEGAL_REVIEW_STATUS_LABELS: Record<LegalReviewStatus, string> = {
  not_started: "Not started",
  queued: "Queued for review",
  in_review: "In review",
  reviewed: "Reviewed — see notes",
  escalated: "Escalated",
};

/** What robots.txt said the last time we asked. */
export const ROBOTS_STATUSES = [
  "unknown",
  "allowed",
  "disallowed",
  "partial",
  "unreachable",
  "overridden",
] as const;
export type RobotsStatus = (typeof ROBOTS_STATUSES)[number];

export const ROBOTS_STATUS_META: Record<RobotsStatus, { label: string; description: string }> = {
  unknown: { label: "Unknown", description: "We have not checked robots.txt for this host yet." },
  allowed: { label: "Allowed", description: "robots.txt permits our user agent on the paths we captured." },
  disallowed: { label: "Disallowed", description: "robots.txt asks our user agent not to fetch these paths." },
  partial: { label: "Partial", description: "Some paths on this host are allowed and some are not." },
  unreachable: { label: "Unreachable", description: "robots.txt could not be fetched; treated as unknown." },
  overridden: {
    label: "Overridden",
    description: "An operator explicitly chose to ignore robots.txt for this job. Recorded in the audit log.",
  },
};
