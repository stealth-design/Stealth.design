/**
 * Taxonomy and classification (§13, §14).
 *
 * `taxonomy_terms` is the operator-owned vocabulary. `taxonomy_assignments`
 * attaches terms to content, sources and media — and is also where §14's
 * "AI Suggested / Human Verified / Human Modified" distinction lives, as the
 * `origin` column on the assignment itself.
 *
 * Putting the provenance on the assignment rather than in a separate suggestions
 * table is what makes the important behaviour cheap: the review screen needs
 * "show me this page's classifications, marked by who put them there", and the
 * public API needs "only the human-confirmed ones". Both are one indexed read
 * of one table.
 *
 * `classification_suggestions` handles the other half of §14 — suggested values
 * for *non-taxonomy* fields (a title, a description, a summary), where there is
 * no term to point at and the suggestion has to be stored as a value awaiting a
 * human decision.
 */
import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
  actorId,
  createdAt,
  fk,
  primaryId,
  searchVectorSql,
  timestamptz,
  tsvector,
  updatedAt,
} from "./columns.js";
import {
  classificationOriginEnum,
  suggestionReviewStatusEnum,
  taxonomyKindEnum,
  taxonomyTargetEnum,
  taxonomyTermStatusEnum,
} from "./enums.js";
import { users } from "./identity.js";

export const taxonomyTerms = pgTable(
  "taxonomy_terms",
  {
    id: primaryId(),
    kind: taxonomyKindEnum("kind").notNull(),
    /** Parent term, for the hierarchical vocabularies. Self-referential. */
    parentId: fk("parent_id"),

    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),

    /**
     * Alternative names that should resolve to this term.
     *
     * This is what makes classification suggestions usable: a model or an
     * importer says "hamburger menu" and the resolver maps it to the team's
     * canonical "Menu > Hamburger menu" instead of creating a near-duplicate
     * term. Also powers CMS search, so typing "bottom nav" finds "Bottom
     * navigation".
     */
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),

    status: taxonomyTermStatusEnum("status").notNull().default("active"),

    /**
     * Materialised ancestor path, e.g. "navigation/mobile/bottom-navigation".
     *
     * Kept alongside `parentId` so that "everything under Navigation" is a
     * prefix match rather than a recursive CTE per query. Rebuilt when a term
     * is re-parented, which is rare; read constantly.
     */
    path: text("path").notNull(),
    depth: integer("depth").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),

    /** Maintained on assign/unassign, so the taxonomy screen can show how much
     * each term is actually used and surface dead vocabulary (§13). */
    usageCount: integer("usage_count").notNull().default(0),

    /** Display colour for CMS badges. Operator-chosen. */
    color: text("color"),

    /**
     * Seeded by `db:seed` as a starting vocabulary. Marked so the CMS can warn
     * before archiving one, and so a reset can tell the seed vocabulary apart
     * from terms the team created. Not a permission boundary — operators own
     * their taxonomy and may archive these.
     */
    isSeed: boolean("is_seed").notNull().default(false),

    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: actorId("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamptz("archived_at"),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      searchVectorSql({ A: ["name"], B: ["slug"], C: ["description"] }),
    ),
  },
  (t) => [
    // A slug is unique within its vocabulary, so `ux_pattern/navigation` and
    // `ui_pattern/navigation` can both exist — which they should.
    uniqueIndex("taxonomy_kind_slug_key").on(t.kind, t.slug),
    index("taxonomy_kind_idx").on(t.kind),
    index("taxonomy_parent_idx").on(t.parentId),
    index("taxonomy_status_idx").on(t.status),
    index("taxonomy_path_idx").on(t.kind, t.path),
    index("taxonomy_usage_idx").on(t.usageCount.desc()),
    index("taxonomy_search_idx").using("gin", t.searchVector),
    index("taxonomy_aliases_idx").using("gin", t.aliases),
  ],
);

/**
 * A term attached to a record.
 *
 * The target is one of three nullable columns rather than a polymorphic
 * (type, id) pair, so that real foreign keys apply and a deleted content record
 * cannot leave a dangling classification. A check constraint (migration 0001)
 * enforces that exactly one is set.
 */
export const taxonomyAssignments = pgTable(
  "taxonomy_assignments",
  {
    id: primaryId(),
    termId: fk("term_id")
      .notNull()
      .references(() => taxonomyTerms.id, { onDelete: "cascade" }),
    target: taxonomyTargetEnum("target").notNull(),

    /** Exactly one of these three is non-null. FKs added in migration 0001. */
    contentItemId: fk("content_item_id"),
    sourceId: fk("source_id"),
    mediaId: fk("media_id"),

    // --- Provenance (§14) -------------------------------------------------
    origin: classificationOriginEnum("origin").notNull().default("human_added"),
    /** Model confidence, 0-1. Null for human-added assignments. */
    confidence: real("confidence"),
    /** Which model produced the suggestion, for later comparison. */
    model: text("model"),
    promptVersion: text("prompt_version"),
    suggestedAt: timestamptz("suggested_at"),

    reviewStatus: suggestionReviewStatusEnum("review_status").notNull().default("accepted"),
    reviewedBy: actorId("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamptz("reviewed_at"),
    /** When a human changed the suggestion, the term the model had proposed.
     * Kept so model quality can be measured against human corrections. */
    replacedTermId: fk("replaced_term_id").references(() => taxonomyTerms.id, {
      onDelete: "set null",
    }),

    /** The primary term of its kind, for single-value vocabularies. */
    isPrimary: boolean("is_primary").notNull().default(false),
    note: text("note"),

    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One term per target, once. Three partial unique indexes rather than one
    // composite, because the target columns are mutually exclusive nullables
    // and NULLs would defeat a single unique constraint.
    uniqueIndex("taxonomy_assign_content_key")
      .on(t.termId, t.contentItemId)
      .where(sql`${t.contentItemId} is not null`),
    uniqueIndex("taxonomy_assign_source_key")
      .on(t.termId, t.sourceId)
      .where(sql`${t.sourceId} is not null`),
    uniqueIndex("taxonomy_assign_media_key")
      .on(t.termId, t.mediaId)
      .where(sql`${t.mediaId} is not null`),

    index("taxonomy_assign_content_idx").on(t.contentItemId),
    index("taxonomy_assign_source_idx").on(t.sourceId),
    index("taxonomy_assign_media_idx").on(t.mediaId),
    index("taxonomy_assign_term_idx").on(t.termId),
    index("taxonomy_assign_origin_idx").on(t.origin),
    // The "AI suggestions awaiting a human" queue.
    index("taxonomy_assign_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.reviewStatus} = 'pending'`),
  ],
);

/**
 * Suggested values for free-text fields (§14).
 *
 * Distinct from `taxonomy_assignments` because there is no term to reference —
 * a suggested description is a *value*, and the human decision is
 * accept / edit / reject rather than which term applies. Storing the original
 * suggestion next to what was finally applied is what allows "how often do we
 * take the model's summary unchanged?" to be answered later.
 */
export const classificationSuggestions = pgTable(
  "classification_suggestions",
  {
    id: primaryId(),
    /** Which entity: content, source or media. */
    target: taxonomyTargetEnum("target").notNull(),
    contentItemId: fk("content_item_id"),
    sourceId: fk("source_id"),
    mediaId: fk("media_id"),

    /** Field name being suggested: "title", "description", "altText", "summary". */
    field: text("field").notNull(),
    /** The suggestion. jsonb so a field whose value is a list works too. */
    suggestedValue: jsonb("suggested_value").notNull(),
    confidence: real("confidence"),
    /** Short model-authored justification, shown to the reviewer. Untrusted
     * model output: sanitised and length-capped, displayed as text only. */
    rationale: text("rationale"),

    model: text("model").notNull(),
    promptVersion: text("prompt_version"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    reviewStatus: suggestionReviewStatusEnum("review_status").notNull().default("pending"),
    reviewedBy: actorId("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamptz("reviewed_at"),
    /** What the human actually saved, when it differed from the suggestion. */
    appliedValue: jsonb("applied_value"),
    appliedAt: timestamptz("applied_at"),

    createdAt: createdAt(),
  },
  (t) => [
    index("classification_content_idx").on(t.contentItemId),
    index("classification_source_idx").on(t.sourceId),
    index("classification_media_idx").on(t.mediaId),
    index("classification_field_idx").on(t.field),
    index("classification_model_idx").on(t.model),
    index("classification_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.reviewStatus} = 'pending'`),
    uniqueIndex("classification_content_field_key")
      .on(t.contentItemId, t.field, t.model)
      .where(sql`${t.contentItemId} is not null`),
  ],
);

export const taxonomyTermsRelations = relations(taxonomyTerms, ({ one, many }) => ({
  parent: one(taxonomyTerms, {
    fields: [taxonomyTerms.parentId],
    references: [taxonomyTerms.id],
    relationName: "taxonomyParent",
  }),
  children: many(taxonomyTerms, { relationName: "taxonomyParent" }),
  assignments: many(taxonomyAssignments),
}));

export const taxonomyAssignmentsRelations = relations(taxonomyAssignments, ({ one }) => ({
  term: one(taxonomyTerms, {
    fields: [taxonomyAssignments.termId],
    references: [taxonomyTerms.id],
  }),
  reviewer: one(users, {
    fields: [taxonomyAssignments.reviewedBy],
    references: [users.id],
  }),
}));

export type TaxonomyTermRow = typeof taxonomyTerms.$inferSelect;
export type TaxonomyTermInsert = typeof taxonomyTerms.$inferInsert;
export type TaxonomyAssignmentRow = typeof taxonomyAssignments.$inferSelect;
export type ClassificationSuggestionRow = typeof classificationSuggestions.$inferSelect;
