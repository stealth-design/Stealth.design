/**
 * Sources (§3, §17).
 *
 * A Source is the product or site being studied. It is the operational anchor
 * that pages, screens, flows, captures, media and versions all reference, which
 * is what makes §3's target question — "show me everything we've captured from
 * this product" — a single indexed lookup rather than a join across the
 * pipeline.
 *
 * Health and rights live here rather than only on individual records because
 * they are properties of the relationship with the product: if a site starts
 * refusing us, or an owner asks us to stop, that applies to everything from
 * that source.
 */
import { relations, sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  actorId,
  createdAt,
  deletedAt,
  primaryId,
  searchVectorSql,
  timestamptz,
  tsvector,
  updatedAt,
} from "./columns.js";
import {
  deviceClassEnum,
  legalReviewStatusEnum,
  lifecycleStatusEnum,
  moduleEnum,
  permissionStatusEnum,
  platformEnum,
  rightsStatusEnum,
  robotsStatusEnum,
  sourceHealthEnum,
  sourceTypeEnum,
  takedownStatusEnum,
} from "./enums.js";
import { users } from "./identity.js";

export const sources = pgTable(
  "sources",
  {
    id: primaryId(),
    module: moduleEnum("module").notNull().default("web"),
    type: sourceTypeEnum("type").notNull().default("website"),

    // --- Identity ---------------------------------------------------------
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Primary hostname, lowercased and punycoded. The domain-to-source
     * resolution key used when ingestion needs to find or create a source. */
    domain: text("domain"),
    /**
     * The website this product *is*: the registrable domain, so
     * `www.notion.com`, `app.notion.com` and `notion.com` are all `notion.com`.
     * Unique among live products — one website, one profile, enforced by the
     * database rather than by every caller remembering to look first. Every
     * capture is filed under the product whose site matches its page.
     */
    site: text("site"),
    /** Normalised canonical entry point, e.g. https://stripe.com. */
    canonicalUrl: text("canonical_url"),
    /** sha256 of the normalised canonical URL, for redirect-target matching. */
    canonicalUrlHash: text("canonical_url_hash"),

    /**
     * The website's logo, as a media asset. No foreign key here for the same
     * reason as `content_items.primary_media_id`: media already references
     * sources, and the pair would be circular at creation time.
     */
    logoMediaId: uuid("logo_media_id"),
    /**
     * Where the logo came from, which decides whether it may be replaced:
     *   icon      the app icon the site publishes — read when it was added
     *   header    photographed from the page header in the studio
     *   manual    uploaded by a person — never replaced automatically
     */
    logoOrigin: text("logo_origin"),
    companyName: text("company_name"),
    productName: text("product_name"),
    description: text("description"),
    /** Platforms this source is available on. Taxonomy holds the curated set;
     * this array is the fast filter. */
    platforms: platformEnum("platforms").array().notNull().default(sql`'{}'::platform[]`),
    primaryDeviceClass: deviceClassEnum("primary_device_class"),

    status: lifecycleStatusEnum("status").notNull().default("draft"),

    // --- Health (§17) — derived from capture outcomes, not hand-set --------
    health: sourceHealthEnum("health").notNull().default("unknown"),
    firstCapturedAt: timestamptz("first_captured_at"),
    lastCapturedAt: timestamptz("last_captured_at"),
    lastSuccessfulCaptureAt: timestamptz("last_successful_capture_at"),
    /** When content last differed from the previous capture. Drives "changed". */
    lastChangedAt: timestamptz("last_changed_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastResponseStatus: integer("last_response_status"),
    lastLoadTimeMs: integer("last_load_time_ms"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),

    /**
     * Scheduling.
     *
     * §17 asks not to make scheduling complex yet but to design for it. These
     * two columns are the whole model: an interval, and a computed due time.
     * Nothing reads them automatically in V1 — the CMS surfaces
     * `health = 'needs_recapture'` as a worklist an operator acts on. Adding a
     * scheduler later means a job that queries `next_scheduled_capture_at`,
     * with no schema change.
     */
    captureIntervalDays: integer("capture_interval_days"),
    nextScheduledCaptureAt: timestamptz("next_scheduled_capture_at"),

    // --- Crawl policy -----------------------------------------------------
    robotsStatus: robotsStatusEnum("robots_status").notNull().default("unknown"),
    robotsCheckedAt: timestamptz("robots_checked_at"),
    /** Per-source politeness override, else the job/global default applies. */
    requestsPerMinuteOverride: integer("requests_per_minute_override"),
    /** Set when this source must never be crawled again. Checked before every
     * job item is queued, so it holds even for URLs pasted by hand later. */
    crawlBlockedAt: timestamptz("crawl_blocked_at"),
    crawlBlockedReason: text("crawl_blocked_reason"),

    // --- Rights (§22) -----------------------------------------------------
    rightsStatus: rightsStatusEnum("rights_status").notNull().default("unknown"),
    rightsOwner: text("rights_owner"),
    attribution: text("attribution"),
    permissionStatus: permissionStatusEnum("permission_status").notNull().default("not_requested"),
    takedownStatus: takedownStatusEnum("takedown_status").notNull().default("none"),
    legalReviewStatus: legalReviewStatusEnum("legal_review_status").notNull().default("not_started"),
    rightsNotes: text("rights_notes"),

    // --- Internal ---------------------------------------------------------
    notes: text("notes"),
    internalNotes: text("internal_notes"),

    /** Denormalised counters, maintained on write. The dashboard and the
     * sources table read these instead of counting rows per source, which is
     * the difference between an instant list and one that degrades as the
     * library grows. */
    contentCount: integer("content_count").notNull().default(0),
    mediaCount: integer("media_count").notNull().default(0),
    captureCount: integer("capture_count").notNull().default(0),

    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: actorId("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      searchVectorSql({
        A: ["name"],
        B: ["company_name", "product_name", "domain"],
        C: ["description"],
        D: ["notes"],
      }),
    ),
  },
  (t) => [
    uniqueIndex("sources_slug_key").on(t.slug),
    // A domain identifies at most one live source, which is what lets
    // ingestion resolve a pasted URL to an existing source. Partial, so a
    // soft-deleted source does not hold its domain hostage.
    uniqueIndex("sources_site_key")
      .on(t.site)
      .where(sql`${t.deletedAt} is null and ${t.site} is not null`),
    uniqueIndex("sources_domain_key")
      .on(t.domain)
      .where(sql`${t.deletedAt} is null and ${t.domain} is not null`),
    index("sources_module_idx").on(t.module),
    index("sources_status_idx").on(t.status),
    index("sources_health_idx").on(t.health),
    index("sources_last_captured_idx").on(t.lastCapturedAt.desc().nullsLast()),
    index("sources_next_scheduled_idx")
      .on(t.nextScheduledCaptureAt)
      .where(sql`${t.nextScheduledCaptureAt} is not null and ${t.deletedAt} is null`),
    index("sources_rights_idx").on(t.rightsStatus),
    index("sources_canonical_hash_idx").on(t.canonicalUrlHash),
    index("sources_search_idx").using("gin", t.searchVector),
    index("sources_name_trgm_idx").on(t.name),
  ],
);

export const sourcesRelations = relations(sources, ({ one }) => ({
  createdByUser: one(users, { fields: [sources.createdBy], references: [users.id] }),
}));

export type SourceRow = typeof sources.$inferSelect;
export type SourceInsert = typeof sources.$inferInsert;
