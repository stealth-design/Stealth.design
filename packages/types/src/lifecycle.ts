/**
 * Content lifecycle (§15, §23).
 *
 * One status enum spans the whole pipeline, from the moment a URL is
 * discovered to the moment a record is published, plus the failure and rights
 * branches. Keeping it as a single enum means a content record has exactly one
 * answer to "where is this?", which is what the dashboard, the review queue
 * and the "needs attention" screen all read.
 *
 * The transition map is the authority on what a given record can do next. The
 * CMS renders its action buttons from it, and the API re-checks it server side,
 * so an operator can never drive a record into a state the pipeline cannot
 * represent.
 */

export const LIFECYCLE_STATUSES = [
  "draft",
  "discovered",
  "queued",
  "capturing",
  "processed",
  "ai_classified",
  "needs_review",
  "approved",
  "published",
  "rejected",
  "archived",
  "failed",
  "restricted",
  "removed",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** Badge tone, so status colour is decided once rather than per screen. */
export type StatusTone = "neutral" | "info" | "progress" | "warning" | "success" | "danger";

export type StatusGroup = "pipeline" | "review" | "live" | "closed" | "attention";

export interface LifecycleStatusMeta {
  readonly label: string;
  /** Shown as help text in the CMS and in the log viewer. */
  readonly description: string;
  readonly tone: StatusTone;
  readonly group: StatusGroup;
  /** Visible on the public API/frontend. Exactly one status qualifies. */
  readonly isPublic: boolean;
  /** Counts toward the "needs human attention" figure on the dashboard. */
  readonly needsAttention: boolean;
  /** The machine is currently working on it; humans should wait. */
  readonly isInFlight: boolean;
}

export const LIFECYCLE_STATUS_META: Record<LifecycleStatus, LifecycleStatusMeta> = {
  draft: {
    label: "Draft",
    description: "Created by hand in the CMS and not yet submitted to the pipeline.",
    tone: "neutral",
    group: "pipeline",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
  discovered: {
    label: "Discovered",
    description: "A URL we know about but have not queued for capture yet.",
    tone: "neutral",
    group: "pipeline",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
  queued: {
    label: "Queued",
    description: "Waiting for a capture worker to pick it up.",
    tone: "info",
    group: "pipeline",
    isPublic: false,
    needsAttention: false,
    isInFlight: true,
  },
  capturing: {
    label: "Capturing",
    description: "A worker is fetching the page and taking screenshots right now.",
    tone: "progress",
    group: "pipeline",
    isPublic: false,
    needsAttention: false,
    isInFlight: true,
  },
  processed: {
    label: "Processed",
    description: "Captured successfully; media stored and metadata extracted.",
    tone: "info",
    group: "pipeline",
    isPublic: false,
    needsAttention: false,
    isInFlight: true,
  },
  ai_classified: {
    label: "AI classified",
    description: "Classification suggestions have been attached and are awaiting a human.",
    tone: "info",
    group: "pipeline",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
  needs_review: {
    label: "Needs review",
    description: "In the review queue, waiting for a person to approve or reject it.",
    tone: "warning",
    group: "review",
    isPublic: false,
    needsAttention: true,
    isInFlight: false,
  },
  approved: {
    label: "Approved",
    description: "A reviewer signed off. Ready to publish, but not public yet.",
    tone: "success",
    group: "review",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
  published: {
    label: "Published",
    description: "Live on the public API and the public site.",
    tone: "success",
    group: "live",
    isPublic: true,
    needsAttention: false,
    isInFlight: false,
  },
  rejected: {
    label: "Rejected",
    description: "A reviewer declined it. Kept for the record; never published.",
    tone: "danger",
    group: "closed",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
  archived: {
    label: "Archived",
    description: "Retired from active use. Hidden from default views and from the public API.",
    tone: "neutral",
    group: "closed",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
  failed: {
    label: "Failed",
    description: "A pipeline step errored. Retryable — see the job log for the reason.",
    tone: "danger",
    group: "attention",
    isPublic: false,
    needsAttention: true,
    isInFlight: false,
  },
  restricted: {
    label: "Restricted",
    description:
      "Withheld pending a rights or permission question. Blocked from publishing regardless of review state.",
    tone: "danger",
    group: "attention",
    isPublic: false,
    needsAttention: true,
    isInFlight: false,
  },
  removed: {
    label: "Removed",
    description: "Taken down on request. Retained only as a record that it existed.",
    tone: "danger",
    group: "closed",
    isPublic: false,
    needsAttention: false,
    isInFlight: false,
  },
};

/**
 * Allowed status transitions.
 *
 * Two rules are structural rather than conventional:
 *   - `published` is only reachable from `approved`. Nothing skips review.
 *   - `restricted` and `removed` are reachable from *every* status, because a
 *     rights or takedown question can arrive at any point (§23 rights branch).
 */
const RIGHTS_BRANCH: readonly LifecycleStatus[] = ["restricted", "removed"];

export const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, readonly LifecycleStatus[]> = {
  draft: ["queued", "needs_review", "archived", ...RIGHTS_BRANCH],
  discovered: ["queued", "archived", "rejected", ...RIGHTS_BRANCH],
  queued: ["capturing", "failed", "archived", ...RIGHTS_BRANCH],
  capturing: ["processed", "failed", ...RIGHTS_BRANCH],
  processed: ["ai_classified", "needs_review", "failed", ...RIGHTS_BRANCH],
  ai_classified: ["needs_review", "failed", ...RIGHTS_BRANCH],
  needs_review: ["approved", "rejected", "draft", "queued", "archived", ...RIGHTS_BRANCH],
  approved: ["published", "needs_review", "archived", ...RIGHTS_BRANCH],
  published: ["approved", "archived", ...RIGHTS_BRANCH],
  rejected: ["needs_review", "archived", ...RIGHTS_BRANCH],
  archived: ["draft", "needs_review", ...RIGHTS_BRANCH],
  failed: ["queued", "needs_review", "archived", ...RIGHTS_BRANCH],
  restricted: ["needs_review", "archived", "removed"],
  removed: ["archived"],
};

export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: LifecycleStatus): readonly LifecycleStatus[] {
  return LIFECYCLE_TRANSITIONS[from];
}

/** The happy path, in order — used to draw pipeline progress. */
export const PIPELINE_ORDER: readonly LifecycleStatus[] = [
  "discovered",
  "queued",
  "capturing",
  "processed",
  "ai_classified",
  "needs_review",
  "approved",
  "published",
];

export const PUBLIC_STATUSES = LIFECYCLE_STATUSES.filter((s) => LIFECYCLE_STATUS_META[s].isPublic);
export const ATTENTION_STATUSES = LIFECYCLE_STATUSES.filter(
  (s) => LIFECYCLE_STATUS_META[s].needsAttention,
);
export const IN_FLIGHT_STATUSES = LIFECYCLE_STATUSES.filter(
  (s) => LIFECYCLE_STATUS_META[s].isInFlight,
);

export function isLifecycleStatus(value: unknown): value is LifecycleStatus {
  return typeof value === "string" && (LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses a re-capture is allowed to move.
 *
 * These are the pre-review pipeline states: the machine put the record there
 * and the machine may move it again. Everything from `needs_review` onward
 * belongs to a person — a reviewer put it in the queue, approved it, rejected
 * it, or placed a rights hold — and a re-capture must not overwrite that.
 *
 * Getting this wrong is quietly destructive rather than loudly broken. A
 * nightly refresh that reset `needs_review` back to a pipeline state would take
 * items *out* of the review queue while leaving their open review rows behind:
 * the backlog count would fall, the work would still be outstanding, and
 * nothing would report an error.
 */
export const RECAPTURE_ADVANCEABLE_STATUSES: readonly LifecycleStatus[] = [
  "draft",
  "discovered",
  "queued",
  "capturing",
  "processed",
  "ai_classified",
  "failed",
];

/**
 * The status a content record should hold after a re-capture.
 *
 * Returns the existing status unchanged whenever a human owns it.
 */
export function statusAfterRecapture(
  existing: LifecycleStatus,
  captureSucceeded: boolean,
): LifecycleStatus {
  if (!RECAPTURE_ADVANCEABLE_STATUSES.includes(existing)) return existing;
  return captureSucceeded ? "processed" : "failed";
}
