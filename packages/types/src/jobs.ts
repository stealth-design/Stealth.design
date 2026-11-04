/**
 * Crawl jobs (§4, §5, §6, §7).
 *
 * `crawlJobConfigSchema` is the contract between the CMS's job configuration
 * screen, the stored `crawl_jobs.config` column, and the worker. All three read
 * the same Zod schema, so a job that validates in the UI is a job the worker
 * understands.
 *
 * Every bound has a low default and a hard maximum. §7 requires that a job can
 * never expand indefinitely, and the way that is guaranteed here is that the
 * defaults do not crawl at all: `crawlInternalLinks` is false, so submitting a
 * URL captures exactly that URL. Discovery is something an operator turns on
 * deliberately, and even then `maxDepth`, `maxPagesPerDomain` and `maxPagesTotal`
 * all apply simultaneously — the run stops at whichever is reached first.
 */
import { z } from "zod";
import { DEVICE_PROFILE_KEYS, INTERACTION_TYPES } from "./capture.js";
import { MODULE_KEYS } from "./modules.js";

// --- Hard ceilings --------------------------------------------------------
// A job's configuration may lower these but the schema refuses to exceed them.
// The worker independently clamps against its own env limits, so a compromised
// or buggy control plane still cannot ask for an unbounded crawl.

export const JOB_LIMITS = {
  maxUrlsPerJob: 5_000,
  maxDepth: 5,
  maxPagesPerDomain: 500,
  maxPagesTotal: 5_000,
  maxDiscoveredUrls: 25_000,
  maxAttempts: 5,
  maxRequestsPerMinutePerDomain: 120,
  maxConcurrencyPerDomain: 4,
  maxInteractionsPerPage: 20,
  navigationTimeoutMs: 120_000,
  itemTimeoutMs: 600_000,
} as const;

export const JOB_DEFAULTS = {
  // One hop. Discovery with depth 0 would only ever return the URL that was
  // submitted, which is a fetch, not a discovery.
  maxDepth: 1,
  maxPagesPerDomain: 25,
  maxPagesTotal: 100,
  maxAttempts: 3,
  requestsPerMinutePerDomain: 20,
  concurrencyPerDomain: 1,
  navigationTimeoutMs: 30_000,
  itemTimeoutMs: 120_000,
} as const;

// --- Job status -----------------------------------------------------------

export const JOB_STATUSES = [
  "draft",
  "validating",
  "ready",
  "queued",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "completed_with_errors",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobStatusMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "progress" | "warning" | "success" | "danger";
  /** Work can still be leased from this job. */
  readonly isActive: boolean;
  /** No further state changes expected without operator action. */
  readonly isTerminal: boolean;
}

export const JOB_STATUS_META: Record<JobStatus, JobStatusMeta> = {
  draft: {
    label: "Draft",
    description: "Being set up. URLs may still be added or removed.",
    tone: "neutral",
    isActive: false,
    isTerminal: false,
  },
  validating: {
    label: "Validating",
    description: "Checking the submitted URLs for validity, duplicates and blocks.",
    tone: "progress",
    isActive: false,
    isTerminal: false,
  },
  ready: {
    label: "Ready",
    description: "Validated and configured. Waiting for someone to start it.",
    tone: "info",
    isActive: false,
    isTerminal: false,
  },
  queued: {
    label: "Queued",
    description: "Started, waiting for a worker to lease its first item.",
    tone: "info",
    isActive: true,
    isTerminal: false,
  },
  running: {
    label: "Running",
    description: "Workers are actively capturing.",
    tone: "progress",
    isActive: true,
    isTerminal: false,
  },
  paused: {
    label: "Paused",
    description: "No new items will be leased. Items already in flight finish normally.",
    tone: "warning",
    isActive: false,
    isTerminal: false,
  },
  cancelling: {
    label: "Cancelling",
    description: "Cancellation requested. Waiting for in-flight items to stop.",
    tone: "warning",
    isActive: false,
    isTerminal: false,
  },
  cancelled: {
    label: "Cancelled",
    description: "Stopped by an operator. Completed items and their media are kept.",
    tone: "neutral",
    isActive: false,
    isTerminal: true,
  },
  completed: {
    label: "Completed",
    description: "Every item finished successfully.",
    tone: "success",
    isActive: false,
    isTerminal: true,
  },
  completed_with_errors: {
    label: "Completed with errors",
    description: "Finished, but some items failed. They can be retried individually or in bulk.",
    tone: "warning",
    isActive: false,
    isTerminal: true,
  },
  failed: {
    label: "Failed",
    description: "The job itself could not run.",
    tone: "danger",
    isActive: false,
    isTerminal: true,
  },
};

export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  draft: ["validating", "ready", "cancelled"],
  validating: ["ready", "failed", "cancelled"],
  ready: ["queued", "draft", "cancelled"],
  queued: ["running", "paused", "cancelling", "failed"],
  running: ["paused", "cancelling", "completed", "completed_with_errors", "failed"],
  paused: ["running", "cancelling", "cancelled"],
  cancelling: ["cancelled"],
  cancelled: ["ready"],
  completed: ["ready"],
  completed_with_errors: ["ready", "running"],
  failed: ["ready"],
};

export function canJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const ACTIVE_JOB_STATUSES = JOB_STATUSES.filter((s) => JOB_STATUS_META[s].isActive);

// --- Queue item status ----------------------------------------------------

/**
 * The state of one URL inside a job. This is the durable queue's row state;
 * `leased` is what makes crash recovery work — see §6 "do not lose state if the
 * worker crashes". A leased item whose lease expires without a heartbeat is
 * returned to `pending` by the reaper, not lost.
 */
export const JOB_ITEM_STATUSES = [
  "pending",
  "leased",
  "running",
  "succeeded",
  "failed",
  "skipped_duplicate",
  "skipped_limit",
  "blocked",
  "cancelled",
  "dead_letter",
] as const;
export type JobItemStatus = (typeof JOB_ITEM_STATUSES)[number];

export interface JobItemStatusMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "progress" | "warning" | "success" | "danger";
  readonly isTerminal: boolean;
  /** Eligible for "retry failed". */
  readonly isRetryable: boolean;
}

export const JOB_ITEM_STATUS_META: Record<JobItemStatus, JobItemStatusMeta> = {
  pending: {
    label: "Queued",
    description: "Waiting to be picked up.",
    tone: "neutral",
    isTerminal: false,
    isRetryable: false,
  },
  leased: {
    label: "Assigned",
    description: "Handed to a worker, which has not started yet.",
    tone: "info",
    isTerminal: false,
    isRetryable: false,
  },
  running: {
    label: "Capturing",
    description: "A worker is on it now.",
    tone: "progress",
    isTerminal: false,
    isRetryable: false,
  },
  succeeded: {
    label: "Captured",
    description: "Captured and stored.",
    tone: "success",
    isTerminal: true,
    isRetryable: true,
  },
  failed: {
    label: "Failed",
    description: "All attempts failed. Can be retried.",
    tone: "danger",
    isTerminal: true,
    isRetryable: true,
  },
  skipped_duplicate: {
    label: "Skipped — duplicate",
    description: "Already captured with identical content, so a version record was made instead.",
    tone: "neutral",
    isTerminal: true,
    isRetryable: true,
  },
  skipped_limit: {
    label: "Skipped — limit",
    description: "A job limit (depth, pages per domain, total pages) was reached before this item ran.",
    tone: "warning",
    isTerminal: true,
    isRetryable: true,
  },
  blocked: {
    label: "Blocked",
    description: "Refused by our own safety rules: robots.txt, SSRF protection, or the URL allowlist.",
    tone: "danger",
    isTerminal: true,
    isRetryable: false,
  },
  cancelled: {
    label: "Cancelled",
    description: "The job was cancelled before this item ran.",
    tone: "neutral",
    isTerminal: true,
    isRetryable: true,
  },
  dead_letter: {
    label: "Needs attention",
    description: "Failed repeatedly in a way retrying will not fix. Needs a person to look.",
    tone: "danger",
    isTerminal: true,
    isRetryable: false,
  },
};

export const RETRYABLE_ITEM_STATUSES = JOB_ITEM_STATUSES.filter(
  (s) => JOB_ITEM_STATUS_META[s].isRetryable,
);
export const IN_FLIGHT_ITEM_STATUSES: readonly JobItemStatus[] = ["leased", "running"];

// --- Submitted URL validation outcome -------------------------------------

/**
 * The outcome buckets shown on the bulk-ingestion validation screen (§5).
 * Every pasted line lands in exactly one, and the operator sees the counts
 * before committing to a job.
 */
export const URL_VALIDATION_OUTCOMES = [
  "valid",
  "invalid",
  "duplicate_in_batch",
  "already_in_database",
  "blocked",
  "unreachable",
] as const;
export type UrlValidationOutcome = (typeof URL_VALIDATION_OUTCOMES)[number];

export const URL_VALIDATION_OUTCOME_META: Record<
  UrlValidationOutcome,
  { label: string; description: string; tone: "success" | "danger" | "warning" | "neutral"; includeByDefault: boolean }
> = {
  valid: {
    label: "Valid",
    description: "A well-formed, allowed URL we have not captured before.",
    tone: "success",
    includeByDefault: true,
  },
  invalid: {
    label: "Invalid",
    description: "Not a URL we can use — bad syntax, wrong protocol, or no hostname.",
    tone: "danger",
    includeByDefault: false,
  },
  duplicate_in_batch: {
    label: "Duplicate in this paste",
    description: "Appeared more than once in what you pasted. Kept once.",
    tone: "neutral",
    includeByDefault: false,
  },
  already_in_database: {
    label: "Already in the database",
    description:
      "We have captured this URL before. Include it to record a new version and detect what changed.",
    tone: "warning",
    includeByDefault: false,
  },
  blocked: {
    label: "Blocked",
    description:
      "Refused by our safety rules: a private or internal address, a disallowed port, or a blocklisted domain.",
    tone: "danger",
    includeByDefault: false,
  },
  unreachable: {
    label: "Unreachable",
    description: "The host did not respond to a quick pre-flight check. Often temporary.",
    tone: "warning",
    includeByDefault: false,
  },
};

// --- Job configuration schema --------------------------------------------

export const jobPrioritySchema = z.enum(["low", "normal", "high"]).default("normal");
export type JobPriority = z.infer<typeof jobPrioritySchema>;

export const JOB_PRIORITY_WEIGHT: Record<JobPriority, number> = { high: 100, normal: 50, low: 10 };

/** One scripted interaction an operator defined for a page (§8). */
export const interactionStepSchema = z.object({
  type: z.enum(INTERACTION_TYPES),
  /** CSS selector for the target. Treated as untrusted and only ever passed to
   * Playwright's locator API — never interpolated into page script. */
  selector: z.string().min(1).max(500).optional(),
  label: z.string().max(200).optional(),
  /** Wait after acting, before the "after" screenshot. */
  settleMs: z.number().int().min(0).max(10_000).default(500),
  description: z.string().max(1000).optional(),
});
export type InteractionStep = z.infer<typeof interactionStepSchema>;

/**
 * What a crawl job may do.
 *
 * Read the omissions first: there is no "create content", no "send to review",
 * no content kind and no interaction script here. A crawl **discovers**. It
 * produces rows in `discovered_pages` — candidates — and nothing else (§13).
 * Turning a candidate into a Screen is a separate, deliberate act performed by
 * a person in the capture studio, and there is no configuration value that
 * skips that step, because a flag that could skip it would eventually be left
 * on by someone in a hurry.
 *
 * The screenshot settings that used to live here went with it. Discovery takes
 * at most one small preview so the triage list is not a wall of URLs; the
 * research image is photographed later, by hand, at full quality.
 */
export const crawlJobConfigSchema = z
  .object({
    module: z.enum(MODULE_KEYS).default("web"),

    // --- How hard to look -------------------------------------------------
    /**
     * 1 fetches the HTML over plain HTTP and parses it. 2 renders the page in
     * Chromium first, which is the only way to see a title or a link on a site
     * that ships an empty <div> and builds itself in JavaScript.
     *
     * Level 3 is not offered: scripted interaction exists to reach a visual
     * state, and reaching a visual state is now a person's job.
     */
    maxCaptureLevel: z.union([z.literal(1), z.literal(2)]).default(1),

    /**
     * Take one small viewport screenshot per discovered page.
     *
     * Only meaningful at level 2, and only ever a thumbnail for the triage
     * list: a researcher scanning 200 candidates needs to see which ones are
     * product screens rather than blog posts, and URLs alone do not show that.
     * It is never attached to a Screen and never reaches the public API.
     */
    capturePreview: z.boolean().default(false),
    previewProfile: z.enum(DEVICE_PROFILE_KEYS).default("desktop_1440"),

    // --- Discovery, and its bounds ---------------------------------------
    /** Follow internal links. On by default — discovery is the point. */
    crawlInternalLinks: z.boolean().default(true),
    maxDepth: z.number().int().min(0).max(JOB_LIMITS.maxDepth).default(JOB_DEFAULTS.maxDepth),
    maxPagesPerDomain: z
      .number()
      .int()
      .min(1)
      .max(JOB_LIMITS.maxPagesPerDomain)
      .default(JOB_DEFAULTS.maxPagesPerDomain),
    maxPagesTotal: z
      .number()
      .int()
      .min(1)
      .max(JOB_LIMITS.maxPagesTotal)
      .default(JOB_DEFAULTS.maxPagesTotal),
    /** Restrict discovery to the submitted URLs' own hosts. */
    restrictToSubmittedDomains: z.boolean().default(true),
    includeSubdomains: z.boolean().default(false),
    /** Extra hosts discovery may follow. Explicit allowlist, never a pattern. */
    additionalAllowedHosts: z.array(z.string().max(253)).max(50).default([]),
    /** Path substrings a discovered URL must contain / must not contain. */
    includeUrlPatterns: z.array(z.string().max(200)).max(50).default([]),
    excludeUrlPatterns: z
      .array(z.string().max(200))
      .max(50)
      .default(["/cart", "/checkout", "/login", "/logout", "/signout", "/account", "/admin", "/api/"]),

    // --- Politeness and safety -------------------------------------------
    respectRobots: z.boolean().default(true),
    /** Overriding robots.txt is a deliberate, audited act. The reason is
     * mandatory so the audit log records why. */
    robotsOverrideReason: z.string().min(10).max(1000).optional(),
    requestsPerMinutePerDomain: z
      .number()
      .int()
      .min(1)
      .max(JOB_LIMITS.maxRequestsPerMinutePerDomain)
      .default(JOB_DEFAULTS.requestsPerMinutePerDomain),
    concurrencyPerDomain: z
      .number()
      .int()
      .min(1)
      .max(JOB_LIMITS.maxConcurrencyPerDomain)
      .default(JOB_DEFAULTS.concurrencyPerDomain),
    navigationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(JOB_LIMITS.navigationTimeoutMs)
      .default(JOB_DEFAULTS.navigationTimeoutMs),
    itemTimeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(JOB_LIMITS.itemTimeoutMs)
      .default(JOB_DEFAULTS.itemTimeoutMs),
    maxAttempts: z.number().int().min(1).max(JOB_LIMITS.maxAttempts).default(JOB_DEFAULTS.maxAttempts),

    // --- Where the candidates land ---------------------------------------
    /** Attach discovered pages to this source instead of resolving by domain. */
    targetSourceId: z.string().uuid().optional(),

    priority: jobPrioritySchema,
    notes: z.string().max(5_000).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.respectRobots && !cfg.robotsOverrideReason) {
      ctx.addIssue({
        code: "custom",
        path: ["robotsOverrideReason"],
        message: "Give a reason for ignoring robots.txt. It is recorded in the audit log.",
      });
    }
    if (cfg.crawlInternalLinks && cfg.maxDepth === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDepth"],
        message: "Link discovery is on but depth is 0, so nothing would be discovered. Set depth to 1 or more.",
      });
    }
    if (!cfg.crawlInternalLinks && cfg.maxDepth > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["crawlInternalLinks"],
        message: "Depth is set but link discovery is off. Turn on discovery or set depth to 0.",
      });
    }
    if (cfg.maxPagesPerDomain > cfg.maxPagesTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["maxPagesPerDomain"],
        message: "Pages per domain cannot exceed the total page limit.",
      });
    }
    if (cfg.capturePreview && cfg.maxCaptureLevel < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["maxCaptureLevel"],
        message: "Preview thumbnails need a browser. Raise the capture level to 2, or turn previews off.",
      });
    }
  });

export type CrawlJobConfig = z.infer<typeof crawlJobConfigSchema>;

/** The conservative default job: capture exactly what was submitted. */
export function defaultJobConfig(): CrawlJobConfig {
  return crawlJobConfigSchema.parse({});
}

/**
 * Ceiling on how many items a job may ever hold, given its configuration.
 *
 * The CMS shows this before a job starts ("this job could capture up to 340
 * pages"), which is the operator-facing half of §7: the bound is visible and
 * finite before anyone presses start, not discovered afterwards.
 */
export function estimateMaxItems(config: CrawlJobConfig, submittedUrlCount: number): number {
  if (!config.crawlInternalLinks) return submittedUrlCount;
  return Math.min(config.maxPagesTotal, submittedUrlCount * config.maxPagesPerDomain);
}

// --- Job event log --------------------------------------------------------

export const JOB_EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;
export type JobEventLevel = (typeof JOB_EVENT_LEVELS)[number];

/**
 * Job log event codes.
 *
 * A closed set, each with a human sentence, so the CMS log viewer reads as
 * plain English for a non-engineer (§24) while staying filterable and
 * countable for an engineer.
 */
export const JOB_EVENT_CODES = {
  job_created: "Job created",
  job_validated: "URLs validated",
  job_started: "Job started",
  job_paused: "Job paused",
  job_resumed: "Job resumed",
  job_cancelled: "Job cancelled",
  job_completed: "Job finished",
  job_limit_reached: "A job limit was reached and remaining items were skipped",
  item_queued: "URL queued",
  item_leased: "URL assigned to a worker",
  item_started: "Capture started",
  item_succeeded: "Capture succeeded",
  item_failed: "Capture failed",
  item_retrying: "Retrying after a failure",
  item_blocked: "URL blocked by a safety rule",
  item_duplicate: "Identical content already stored; recorded as a new version",
  item_lease_expired: "A worker stopped responding; the URL was returned to the queue",
  robots_checked: "robots.txt checked",
  robots_disallowed: "robots.txt disallows this URL",
  robots_overridden: "robots.txt was deliberately overridden by an operator",
  redirect_followed: "Followed a redirect",
  redirect_rejected: "Refused to follow a redirect",
  screenshot_taken: "Screenshot captured",
  media_stored: "File saved to storage",
  media_duplicate: "Identical file already in the library; reused it",
  content_created: "Content record created",
  content_updated: "Content record updated",
  page_discovered: "Page added to the discovery queue",
  page_rediscovered: "Page already in the discovery queue; details refreshed",
  page_ignored: "Discovered page set aside by a reviewer",
  screen_captured: "Screen captured by a researcher",
  session_opened: "Capture session opened",
  session_closed: "Capture session closed",
  version_created: "New version recorded",
  classification_suggested: "Classification suggested",
  classification_skipped: "Classification skipped",
  worker_registered: "Worker connected",
  worker_lost: "Worker stopped responding",
} as const;

export type JobEventCode = keyof typeof JOB_EVENT_CODES;

export function jobEventSentence(code: string): string {
  return (JOB_EVENT_CODES as Record<string, string>)[code] ?? code;
}
