/**
 * Captures and the URL registry (§11, §12).
 *
 * A `capture` is one attempt to record one thing at one moment. It is the
 * versioning backbone: a page is a stable content record, and its history is
 * the ordered list of captures pointing at it. That is why "re-run a source,
 * avoid duplicate content, create a new capture/version, preserve provenance,
 * view capture history" (§35, criteria 21-25) needs no separate versions table
 * — the capture row *is* the version.
 *
 * Captures are also kept for failures. A failed capture is evidence: it records
 * what we tried, when, with which browser, and why it did not work, which is
 * what makes the "Failed / Needs attention" screen actionable rather than a
 * list of blank rows.
 */
import { relations, sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { actorId, createdAt, fk, primaryId, timestamptz } from "./columns.js";
import { captureMethodEnum, captureStatusEnum, deviceClassEnum } from "./enums.js";
import { users } from "./identity.js";
import { sources } from "./sources.js";

export const captures = pgTable(
  "captures",
  {
    id: primaryId(),
    sourceId: fk("source_id").references(() => sources.id, { onDelete: "cascade" }),
    /** The content record this capture is a version of. FK in migration 0001. */
    contentItemId: fk("content_item_id"),
    /** Which job produced it. Null for a manual, one-off capture. */
    crawlJobId: fk("crawl_job_id"),
    crawlJobItemId: fk("crawl_job_item_id"),

    method: captureMethodEnum("method").notNull(),
    /** Which of the three layered levels actually ran (§26). */
    captureLevel: smallint("capture_level").notNull().default(2),
    status: captureStatusEnum("status").notNull(),

    // --- What was requested, and where we actually landed -----------------
    requestedUrl: text("requested_url"),
    finalUrl: text("final_url"),
    httpStatus: integer("http_status"),
    /**
     * Every redirect hop, in order, each with its status and target. Stored
     * because a redirect chain is both a provenance fact and a safety-relevant
     * one: the guard re-validates each hop, and this is the record of what it
     * saw.
     */
    redirectChain: jsonb("redirect_chain").$type<{ status: number; url: string }[]>().notNull().default([]),

    // --- Exact capture conditions (§10, §12) ------------------------------
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),
    deviceScaleFactor: integer("device_scale_factor"),
    deviceProfile: text("device_profile"),
    deviceClass: deviceClassEnum("device_class"),
    fullPage: boolean("full_page").notNull().default(false),
    browserName: text("browser_name"),
    browserVersion: text("browser_version"),
    userAgent: text("user_agent"),
    workerName: text("worker_name"),

    // --- Extracted page facts ---------------------------------------------
    pageTitle: text("page_title"),
    pageDescription: text("page_description"),
    pageWidth: integer("page_width"),
    pageHeight: integer("page_height"),

    // --- Change detection (§12) -------------------------------------------
    contentHash: text("content_hash"),
    layoutHash: text("layout_hash"),
    domHash: text("dom_hash"),
    /**
     * Whether this capture differs from the previous successful one for the
     * same content record. Computed at capture time by comparing hashes, so the
     * "what changed recently?" dashboard question is an indexed lookup instead
     * of a scan-and-compare.
     *
     * Null means "no previous capture to compare against" — a first capture is
     * neither changed nor unchanged.
     */
    changed: boolean("changed"),
    changedFromCaptureId: fk("changed_from_capture_id"),
    /** Which hashes moved, for a plain-English summary in the CMS. */
    changeSummary: jsonb("change_summary").$type<Record<string, unknown>>().notNull().default({}),

    // --- Performance and cost (§24) ---------------------------------------
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    durationMs: integer("duration_ms"),
    loadTimeMs: integer("load_time_ms"),
    resourceCount: integer("resource_count"),
    bytesTransferred: bigint("bytes_transferred", { mode: "number" }),
    screenshotCount: integer("screenshot_count").notNull().default(0),
    mediaCount: integer("media_count").notNull().default(0),

    // --- Outcome ----------------------------------------------------------
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Non-fatal problems: a screenshot succeeded but the favicon 404'd. */
    warnings: jsonb("warnings").$type<{ code: string; message: string }[]>().notNull().default([]),
    /** Console errors and failed subresource requests observed on the page.
     * Untrusted text, truncated and sanitised before storage. */
    browserErrors: jsonb("browser_errors").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("captures_content_idx").on(t.contentItemId, t.createdAt.desc()),
    index("captures_source_idx").on(t.sourceId, t.createdAt.desc()),
    index("captures_job_idx").on(t.crawlJobId),
    index("captures_job_item_idx").on(t.crawlJobItemId),
    index("captures_status_idx").on(t.status),
    index("captures_created_idx").on(t.createdAt.desc()),
    index("captures_content_hash_idx").on(t.contentHash),
    // "What changed recently?" — the dashboard question, as one index scan.
    index("captures_changed_idx")
      .on(t.createdAt.desc())
      .where(sql`${t.changed} = true`),
    // The failure triage screen.
    index("captures_failed_idx")
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'failed'`),
  ],
);

/**
 * The global URL registry (§11).
 *
 * One row per normalised URL we have ever seen, whatever job or source it came
 * through. Its job is to answer "have we seen this before?" during bulk
 * validation without scanning `page_details` — which is what makes the
 * "Already in database" bucket on the validation screen instant for a paste of
 * 250 URLs.
 *
 * It also records the redirect resolution: `resolvedUrlHash` points at where
 * this URL actually ended up, so two different submitted URLs that redirect to
 * the same destination are recognised as one page (§11's "same page after
 * redirect").
 */
export const urlRegistry = pgTable(
  "url_registry",
  {
    /** sha256 of the normalised URL. The primary key — no surrogate id, since
     * the hash *is* the identity. */
    normalizedUrlHash: text("normalized_url_hash").primaryKey(),
    normalizedUrl: text("normalized_url").notNull(),
    host: text("host").notNull(),
    registrableDomain: text("registrable_domain").notNull(),

    /** Where this URL resolved after redirects, if elsewhere. */
    resolvedUrlHash: text("resolved_url_hash"),
    /** The page's own rel=canonical, normalised. */
    canonicalUrlHash: text("canonical_url_hash"),

    sourceId: fk("source_id").references(() => sources.id, { onDelete: "set null" }),
    /** The content record for this URL, if one was created. FK in 0001. */
    contentItemId: fk("content_item_id"),

    firstSeenAt: createdAt(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    lastCapturedAt: timestamptz("last_captured_at"),
    captureCount: integer("capture_count").notNull().default(0),
    /** How many times we submitted it and it failed. Distinguishes "new" from
     * "known bad" on the validation screen. */
    failureCount: integer("failure_count").notNull().default(0),
    lastHttpStatus: integer("last_http_status"),

    /** Set when this URL must never be crawled, independent of its source. */
    blockedAt: timestamptz("blocked_at"),
    blockedReason: text("blocked_reason"),
  },
  (t) => [
    index("url_registry_host_idx").on(t.host),
    index("url_registry_domain_idx").on(t.registrableDomain),
    index("url_registry_resolved_idx").on(t.resolvedUrlHash),
    index("url_registry_canonical_idx").on(t.canonicalUrlHash),
    index("url_registry_content_idx").on(t.contentItemId),
    index("url_registry_source_idx").on(t.sourceId),
    index("url_registry_last_seen_idx").on(t.lastSeenAt.desc()),
  ],
);

/**
 * Cached robots.txt, per host.
 *
 * Cached because a 250-URL job across 6 domains should fetch 6 robots files,
 * not 250. `expiresAt` keeps it honest, and `fetchFailed` distinguishes "this
 * host has no robots.txt" (which permits crawling) from "we could not reach
 * it" (which does not, under `respectRobots`).
 */
export const robotsCache = pgTable(
  "robots_cache",
  {
    /** `scheme://host:port` — the robots.txt scope, not a full URL. */
    origin: text("origin").primaryKey(),
    /**
     * The rules, in full, exactly as served.
     *
     * Not truncated, and the distinction matters: a sibling worker reads this
     * back and parses it to decide what it may fetch. Storing an excerpt — as
     * this once did, "so an operator can see what we obeyed" — meant the file
     * obeyed was not the file fetched. The CMS truncates for display instead.
     */
    body: text("body"),
    httpStatus: integer("http_status"),
    fetchFailed: boolean("fetch_failed").notNull().default(false),
    /** Crawl-delay for our user agent, in ms, if declared. */
    crawlDelayMs: integer("crawl_delay_ms"),
    sitemapUrls: text("sitemap_urls").array().notNull().default(sql`'{}'::text[]`),
    fetchedAt: timestamptz("fetched_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [index("robots_cache_expires_idx").on(t.expiresAt)],
);

export const capturesRelations = relations(captures, ({ one }) => ({
  source: one(sources, { fields: [captures.sourceId], references: [sources.id] }),
}));

export type CaptureRow = typeof captures.$inferSelect;
export type CaptureInsert = typeof captures.$inferInsert;
export type UrlRegistryRow = typeof urlRegistry.$inferSelect;
