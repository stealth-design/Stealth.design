/**
 * The discovery queue (§1, §12).
 *
 * A row here means one thing only: "a crawl found this URL." It is not content,
 * it has no lifecycle status, it is never published, and there is no code path
 * that promotes one into a Screen without a person pressing a button.
 *
 * Why this is its own table and not a `content_items` row in an early status
 * -------------------------------------------------------------------------
 * It was a content row, and that was the defect. Anything in `content_items`
 * carries the whole apparatus of a publishable record — slug, rights status,
 * review queue membership, the public serializer's attention — so a crawl of a
 * 200-page marketing site created 200 publishable records and a reviewer whose
 * job was to say no 190 times. The library's contents were decided by whatever
 * the crawler happened to reach.
 *
 * Separating them inverts that. Candidates accumulate cheaply and can be
 * ignored in bulk without an audit trail per rejection; `content_items` only
 * ever contains things a person chose. It also makes the two questions
 * answerable separately: "what does this site have?" reads this table, "what
 * have we decided is worth studying?" reads content.
 *
 * Dedupe is global on `normalized_url_hash`, not per job. Crawling linear.app
 * twice a month apart should refresh one candidate, not stack two.
 */
import { relations, sql } from "drizzle-orm";
import { index, integer, pgTable, smallint, text, uniqueIndex } from "drizzle-orm/pg-core";
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
import { discoveredPageStatusEnum } from "./enums.js";
import { users } from "./identity.js";
import { sources } from "./sources.js";
import { crawlJobs } from "./jobs.js";

export const discoveredPages = pgTable(
  "discovered_pages",
  {
    id: primaryId(),
    status: discoveredPageStatusEnum("status").notNull().default("new"),

    /** Which product this page belongs to. Resolved from the host at intake. */
    sourceId: fk("source_id").references(() => sources.id, { onDelete: "cascade" }),
    /** The job that most recently saw it. Null for a hand-added candidate. */
    jobId: fk("job_id").references(() => crawlJobs.id, { onDelete: "set null" }),
    jobItemId: fk("job_item_id"),

    // --- Identity ---------------------------------------------------------
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    normalizedUrlHash: text("normalized_url_hash").notNull(),
    finalUrl: text("final_url"),
    host: text("host").notNull(),
    /** Path only, for the grouped triage list ("/pricing", "/customers/*"). */
    path: text("path"),
    httpStatus: integer("http_status"),

    // --- Lightweight metadata (§13) ---------------------------------------
    // Everything below came off an attacker-controlled page and is sanitised
    // at intake. It exists to help a human decide whether to look, nothing more.
    title: text("title"),
    description: text("description"),
    ogTitle: text("og_title"),
    ogType: text("og_type"),
    h1: text("h1"),
    langAttr: text("lang_attr"),
    wordCount: integer("word_count"),

    /** Optional triage thumbnail. Never attached to a Screen, never public. */
    previewMediaId: fk("preview_media_id"),

    // --- Discovery position ----------------------------------------------
    depth: smallint("depth").notNull().default(0),
    discoveredFromUrl: text("discovered_from_url"),

    // --- Triage -----------------------------------------------------------
    /** How many Screens a researcher has captured from this URL. A page can
     * yield several: default, nav open, modal open. */
    screenCount: integer("screen_count").notNull().default(0),
    /** A value of `IGNORE_REASONS`. Text rather than an enum so the vocabulary
     * can grow from operator experience without a migration. */
    ignoreReason: text("ignore_reason"),
    ignoreNote: text("ignore_note"),
    triagedBy: actorId("triaged_by").references(() => users.id, { onDelete: "set null" }),
    triagedAt: timestamptz("triaged_at"),

    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    /** How many separate crawls have returned this URL. */
    seenCount: integer("seen_count").notNull().default(1),

    createdAt: createdAt(),
    updatedAt: updatedAt(),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      searchVectorSql({ A: ["title"], B: ["path", "h1"], C: ["description", "url"] }),
    ),
  },
  (t) => [
    uniqueIndex("discovered_page_url_key").on(t.normalizedUrlHash),
    index("discovered_page_status_idx").on(t.status),
    index("discovered_page_source_idx").on(t.sourceId, t.status),
    index("discovered_page_job_idx").on(t.jobId),
    index("discovered_page_host_idx").on(t.host),
    index("discovered_page_search_idx").using("gin", t.searchVector),
    // The triage queue: untriaged candidates, newest first. Partial, so a
    // library with 50,000 settled candidates still opens instantly.
    index("discovered_page_queue_idx")
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'new'`),
  ],
);

export const discoveredPagesRelations = relations(discoveredPages, ({ one }) => ({
  source: one(sources, { fields: [discoveredPages.sourceId], references: [sources.id] }),
  job: one(crawlJobs, { fields: [discoveredPages.jobId], references: [crawlJobs.id] }),
  triager: one(users, { fields: [discoveredPages.triagedBy], references: [users.id] }),
}));

export type DiscoveredPageRow = typeof discoveredPages.$inferSelect;
export type DiscoveredPageInsert = typeof discoveredPages.$inferInsert;
