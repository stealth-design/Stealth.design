/**
 * Crawl jobs and the durable work queue (§4, §5, §6).
 *
 * The queue is Postgres, not Redis. That is a deliberate choice for this
 * system rather than a shortcut:
 *
 *   - §6 requires that job state survives a worker crash, and that an operator
 *     can pause, resume, cancel and retry. All of those are queries against
 *     rows that the CMS already reads.
 *   - A Crawl Job is a first-class CMS entity with its own screens, counts and
 *     history. With a broker, the authoritative queue state lives outside the
 *     database and has to be mirrored into it for the UI — and then the UI is
 *     only as correct as the mirroring.
 *   - Claiming work with `SELECT ... FOR UPDATE SKIP LOCKED` is transactional
 *     with the writes that record the result, so an item cannot be marked done
 *     while its capture row fails to commit.
 *
 * At this system's scale — thousands of pages per job, a handful of workers,
 * each item taking seconds of browser time — the bottleneck is Chromium, not
 * queue throughput. If that ever changes, the lease protocol below is the seam
 * to swap: nothing outside `queue.ts` knows how an item is claimed.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CrawlJobConfig } from "@uxd/types";
import { actorId, createdAt, fk, primaryId, timestamptz, updatedAt } from "./columns.js";
import {
  jobEventLevelEnum,
  jobItemStatusEnum,
  jobPriorityEnum,
  jobStatusEnum,
  moduleEnum,
  urlValidationOutcomeEnum,
} from "./enums.js";
import { users } from "./identity.js";
import { sources } from "./sources.js";

export const crawlJobs = pgTable(
  "crawl_jobs",
  {
    id: primaryId(),
    /** Short human reference shown in the UI and logs, e.g. "JOB-7K2M9QX4". */
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    module: moduleEnum("module").notNull().default("web"),
    status: jobStatusEnum("status").notNull().default("draft"),
    priority: jobPriorityEnum("priority").notNull().default("normal"),

    /** Validated against `crawlJobConfigSchema` on write. Typed here so a
     * config read back from the database is not `unknown` at every call site. */
    config: jsonb("config").$type<CrawlJobConfig>().notNull(),

    /** Optional pre-selected source for everything this job captures. */
    sourceId: fk("source_id").references(() => sources.id, { onDelete: "set null" }),

    // --- Lifecycle timestamps ---------------------------------------------
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    pausedAt: timestamptz("paused_at"),
    cancelledAt: timestamptz("cancelled_at"),
    durationMs: integer("duration_ms"),

    // --- Counters (§6) ----------------------------------------------------
    /**
     * Maintained incrementally as items settle, not counted on read. A job
     * with 5,000 items has its progress bar polled by every open CMS tab; five
     * COUNT(*) aggregates per poll would be the most expensive query in the
     * system. `recomputeJobCounters()` reconciles them if they ever drift.
     */
    submittedCount: integer("submitted_count").notNull().default(0),
    queuedCount: integer("queued_count").notNull().default(0),
    runningCount: integer("running_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    retriedCount: integer("retried_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    blockedCount: integer("blocked_count").notNull().default(0),
    /** URLs found by following links, as opposed to submitted. */
    discoveredCount: integer("discovered_count").notNull().default(0),
    /** Discovered URLs that passed scope and limit checks and were queued. */
    acceptedCount: integer("accepted_count").notNull().default(0),
    screenshotCount: integer("screenshot_count").notNull().default(0),
    mediaCount: integer("media_count").notNull().default(0),
    bytesStored: bigint("bytes_stored", { mode: "number" }).notNull().default(0),
    contentCreatedCount: integer("content_created_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),

    // --- Observability (§24) ----------------------------------------------
    /** Rolling average, for the "pages/minute" readout. */
    avgItemDurationMs: integer("avg_item_duration_ms"),
    errorSummary: jsonb("error_summary").$type<Record<string, number>>().notNull().default({}),

    notes: text("notes"),
    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("crawl_jobs_reference_key").on(t.reference),
    index("crawl_jobs_status_idx").on(t.status),
    index("crawl_jobs_created_idx").on(t.createdAt.desc()),
    index("crawl_jobs_source_idx").on(t.sourceId),
    index("crawl_jobs_created_by_idx").on(t.createdBy),
    // Jobs a worker could take work from, highest priority first.
    index("crawl_jobs_active_idx")
      .on(t.priority, t.createdAt)
      .where(sql`${t.status} in ('queued','running')`),
  ],
);

/**
 * The submitted-URL audit record (§5).
 *
 * Every line an operator pasted gets a row here, including the rejected ones,
 * with the bucket it fell into and why. Separate from `crawl_job_items` because
 * these are two different things: this is *what was submitted*, and items are
 * *what will be fetched*. An invalid URL has a row here and no item; a
 * discovered URL has an item and no row here.
 *
 * Keeping the rejects is what lets an operator come back to a job and see "42
 * of your 250 were already in the database" rather than silently receiving 208.
 */
export const crawlJobUrls = pgTable(
  "crawl_job_urls",
  {
    id: primaryId(),
    jobId: fk("job_id")
      .notNull()
      .references(() => crawlJobs.id, { onDelete: "cascade" }),
    /** Exactly as pasted, before normalisation. Preserved for the audit trail. */
    rawUrl: text("raw_url").notNull(),
    normalizedUrl: text("normalized_url"),
    normalizedUrlHash: text("normalized_url_hash"),
    outcome: urlValidationOutcomeEnum("outcome").notNull(),
    /** Machine reason code, e.g. DISALLOWED_PROTOCOL, SSRF_BLOCKED. */
    reasonCode: text("reason_code"),
    /** The sentence shown to the operator. */
    reasonMessage: text("reason_message"),
    /** For duplicates: the row or existing record this collided with. */
    duplicateOfUrlHash: text("duplicate_of_url_hash"),
    existingContentId: fk("existing_content_id"),
    /** Whether the operator chose to include this row in the run. */
    included: boolean("included").notNull().default(false),
    lineNumber: integer("line_number"),
    createdAt: createdAt(),
  },
  (t) => [
    index("crawl_job_urls_job_idx").on(t.jobId),
    index("crawl_job_urls_outcome_idx").on(t.jobId, t.outcome),
    index("crawl_job_urls_hash_idx").on(t.normalizedUrlHash),
  ],
);

/**
 * One unit of work: a URL to capture (§6).
 *
 * The lease protocol
 * ------------------
 * A worker claims items with
 *
 *   UPDATE crawl_job_items SET status='leased', lease_token=..., leased_by=...,
 *          lease_expires_at = now() + interval
 *   WHERE id IN (
 *     SELECT id FROM crawl_job_items
 *     WHERE status='pending' AND available_at <= now() AND job_id IN (<active>)
 *     ORDER BY priority DESC, available_at, id
 *     FOR UPDATE SKIP LOCKED LIMIT n
 *   )
 *
 * `SKIP LOCKED` is what lets several workers poll concurrently without
 * blocking each other or handing the same URL to two of them.
 *
 * Every subsequent write from that worker carries the `lease_token` and is
 * rejected if it no longer matches. That is the crash-safety property: if a
 * worker hangs and its lease expires, the reaper returns the item to `pending`
 * and another worker takes it — and when the original worker eventually wakes
 * up and tries to report a result, its stale token is refused rather than
 * overwriting the newer attempt.
 */
export const crawlJobItems = pgTable(
  "crawl_job_items",
  {
    id: primaryId(),
    jobId: fk("job_id")
      .notNull()
      .references(() => crawlJobs.id, { onDelete: "cascade" }),
    status: jobItemStatusEnum("status").notNull().default("pending"),

    /** Normalised URL to fetch, and its dedupe hash. */
    url: text("url").notNull(),
    normalizedUrlHash: text("normalized_url_hash").notNull(),
    host: text("host").notNull(),

    /** Discovery position. Depth 0 means submitted by a person. */
    depth: smallint("depth").notNull().default(0),
    parentItemId: fk("parent_item_id"),
    discoveredFromUrl: text("discovered_from_url"),

    /** Higher runs first. Derived from the job's priority at enqueue time. */
    priority: integer("priority").notNull().default(50),

    // --- Lease state ------------------------------------------------------
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Opaque token proving a worker still owns this item. */
    leaseToken: text("lease_token"),
    leasedBy: text("leased_by"),
    leasedAt: timestamptz("leased_at"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    heartbeatAt: timestamptz("heartbeat_at"),
    /** Not eligible for lease before this time. Set to now + backoff on a
     * retryable failure, which is how exponential backoff is expressed in a
     * database queue. */
    availableAt: timestamptz("available_at").notNull().defaultNow(),

    // --- Outcome ----------------------------------------------------------
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    durationMs: integer("duration_ms"),
    httpStatus: integer("http_status"),
    finalUrl: text("final_url"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** What the attempt produced: capture id, media ids, discovered count. */
    resultSummary: jsonb("result_summary").$type<Record<string, unknown>>().notNull().default({}),
    /** FKs added in migration 0001 (captures/content are declared later). */
    captureId: fk("capture_id"),
    contentItemId: fk("content_item_id"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The same URL is queued at most once per job, so a job that submits a URL
    // and also discovers it by following a link does not capture it twice.
    uniqueIndex("crawl_job_items_job_url_key").on(t.jobId, t.normalizedUrlHash),

    /**
     * The lease index. Column order matches the claim query's ORDER BY exactly
     * (priority DESC, available_at, id) and the partial predicate keeps the
     * index to just the claimable rows — so polling a job with 5,000 finished
     * items and 3 pending ones reads three index entries, not five thousand.
     */
    index("crawl_job_items_claim_idx")
      .on(t.priority.desc(), t.availableAt, t.id)
      .where(sql`${t.status} = 'pending'`),

    /** The reaper's index: leases that have expired without a heartbeat. */
    index("crawl_job_items_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} in ('leased','running')`),

    index("crawl_job_items_job_status_idx").on(t.jobId, t.status),
    index("crawl_job_items_host_idx").on(t.host),
    index("crawl_job_items_hash_idx").on(t.normalizedUrlHash),
    index("crawl_job_items_capture_idx").on(t.captureId),
    index("crawl_job_items_content_idx").on(t.contentItemId),
    // "Retry failed" for one job.
    index("crawl_job_items_failed_idx")
      .on(t.jobId)
      .where(sql`${t.status} in ('failed','dead_letter')`),
  ],
);

/**
 * Job event log (§6 "logs", §24).
 *
 * Rows carry a machine `code` from `JOB_EVENT_CODES` plus structured `data`.
 * The CMS renders the code's English sentence and shows `data` only on expand,
 * which is how the log stays readable for a non-engineer while remaining
 * precise enough to debug from (§24 "make logs understandable to
 * non-engineering CMS users where possible").
 */
export const crawlJobEvents = pgTable(
  "crawl_job_events",
  {
    id: primaryId(),
    jobId: fk("job_id")
      .notNull()
      .references(() => crawlJobs.id, { onDelete: "cascade" }),
    itemId: fk("item_id").references(() => crawlJobItems.id, { onDelete: "cascade" }),
    level: jobEventLevelEnum("level").notNull().default("info"),
    /** A key of JOB_EVENT_CODES. Text, not an enum: log codes are added often
     * and a migration per code would be friction with no integrity benefit. */
    code: text("code").notNull(),
    /** Overrides the code's default sentence when a specific one is clearer. */
    message: text("message"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /** Which worker or user emitted it. */
    actor: text("actor"),
    createdAt: createdAt(),
  },
  (t) => [
    index("crawl_job_events_job_idx").on(t.jobId, t.createdAt.desc()),
    index("crawl_job_events_item_idx").on(t.itemId),
    index("crawl_job_events_level_idx").on(t.jobId, t.level),
    index("crawl_job_events_code_idx").on(t.code),
  ],
);

export const crawlJobsRelations = relations(crawlJobs, ({ one, many }) => ({
  source: one(sources, { fields: [crawlJobs.sourceId], references: [sources.id] }),
  creator: one(users, { fields: [crawlJobs.createdBy], references: [users.id] }),
  items: many(crawlJobItems),
  urls: many(crawlJobUrls),
  events: many(crawlJobEvents),
}));

export const crawlJobItemsRelations = relations(crawlJobItems, ({ one }) => ({
  job: one(crawlJobs, { fields: [crawlJobItems.jobId], references: [crawlJobs.id] }),
}));

export const crawlJobUrlsRelations = relations(crawlJobUrls, ({ one }) => ({
  job: one(crawlJobs, { fields: [crawlJobUrls.jobId], references: [crawlJobs.id] }),
}));

export const crawlJobEventsRelations = relations(crawlJobEvents, ({ one }) => ({
  job: one(crawlJobs, { fields: [crawlJobEvents.jobId], references: [crawlJobs.id] }),
  item: one(crawlJobItems, { fields: [crawlJobEvents.itemId], references: [crawlJobItems.id] }),
}));

export type CrawlJobRow = typeof crawlJobs.$inferSelect;
export type CrawlJobInsert = typeof crawlJobs.$inferInsert;
export type CrawlJobItemRow = typeof crawlJobItems.$inferSelect;
export type CrawlJobUrlRow = typeof crawlJobUrls.$inferSelect;
export type CrawlJobEventRow = typeof crawlJobEvents.$inferSelect;
