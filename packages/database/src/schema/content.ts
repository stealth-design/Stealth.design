/**
 * Content (§2, §33).
 *
 * `content_items` is the shared spine: every content record, whatever its kind,
 * has the same identity, status, provenance, rights and audit columns. The
 * fields that only make sense for one kind live in per-kind detail tables
 * (`page_details`, `screen_details`, ...), keyed one-to-one on the spine.
 *
 * This is the middle path §2 asks for — "do not flatten everything into one
 * enormous table if relational structure makes more sense". A single wide table
 * would give every flow a `viewport_width` and every interaction an
 * `http_status`; fully separate tables per kind would make the review queue,
 * the dashboard counts, search and bulk operations into seven-way unions. The
 * spine keeps the cross-cutting operations single-table, and the detail tables
 * keep the kind-specific columns honest and NOT NULL where they should be.
 *
 * Three separate reference axes carry the hierarchy, because they behave
 * differently (see the comment in `@uxd/types/content`):
 *   - `parentId`     containment: a state belongs to a page
 *   - `experienceId` membership: everything points at its website/app root
 *   - `flow_steps`   sequence: an ordered, many-to-many path through pages
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  actorId,
  createdAt,
  deletedAt,
  fk,
  primaryId,
  searchVectorSql,
  timestamptz,
  tsvector,
  updatedAt,
} from "./columns.js";
import {
  contentKindEnum,
  contentRelationTypeEnum,
  deviceClassEnum,
  interactionTypeEnum,
  legalReviewStatusEnum,
  lifecycleStatusEnum,
  moduleEnum,
  permissionStatusEnum,
  platformEnum,
  rightsStatusEnum,
  takedownStatusEnum,
} from "./enums.js";
import { users } from "./identity.js";
import { sources } from "./sources.js";

export const contentItems = pgTable(
  "content_items",
  {
    id: primaryId(),
    module: moduleEnum("module").notNull().default("web"),
    kind: contentKindEnum("kind").notNull(),
    status: lifecycleStatusEnum("status").notNull().default("draft"),

    // --- Placement in the graph ------------------------------------------
    sourceId: fk("source_id").references(() => sources.id, { onDelete: "restrict" }),
    /** The `website` or `app` record this belongs to. Self-referential; null on
     * the experience root itself. */
    experienceId: fk("experience_id"),
    /** Containment parent: page for a state, website for a page. */
    parentId: fk("parent_id"),

    // --- Identity ---------------------------------------------------------
    title: text("title"),
    slug: text("slug"),
    description: text("description"),
    /** The URL or deep link this record represents. */
    sourceUrl: text("source_url"),
    originalCompany: text("original_company"),
    originalProduct: text("original_product"),
    platform: platformEnum("platform"),
    deviceClass: deviceClassEnum("device_class"),

    // --- Primary media ----------------------------------------------------
    /**
     * FK added by a later migration rather than declared here: media_assets
     * references content_items for provenance, and content_items references
     * media_assets for display, which is a circular dependency Drizzle cannot
     * order at table-creation time. See migrations/0001_circular_fks.sql.
     */
    primaryMediaId: fk("primary_media_id"),

    // --- Versioning (§12) -------------------------------------------------
    /**
     * A content record is the *stable identity* of a page; its history is the
     * `captures` rows that point at it. `version` counts how many distinct
     * captures produced a content change, and `latestCaptureId` names the one
     * currently being shown.
     *
     * `versionOfId` is deliberately separate: it is only set when an operator
     * chooses to keep an old state as its own browsable record (a 2019 redesign
     * preserved next to the 2026 one) rather than as a point in one record's
     * history. The common case leaves it null.
     */
    version: integer("version").notNull().default(1),
    /** False only on records kept as historical siblings (see versionOfId). */
    isCurrentVersion: boolean("is_current_version").notNull().default(true),
    versionOfId: fk("version_of_id"),
    latestCaptureId: fk("latest_capture_id"),
    /** Hash of the captured text content. Equal hashes mean nothing changed. */
    contentHash: text("content_hash"),
    /** Hash of the structural outline (tag/heading skeleton), for detecting a
     * layout change when the copy is unchanged, and vice versa. */
    layoutHash: text("layout_hash"),

    // --- Timestamps -------------------------------------------------------
    capturedAt: timestamptz("captured_at"),
    firstPublishedAt: timestamptz("first_published_at"),
    publishedAt: timestamptz("published_at"),
    /**
     * When this was chosen for its website's featured section — the first
     * thing a website's page shows. Null when it is not featured. Only a live
     * record can be featured, and unpublishing clears it, so the featured
     * section can never point at something the public cannot see.
     */
    featuredAt: timestamptz("featured_at"),
    unpublishedAt: timestamptz("unpublished_at"),

    // --- Review (§15) -----------------------------------------------------
    reviewedBy: actorId("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamptz("reviewed_at"),
    approvedBy: actorId("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamptz("approved_at"),
    rejectedBy: actorId("rejected_by").references(() => users.id, { onDelete: "set null" }),
    rejectedAt: timestamptz("rejected_at"),
    rejectionReason: text("rejection_reason"),
    publishedBy: actorId("published_by").references(() => users.id, { onDelete: "set null" }),

    // --- Classification (§14) ---------------------------------------------
    aiClassifiedAt: timestamptz("ai_classified_at"),
    classificationModel: text("classification_model"),
    /** Lowest suggestion confidence on this record, so the review queue can be
     * sorted by "the machine was least sure about these". */
    classificationConfidence: real("classification_confidence"),

    // --- Rights (§22) — record level, may be stricter than the source's ---
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
    reviewNotes: text("review_notes"),

    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: actorId("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      searchVectorSql({
        A: ["title"],
        B: ["original_company", "original_product", "slug"],
        C: ["description", "source_url"],
        D: ["notes"],
      }),
    ),
  },
  (t) => [
    // A slug is unique per kind, so /pages/stripe-pricing and
    // /flows/stripe-pricing can coexist without collision.
    uniqueIndex("content_kind_slug_key")
      .on(t.kind, t.slug)
      .where(sql`${t.slug} is not null and ${t.deletedAt} is null`),

    index("content_status_idx").on(t.status),
    index("content_kind_idx").on(t.kind),
    index("content_module_idx").on(t.module),
    index("content_source_idx").on(t.sourceId),
    index("content_experience_idx").on(t.experienceId),
    index("content_parent_idx").on(t.parentId),
    index("content_version_of_idx").on(t.versionOfId),
    index("content_updated_idx").on(t.updatedAt.desc()),
    index("content_captured_idx").on(t.capturedAt.desc().nullsLast()),
    index("content_content_hash_idx").on(t.contentHash),

    // The review queue: "needs_review, oldest first". Partial so the index
    // holds only the backlog rather than the whole library.
    index("content_review_queue_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'needs_review' and ${t.deletedAt} is null`),

    // The public API's only content index. Partial on exactly the rows
    // `publishedContentFilter()` admits, so a public list query never touches
    // an unpublished row's heap page at all.
    index("content_published_idx")
      .on(t.publishedAt.desc().nullsLast())
      .where(
        sql`${t.status} = 'published' and ${t.deletedAt} is null and ${t.rightsStatus} not in ('pending_review','restricted','removed','do_not_republish')`,
      ),

    index("content_status_kind_idx").on(t.status, t.kind),
    index("content_search_idx").using("gin", t.searchVector),
  ],
);

// --- Per-kind detail tables ----------------------------------------------

/**
 * Detail for `website` and `app` records — the experience roots.
 */
export const experienceDetails = pgTable("experience_details", {
  contentItemId: fk("content_item_id")
    .primaryKey()
    .references(() => contentItems.id, { onDelete: "cascade" }),
  /** App store or web entry point. */
  homeUrl: text("home_url"),
  appStoreUrl: text("app_store_url"),
  playStoreUrl: text("play_store_url"),
  appBundleId: text("app_bundle_id"),
  appVersion: text("app_version"),
  /** Denormalised child counts for the source/experience overview page. */
  pageCount: integer("page_count").notNull().default(0),
  screenCount: integer("screen_count").notNull().default(0),
  flowCount: integer("flow_count").notNull().default(0),
});

/**
 * Detail for `page` records.
 *
 * `normalizedUrlHash` is the dedupe key (§11). It is unique across live pages,
 * which is what makes a re-crawl produce a new *capture* against the existing
 * page rather than a second page row.
 */
export const pageDetails = pgTable(
  "page_details",
  {
    contentItemId: fk("content_item_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    /** sha256 of the normalised URL. */
    normalizedUrlHash: text("normalized_url_hash").notNull(),
    /** Where we ended up after redirects, if different. */
    finalUrl: text("final_url"),
    finalUrlHash: text("final_url_hash"),
    /** The page's own rel=canonical claim, normalised. Untrusted. */
    canonicalUrl: text("canonical_url"),
    canonicalUrlHash: text("canonical_url_hash"),
    httpStatus: integer("http_status"),

    /** Extracted metadata. All of it attacker-controlled and sanitised on the
     * way in — see `sanitizeText`. */
    pageTitle: text("page_title"),
    metaDescription: text("meta_description"),
    ogTitle: text("og_title"),
    ogDescription: text("og_description"),
    ogType: text("og_type"),
    langAttr: text("lang_attr"),
    h1: text("h1"),
    wordCount: integer("word_count"),

    /** Rendered dimensions of the capture that produced this row. */
    pageWidth: integer("page_width"),
    pageHeight: integer("page_height"),
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),

    /** Discovery position, for pages found by crawling rather than submitted. */
    depth: smallint("depth").notNull().default(0),
    discoveredFromUrl: text("discovered_from_url"),
  },
  (t) => [
    uniqueIndex("page_normalized_url_key").on(t.normalizedUrlHash),
    index("page_final_url_hash_idx").on(t.finalUrlHash),
    index("page_canonical_hash_idx").on(t.canonicalUrlHash),
    index("page_http_status_idx").on(t.httpStatus),
  ],
);

/**
 * Detail for `screen` records — a deliberately captured visual state (§2).
 *
 * A Screen is not a URL. The same URL routinely yields several: the default
 * view, the navigation open, the search open, a modal up. What distinguishes
 * them is `stateLabel` plus the pixels, which is why `url` here is not unique
 * and carries no dedupe hash — unlike `page_details.normalized_url_hash`,
 * where uniqueness is the entire point. Two Screens of stripe.com/pricing are
 * the expected case, not a bug to collapse.
 */
export const screenDetails = pgTable(
  "screen_details",
  {
    contentItemId: fk("content_item_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    screenName: text("screen_name"),
    /**
     * What makes this state worth its own record: "Navigation open", "Search
     * open", "Empty cart". Null on the default view of a page.
     */
    stateLabel: text("state_label"),
    /** The web URL, or a route/deep link within a native app. */
    url: text("url"),
    deepLink: text("deep_link"),
    appVersion: text("app_version"),
    osVersion: text("os_version"),
    /** A `SCREEN_ACQUISITIONS` value. Text, validated at the boundary. */
    acquisition: text("acquisition").notNull().default("interactive_capture"),

    // --- Exact capture conditions (§3, §15) -------------------------------
    /** A `DEVICE_PROFILES` key, e.g. "desktop_1440". */
    deviceProfile: text("device_profile"),
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),
    deviceScaleFactor: integer("device_scale_factor"),

    // --- Provenance --------------------------------------------------------
    /** The studio session a researcher captured it in. */
    captureSessionId: fk("capture_session_id"),
    /** The candidate it was captured from, when it came from triage. */
    discoveredPageId: fk("discovered_page_id"),
  },
  (t) => [
    index("screen_app_version_idx").on(t.appVersion),
    index("screen_url_idx").on(t.url),
    index("screen_session_idx").on(t.captureSessionId),
    index("screen_discovered_idx").on(t.discoveredPageId),
  ],
);

/**
 * Detail for `flow` records.
 *
 * A flow's membership and order are in `flow_steps`, not here — one page can
 * belong to many flows, and a flow's steps are an ordered sequence.
 */
export const flowDetails = pgTable("flow_details", {
  contentItemId: fk("content_item_id")
    .primaryKey()
    .references(() => contentItems.id, { onDelete: "cascade" }),
  /** What the user is trying to achieve. */
  goal: text("goal"),
  /** Denormalised from flow_steps, maintained on write. */
  stepCount: integer("step_count").notNull().default(0),
  entryContentId: fk("entry_content_id").references(() => contentItems.id, { onDelete: "set null" }),
  exitContentId: fk("exit_content_id").references(() => contentItems.id, { onDelete: "set null" }),
  /** Observed completion friction notes, authored by a researcher. */
  observations: text("observations"),
});

/** Ordered steps of a flow. */
export const flowSteps = pgTable(
  "flow_steps",
  {
    id: primaryId(),
    flowId: fk("flow_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /** The page, screen or state at this step. */
    contentItemId: fk("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    label: text("label"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("flow_step_position_key").on(t.flowId, t.position),
    index("flow_step_flow_idx").on(t.flowId),
    index("flow_step_content_idx").on(t.contentItemId),
  ],
);

/** Detail for `state` records — a named visual state of a page or screen. */
export const stateDetails = pgTable(
  "state_details",
  {
    contentItemId: fk("content_item_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /** Free text, with a curated `state` taxonomy alongside it. */
    stateName: text("state_name").notNull(),
    /** What produces this state: "cart empty", "network offline". */
    trigger: text("trigger"),
    /** The state shown on a normal first visit. At most one per parent. */
    isDefaultState: boolean("is_default_state").notNull().default(false),
  },
  (t) => [index("state_name_idx").on(t.stateName)],
);

/**
 * Detail for `interaction` records (§8).
 *
 * `selector` is a CSS selector supplied by an operator and stored verbatim. It
 * is untrusted input as far as this system is concerned and is only ever handed
 * to Playwright's locator API in the isolated worker — never interpolated into
 * page script, a shell command or SQL.
 */
export const interactionDetails = pgTable(
  "interaction_details",
  {
    contentItemId: fk("content_item_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    interactionType: interactionTypeEnum("interaction_type").notNull(),
    /** Human description of what triggers it. */
    trigger: text("trigger"),
    selector: text("selector"),
    /** Before/after states, as their own content records when they are worth
     * browsing separately, else just the media below. */
    beforeStateId: fk("before_state_id").references(() => contentItems.id, { onDelete: "set null" }),
    afterStateId: fk("after_state_id").references(() => contentItems.id, { onDelete: "set null" }),
    /** Ordered steps that reproduce it, validated against interactionStepSchema. */
    steps: jsonb("steps").$type<unknown[]>().notNull().default([]),
    settleMs: integer("settle_ms"),
    observations: text("observations"),
  },
  (t) => [index("interaction_type_idx").on(t.interactionType)],
);

/**
 * Typed edges between content records (§29 "Related pages / Related screens").
 *
 * A separate table rather than a column because these are many-to-many and
 * carry their own metadata, and because a page can be related to another page
 * in more than one way at once.
 */
export const contentRelations = pgTable(
  "content_relations",
  {
    fromId: fk("from_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    toId: fk("to_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    relationType: contentRelationTypeEnum("relation_type").notNull().default("related"),
    note: text("note"),
    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fromId, t.toId, t.relationType] }),
    index("content_relation_to_idx").on(t.toId),
  ],
);

export const contentItemsRelations = relations(contentItems, ({ one, many }) => ({
  source: one(sources, { fields: [contentItems.sourceId], references: [sources.id] }),
  experience: one(contentItems, {
    fields: [contentItems.experienceId],
    references: [contentItems.id],
    relationName: "experience",
  }),
  parent: one(contentItems, {
    fields: [contentItems.parentId],
    references: [contentItems.id],
    relationName: "parent",
  }),
  children: many(contentItems, { relationName: "parent" }),
  pageDetail: one(pageDetails, {
    fields: [contentItems.id],
    references: [pageDetails.contentItemId],
  }),
  screenDetail: one(screenDetails, {
    fields: [contentItems.id],
    references: [screenDetails.contentItemId],
  }),
  flowDetail: one(flowDetails, {
    fields: [contentItems.id],
    references: [flowDetails.contentItemId],
  }),
  stateDetail: one(stateDetails, {
    fields: [contentItems.id],
    references: [stateDetails.contentItemId],
  }),
  interactionDetail: one(interactionDetails, {
    fields: [contentItems.id],
    references: [interactionDetails.contentItemId],
  }),
  experienceDetail: one(experienceDetails, {
    fields: [contentItems.id],
    references: [experienceDetails.contentItemId],
  }),
}));

export type ContentItemRow = typeof contentItems.$inferSelect;
export type ContentItemInsert = typeof contentItems.$inferInsert;
export type PageDetailRow = typeof pageDetails.$inferSelect;
