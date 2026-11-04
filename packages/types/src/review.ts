/**
 * Review and QA (§15).
 *
 * The review queue is the throughput bottleneck of the whole operation, so the
 * vocabulary here is shaped around keyboard-driven curation: every decision has
 * a single-key shortcut, and the shortcut map lives with the decision rather
 * than in the component that renders it.
 */

export const REVIEW_ASSIGNMENT_STATUSES = ["pending", "in_progress", "done", "released"] as const;
export type ReviewAssignmentStatus = (typeof REVIEW_ASSIGNMENT_STATUSES)[number];

export const REVIEW_DECISIONS = ["approved", "rejected", "changes_requested", "escalated"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ReviewDecisionMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "success" | "danger" | "warning" | "info";
  /** Single-key shortcut in the review interface. */
  readonly shortcut: string;
  /** Status the content moves to. */
  readonly resultingStatus: "approved" | "rejected" | "needs_review" | "restricted";
  /** A written reason is mandatory. */
  readonly requiresNote: boolean;
}

export const REVIEW_DECISION_META: Record<ReviewDecision, ReviewDecisionMeta> = {
  approved: {
    label: "Approve",
    description: "Good to publish. Metadata and classification are correct.",
    tone: "success",
    shortcut: "a",
    resultingStatus: "approved",
    requiresNote: false,
  },
  rejected: {
    label: "Reject",
    description: "Not going to be used. A reason is required so the record explains itself later.",
    tone: "danger",
    shortcut: "r",
    resultingStatus: "rejected",
    requiresNote: true,
  },
  changes_requested: {
    label: "Needs changes",
    description: "Send back for correction or recapture, with a note on what is wrong.",
    tone: "warning",
    shortcut: "c",
    resultingStatus: "needs_review",
    requiresNote: true,
  },
  escalated: {
    label: "Escalate",
    description: "A rights or judgement question someone else needs to answer. Holds the record back.",
    tone: "info",
    shortcut: "e",
    resultingStatus: "restricted",
    requiresNote: true,
  },
};

/**
 * Keyboard map for the review screen (§15 "build keyboard-friendly review
 * interactions", §28).
 *
 * Declared as data so the interface and its help overlay cannot drift apart,
 * and so a shortcut collision is visible in one place.
 */
export const REVIEW_SHORTCUTS = [
  { keys: ["a"], action: "approve", label: "Approve" },
  { keys: ["r"], action: "reject", label: "Reject" },
  { keys: ["c"], action: "request_changes", label: "Needs changes" },
  { keys: ["e"], action: "escalate", label: "Escalate" },
  { keys: ["j", "ArrowDown"], action: "next", label: "Next item" },
  { keys: ["k", "ArrowUp"], action: "previous", label: "Previous item" },
  { keys: ["x"], action: "toggle_select", label: "Select / deselect" },
  { keys: ["p"], action: "publish", label: "Publish (if approved)" },
  { keys: ["t"], action: "focus_taxonomy", label: "Jump to classification" },
  { keys: ["n"], action: "focus_notes", label: "Jump to internal notes" },
  { keys: ["m"], action: "open_media", label: "Open media at full size" },
  { keys: ["u"], action: "undo", label: "Undo last decision" },
  { keys: ["?"], action: "help", label: "Show shortcuts" },
  { keys: ["Escape"], action: "close", label: "Close overlay" },
] as const;

export type ReviewShortcutAction = (typeof REVIEW_SHORTCUTS)[number]["action"];

/** Why an item entered the review queue. Drives queue grouping. */
export const REVIEW_REASONS = [
  "new_capture",
  "recapture_changed",
  "low_confidence_classification",
  "missing_metadata",
  "duplicate_suspected",
  "rights_question",
  "changes_requested",
  "manual",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_REASON_META: Record<ReviewReason, { label: string; description: string }> = {
  new_capture: { label: "New capture", description: "Captured for the first time and never reviewed." },
  recapture_changed: {
    label: "Changed since last capture",
    description: "A recapture found different content. Worth checking what moved.",
  },
  low_confidence_classification: {
    label: "Low-confidence classification",
    description: "The model was unsure, so nothing was applied automatically.",
  },
  missing_metadata: {
    label: "Missing metadata",
    description: "Required fields such as title or source are empty.",
  },
  duplicate_suspected: {
    label: "Possible duplicate",
    description: "Looks visually or structurally identical to an existing record.",
  },
  rights_question: { label: "Rights question", description: "The rights position needs a decision." },
  changes_requested: {
    label: "Changes requested",
    description: "A reviewer sent it back and it has been updated since.",
  },
  manual: { label: "Sent to review", description: "Someone put it in the queue by hand." },
};
