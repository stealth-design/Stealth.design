/**
 * Review, collections, audit and settings.
 */
import { relations, sql } from "drizzle-orm";
import { index, inet, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { actorId, createdAt, deletedAt, fk, primaryId, timestamptz, updatedAt } from "./columns.js";
import {
  auditActorTypeEnum,
  auditEntityTypeEnum,
  collectionStatusEnum,
  collectionVisibilityEnum,
  moduleEnum,
  reviewAssignmentStatusEnum,
  reviewDecisionEnum,
  reviewReasonEnum,
} from "./enums.js";
import { users } from "./identity.js";

/**
 * Review records (§15).
 *
 * The review *queue* is not a table — it is `content_items` filtered to
 * `status = 'needs_review'`, which has its own partial index. Deriving the
 * queue means it cannot fall out of sync with the content it describes.
 *
 * What this table stores is the review *history*: each assignment and each
 * decision, kept permanently. That is what the content detail page's "review
 * history" section (§29) reads, and it is what makes a rejection explicable six
 * months later.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: primaryId(),
    /** FK added in migration 0001. */
    contentItemId: fk("content_item_id").notNull(),
    /** Why it entered the queue, for grouping the reviewer's work. */
    reason: reviewReasonEnum("reason").notNull().default("new_capture"),

    assignedTo: actorId("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedBy: actorId("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamptz("assigned_at"),
    status: reviewAssignmentStatusEnum("status").notNull().default("pending"),

    decision: reviewDecisionEnum("decision"),
    decidedBy: actorId("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamptz("decided_at"),
    notes: text("notes"),

    /**
     * Time from opening the item to deciding it.
     *
     * §15 says the content team's time is valuable; this is the number that
     * makes that measurable. It is what tells you whether a change to the review
     * screen actually sped curation up.
     */
    durationMs: integer("duration_ms"),

    /** Snapshot of what was changed during review, for the history view. */
    changes: jsonb("changes").$type<Record<string, unknown>>().notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reviews_content_idx").on(t.contentItemId, t.createdAt.desc()),
    index("reviews_assigned_idx").on(t.assignedTo, t.status),
    index("reviews_decided_idx").on(t.decidedAt.desc().nullsLast()),
    index("reviews_status_idx").on(t.status),
    // A reviewer's own worklist.
    index("reviews_open_idx")
      .on(t.assignedTo, t.createdAt)
      .where(sql`${t.status} in ('pending','in_progress')`),
  ],
);

/** Curated sets of content. */
export const collections = pgTable(
  "collections",
  {
    id: primaryId(),
    module: moduleEnum("module"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    visibility: collectionVisibilityEnum("visibility").notNull().default("private"),
    status: collectionStatusEnum("status").notNull().default("draft"),
    coverMediaId: fk("cover_media_id"),
    itemCount: integer("item_count").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    notes: text("notes"),
    curatedBy: actorId("curated_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: timestamptz("published_at"),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("collections_slug_key").on(t.slug).where(sql`${t.deletedAt} is null`),
    index("collections_visibility_idx").on(t.visibility),
    index("collections_status_idx").on(t.status),
    index("collections_module_idx").on(t.module),
    // Public collections, for the public API.
    index("collections_public_idx")
      .on(t.sortOrder, t.name)
      .where(sql`${t.visibility} = 'public' and ${t.status} = 'active' and ${t.deletedAt} is null`),
  ],
);

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: fk("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** FK added in migration 0001. */
    contentItemId: fk("content_item_id").notNull(),
    position: integer("position").notNull().default(0),
    note: text("note"),
    addedBy: actorId("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.contentItemId] }),
    index("collection_items_collection_idx").on(t.collectionId, t.position),
    index("collection_items_content_idx").on(t.contentItemId),
  ],
);

/**
 * Audit log (§21).
 *
 * Append-only. Nothing in the application updates or deletes a row here, and
 * the row survives the deletion of the thing it describes — `entityId` is a
 * plain uuid with no foreign key, and `entityLabel` holds a human name captured
 * at write time. That is on purpose: an audit trail that cascades away when the
 * record is deleted cannot tell you who deleted it.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: primaryId(),

    actorType: auditActorTypeEnum("actor_type").notNull().default("user"),
    actorId: actorId("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Name/email captured at write time, so the trail reads correctly even
     * after the user row is gone. */
    actorLabel: text("actor_label"),

    /** A key of AUDIT_ACTIONS. Text rather than an enum so adding an audited
     * action does not require a migration. */
    action: text("action").notNull(),
    entityType: auditEntityTypeEnum("entity_type").notNull(),
    /** No FK, deliberately — see the note above. */
    entityId: fk("entity_id"),
    entityLabel: text("entity_label"),

    /** Field-level before/after, for actions whose metadata marks them
     * `snapshot: true`. Only the changed keys, never the whole row. */
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),

    /** Ties the rows of one bulk operation together, so "bulk approved 40
     * items" is one entry in the UI that expands to its 40 rows (§16). */
    batchId: fk("batch_id"),
    /** Correlates with the structured request/job logs. */
    requestId: text("request_id"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    /** Extra context: the reason for a robots override, a rejection note. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),

    createdAt: createdAt(),
  },
  (t) => [
    // The content detail page's "audit history" panel.
    index("audit_entity_idx").on(t.entityType, t.entityId, t.createdAt.desc()),
    index("audit_actor_idx").on(t.actorId, t.createdAt.desc()),
    index("audit_action_idx").on(t.action, t.createdAt.desc()),
    index("audit_created_idx").on(t.createdAt.desc()),
    index("audit_batch_idx").on(t.batchId).where(sql`${t.batchId} is not null`),
  ],
);

/**
 * Operator-editable settings.
 *
 * Exists so that the things §37 forbids hardcoding are not hardcoded: default
 * crawl limits, the tracking-parameter list used for URL normalisation, the
 * confidence floor for auto-applying classifications, retention windows.
 * Values are jsonb validated against a per-key Zod schema on write (see
 * `settings.ts` in the API package), so a bad value is rejected at the boundary
 * rather than crashing a worker later.
 */
export const settings = pgTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    /** Shown as help text on the Settings screen. */
    description: text("description"),
    updatedBy: actorId("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [index("settings_updated_idx").on(t.updatedAt.desc())],
);

export const reviewsRelations = relations(reviews, ({ one }) => ({
  assignee: one(users, { fields: [reviews.assignedTo], references: [users.id] }),
  decider: one(users, { fields: [reviews.decidedBy], references: [users.id] }),
}));

export const collectionsRelations = relations(collections, ({ many }) => ({
  items: many(collectionItems),
}));

export const collectionItemsRelations = relations(collectionItems, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionItems.collectionId],
    references: [collections.id],
  }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  actor: one(users, { fields: [auditEvents.actorId], references: [users.id] }),
}));

export type ReviewRow = typeof reviews.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AuditEventInsert = typeof auditEvents.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
