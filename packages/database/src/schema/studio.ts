/**
 * Live capture sessions (§2, §3).
 *
 * A session is one browser tab, opened by a worker on an operator's behalf and
 * held open while they steer it. Two tables, because the traffic runs in two
 * directions and they have completely different shapes:
 *
 *   `capture_sessions`          one row, rewritten constantly — the latest
 *                               frame of what the page looks like
 *   `capture_session_commands`  an append-only log — what the operator asked
 *                               the page to do, and what came back
 *
 * Why a frame is still kept here
 * ------------------------------
 * The live picture no longer travels through this row: the worker streams
 * Chromium's screencast to an in-memory relay in the CMS, which pushes each
 * frame straight to the studio (see `studio-live.ts` in `@uxd/api`). One frame
 * every couple of seconds is still written here, so a viewer who arrives after
 * a CMS restart — when the relay is empty and a still page paints nothing new —
 * sees the page rather than a blank box.
 *
 * The frame is a JPEG at CSS scale, not the research image. When the operator
 * presses Capture the worker re-photographs the viewport as a lossless PNG at
 * the profile's full device scale factor — 2880×1800 on desktop, 1170×2532 on
 * mobile. The preview is for aiming; the capture is the artefact.
 */
import { relations, sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { actorId, createdAt, fk, primaryId, timestamptz, updatedAt } from "./columns.js";
import { captureSessionStatusEnum, deviceClassEnum, sessionCommandStatusEnum } from "./enums.js";
import { users } from "./identity.js";
import { sources } from "./sources.js";
import { discoveredPages } from "./discovery.js";

/** Raw bytes. Drizzle has no first-class `bytea`, so this is the thin wrapper. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const captureSessions = pgTable(
  "capture_sessions",
  {
    id: primaryId(),
    status: captureSessionStatusEnum("status").notNull().default("pending"),

    // --- What is being captured -------------------------------------------
    targetUrl: text("target_url").notNull(),
    /** Where the page has actually navigated to since. */
    currentUrl: text("current_url"),
    currentTitle: text("current_title"),
    /** A `STUDIO_PROFILES` key. Fixed for the session's life: Playwright pins
     * deviceScaleFactor, isMobile and hasTouch at context creation, so
     * "switch to mobile" is a new session, not a resize. */
    deviceProfile: text("device_profile").notNull(),
    deviceClass: deviceClassEnum("device_class").notNull(),
    viewportWidth: integer("viewport_width").notNull(),
    viewportHeight: integer("viewport_height").notNull(),
    deviceScaleFactor: integer("device_scale_factor").notNull(),

    // --- Where the results go ---------------------------------------------
    sourceId: fk("source_id").references(() => sources.id, { onDelete: "set null" }),
    discoveredPageId: fk("discovered_page_id").references(() => discoveredPages.id, {
      onDelete: "set null",
    }),
    /** When set, every Screen captured in this session is appended to this
     * flow as the next step. This is what "Create Flow, then walk it" means. */
    flowId: fk("flow_id"),
    /** Taxonomy terms chosen before capturing ("Hero section", "Fintech").
     * Every Screen this session produces starts with them attached, as tags a
     * person chose; each Screen can still be retagged on its own. */
    defaultTermIds: fk("default_term_ids").array().notNull().default(sql`'{}'::uuid[]`),

    // --- Worker ownership --------------------------------------------------
    // Same lease shape as the crawl queue, for the same reason: a worker that
    // dies mid-session must not hold the session forever. A lapsed lease means
    // the browser is gone, so the session is expired rather than reassigned —
    // a new worker cannot reproduce the state the operator had navigated to.
    workerName: text("worker_name"),
    workerInstanceId: fk("worker_instance_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    heartbeatAt: timestamptz("heartbeat_at"),

    // --- The live view -----------------------------------------------------
    /** Latest JPEG of the viewport. Overwritten in place. */
    frame: bytea("frame"),
    frameWidth: integer("frame_width"),
    frameHeight: integer("frame_height"),
    frameBytes: integer("frame_bytes"),
    frameAt: timestamptz("frame_at"),
    /** Increments on every frame, so the studio can poll for "newer than N"
     * instead of refetching a couple hundred kilobytes it already has. */
    frameSeq: integer("frame_seq").notNull().default(0),
    /** Last time a browser actually fetched a frame. Drives the worker's poll
     * interval: nobody watching means no reason to keep photographing. */
    viewerSeenAt: timestamptz("viewer_seen_at"),

    // --- Outcome -----------------------------------------------------------
    screensCaptured: integer("screens_captured").notNull().default(0),
    commandCount: integer("command_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamptz("started_at"),
    closedAt: timestamptz("closed_at"),
    /** Hard stop, whatever the activity. */
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The claim index: sessions waiting for a worker, oldest first. Partial,
    // so the worker's poll reads only what it could actually take.
    index("capture_session_claim_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // The reaper's index: live sessions whose worker stopped reporting.
    index("capture_session_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} in ('starting','live')`),
    index("capture_session_creator_idx").on(t.createdBy, t.createdAt.desc()),
    index("capture_session_flow_idx").on(t.flowId),
    index("capture_session_discovered_idx").on(t.discoveredPageId),
  ],
);

/**
 * One instruction from the operator to the live page.
 *
 * Append-only and durable rather than fire-and-forget, so a command issued
 * while the CMS was mid-reload is not lost, and so the session has a readable
 * history — "how did the researcher get to this state?" is answerable after
 * the fact, which matters for a capture that someone later disputes.
 *
 * `payload` is validated against `sessionCommandPayloadSchema` on write. The
 * command vocabulary is input events only: there is no command that evaluates
 * operator-supplied script inside the capture sandbox.
 */
export const captureSessionCommands = pgTable(
  "capture_session_commands",
  {
    id: primaryId(),
    sessionId: fk("session_id")
      .notNull()
      .references(() => captureSessions.id, { onDelete: "cascade" }),
    /** Monotonic per session. Also the execution order. */
    seq: integer("seq").notNull(),
    /** A `SESSION_COMMAND_TYPES` value. Text, validated by Zod at the edge. */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: sessionCommandStatusEnum("status").notNull().default("pending"),
    /** What the worker reported back: the new URL, the created screen id. */
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    errorMessage: text("error_message"),
    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    uniqueIndex("capture_session_command_seq_key").on(t.sessionId, t.seq),
    // What the worker long-polls for.
    index("capture_session_command_pending_idx")
      .on(t.sessionId, t.seq)
      .where(sql`${t.status} = 'pending'`),
    index("capture_session_command_session_idx").on(t.sessionId, t.createdAt.desc()),
  ],
);

export const captureSessionsRelations = relations(captureSessions, ({ one, many }) => ({
  source: one(sources, { fields: [captureSessions.sourceId], references: [sources.id] }),
  discoveredPage: one(discoveredPages, {
    fields: [captureSessions.discoveredPageId],
    references: [discoveredPages.id],
  }),
  creator: one(users, { fields: [captureSessions.createdBy], references: [users.id] }),
  commands: many(captureSessionCommands),
}));

export const captureSessionCommandsRelations = relations(captureSessionCommands, ({ one }) => ({
  session: one(captureSessions, {
    fields: [captureSessionCommands.sessionId],
    references: [captureSessions.id],
  }),
}));

export type CaptureSessionRow = typeof captureSessions.$inferSelect;
export type CaptureSessionInsert = typeof captureSessions.$inferInsert;
export type CaptureSessionCommandRow = typeof captureSessionCommands.$inferSelect;
