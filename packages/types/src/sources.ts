/**
 * Sources (§3, §17).
 *
 * A Source is the product or site we are studying — Stripe, Linear, Duolingo —
 * and it is the operational anchor of the whole system. Pages, screens, flows,
 * captures, media and versions all point at one, which is what makes "show me
 * everything we have captured from this product" a single indexed query.
 *
 * Health (§17) is derived from capture outcomes rather than set by hand, so the
 * "needs recapture" list is always true rather than as-remembered.
 */

export const SOURCE_TYPES = ["website", "app", "hybrid", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  website: "Website",
  app: "App",
  hybrid: "Website + App",
  other: "Other",
};

export const SOURCE_HEALTH_STATUSES = [
  "unknown",
  "healthy",
  "changed",
  "needs_recapture",
  "unavailable",
  "blocked",
  "redirected",
  "requires_review",
  "archived",
] as const;
export type SourceHealth = (typeof SOURCE_HEALTH_STATUSES)[number];

export interface SourceHealthMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "warning" | "success" | "danger";
  readonly needsAttention: boolean;
}

export const SOURCE_HEALTH_META: Record<SourceHealth, SourceHealthMeta> = {
  unknown: {
    label: "Unknown",
    description: "Never captured, so there is nothing to judge yet.",
    tone: "neutral",
    needsAttention: false,
  },
  healthy: {
    label: "Healthy",
    description: "Last capture succeeded and the content looked unchanged.",
    tone: "success",
    needsAttention: false,
  },
  changed: {
    label: "Changed",
    description: "The last capture succeeded but the content hash moved. Worth a look.",
    tone: "info",
    needsAttention: true,
  },
  needs_recapture: {
    label: "Needs recapture",
    description: "It has been longer than this source's capture interval since we last looked.",
    tone: "warning",
    needsAttention: true,
  },
  unavailable: {
    label: "Unavailable",
    description: "Recent captures failed to load the site at all.",
    tone: "danger",
    needsAttention: true,
  },
  blocked: {
    label: "Blocked",
    description: "The site refuses our captures — robots.txt, a 403, or bot protection.",
    tone: "danger",
    needsAttention: true,
  },
  redirected: {
    label: "Redirected",
    description: "The canonical URL now redirects elsewhere. The source may have moved or been acquired.",
    tone: "warning",
    needsAttention: true,
  },
  requires_review: {
    label: "Requires review",
    description: "Flagged by an operator for a person to look at.",
    tone: "warning",
    needsAttention: true,
  },
  archived: {
    label: "Archived",
    description: "Retired. Excluded from scheduling and from default views.",
    tone: "neutral",
    needsAttention: false,
  },
};

export const ATTENTION_SOURCE_HEALTH = SOURCE_HEALTH_STATUSES.filter(
  (s) => SOURCE_HEALTH_META[s].needsAttention,
);

/** Consecutive failures before health is downgraded to `unavailable`. */
export const SOURCE_FAILURE_THRESHOLD = 3;

/**
 * Derive health from capture history.
 *
 * Kept as a pure function so the same rule runs when a capture completes, when
 * a nightly sweep re-evaluates staleness, and in tests. Operator-set states
 * (`requires_review`, `archived`) win over derived ones: a person's judgement
 * is not overwritten by a successful fetch.
 */
export function deriveSourceHealth(input: {
  readonly current: SourceHealth;
  readonly consecutiveFailures: number;
  readonly lastResponseStatus: number | null;
  readonly lastCapturedAt: Date | null;
  readonly lastSuccessfulCaptureAt: Date | null;
  readonly captureIntervalDays: number | null;
  readonly lastChangedAt: Date | null;
  readonly robotsDisallowed: boolean;
  readonly canonicalRedirected: boolean;
  readonly now?: Date;
}): SourceHealth {
  if (input.current === "archived" || input.current === "requires_review") return input.current;

  const now = input.now ?? new Date();

  if (input.robotsDisallowed) return "blocked";
  if (input.lastResponseStatus === 403 || input.lastResponseStatus === 429) return "blocked";
  if (input.consecutiveFailures >= SOURCE_FAILURE_THRESHOLD) return "unavailable";
  if (input.canonicalRedirected) return "redirected";
  if (input.lastSuccessfulCaptureAt === null) return "unknown";

  if (input.captureIntervalDays !== null && input.captureIntervalDays > 0) {
    const dueAt = input.lastSuccessfulCaptureAt.getTime() + input.captureIntervalDays * 86_400_000;
    if (now.getTime() > dueAt) return "needs_recapture";
  }

  // "Changed" only counts when the change is newer than the last capture we
  // have already looked at, so it does not stick forever after one diff.
  if (
    input.lastChangedAt !== null &&
    input.lastChangedAt.getTime() >= input.lastSuccessfulCaptureAt.getTime()
  ) {
    return "changed";
  }

  return "healthy";
}

export function nextScheduledCapture(
  lastSuccessfulCaptureAt: Date | null,
  captureIntervalDays: number | null,
): Date | null {
  if (lastSuccessfulCaptureAt === null || captureIntervalDays === null || captureIntervalDays <= 0) {
    return null;
  }
  return new Date(lastSuccessfulCaptureAt.getTime() + captureIntervalDays * 86_400_000);
}
