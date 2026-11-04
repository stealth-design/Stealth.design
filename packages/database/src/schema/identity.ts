/**
 * Users, sessions and worker credentials.
 */
import { relations, sql } from "drizzle-orm";
import { index, inet, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { actorId, createdAt, deletedAt, fk, primaryId, timestamptz, updatedAt } from "./columns.js";
import { roleEnum, userStatusEnum } from "./enums.js";

export const users = pgTable(
  "users",
  {
    id: primaryId(),
    /** Stored lowercased. Uniqueness is enforced on `lower(email)` as well, so
     * a direct SQL insert cannot create a case-variant duplicate account. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: roleEnum("role").notNull().default("viewer"),
    status: userStatusEnum("status").notNull().default("invited"),

    /**
     * scrypt hash in the format `scrypt$N$r$p$salt$hash`, salt and hash
     * base64url. Null for an invited user who has not set a password yet.
     */
    passwordHash: text("password_hash"),
    passwordChangedAt: timestamptz("password_changed_at"),

    /** Consecutive failed sign-ins. Reset to 0 on success; drives lockout. */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamptz("locked_until"),

    lastLoginAt: timestamptz("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    index("users_role_idx").on(t.role),
    index("users_status_idx").on(t.status),
  ],
);

/**
 * Sessions.
 *
 * The primary key is sha256 of the session token, never the token itself. A
 * database read leaks nothing usable: an attacker holding this table still
 * cannot forge a cookie without inverting the hash.
 */
export const sessions = pgTable(
  "sessions",
  {
    /** sha256(token), hex. */
    id: text("id").primaryKey(),
    userId: fk("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
    /** Rolling sessions: refreshed on use, so an operator working a long review
     * shift is not logged out mid-queue, while an abandoned session still ages
     * out. */
    lastUsedAt: timestamptz("last_used_at").notNull().defaultNow(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/**
 * Capture-worker credentials.
 *
 * A worker authenticates to `/api/internal/*` with a bearer token whose hash is
 * stored here. Tokens are per-deployment and revocable, so retiring a worker
 * host — or cutting off one that is suspected of compromise — is a single
 * UPDATE and does not touch anything the CMS itself depends on.
 */
export const workerTokens = pgTable(
  "worker_tokens",
  {
    id: primaryId(),
    name: text("name").notNull(),
    /** sha256(token), hex. The token itself is displayed once, at creation. */
    tokenHash: text("token_hash").notNull(),
    /** Capability scopes. V1 issues `capture` only. */
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    description: text("description"),
    lastSeenAt: timestamptz("last_seen_at"),
    lastIp: inet("last_ip"),
    revokedAt: timestamptz("revoked_at"),
    expiresAt: timestamptz("expires_at"),
    createdBy: actorId("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("worker_tokens_hash_key").on(t.tokenHash),
    index("worker_tokens_revoked_idx").on(t.revokedAt),
  ],
);

/**
 * Live worker instances, populated by heartbeats.
 *
 * This is what the CMS reads to answer "are any workers actually running?" —
 * the question that explains an ingestion job sitting at Queued forever, which
 * is otherwise a genuinely hard failure for a non-engineer to diagnose (§24).
 */
export const workerInstances = pgTable(
  "worker_instances",
  {
    id: primaryId(),
    tokenId: fk("token_id").references(() => workerTokens.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    hostname: text("hostname"),
    version: text("version"),
    /** Browser version, concurrency, enabled capture levels. */
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    lastHeartbeatAt: timestamptz("last_heartbeat_at").notNull().defaultNow(),
    itemsInFlight: integer("items_in_flight").notNull().default(0),
    itemsCompleted: integer("items_completed").notNull().default(0),
    itemsFailed: integer("items_failed").notNull().default(0),
    stoppedAt: timestamptz("stopped_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("worker_instances_heartbeat_idx").on(t.lastHeartbeatAt),
    index("worker_instances_token_idx").on(t.tokenId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const workerInstancesRelations = relations(workerInstances, ({ one }) => ({
  token: one(workerTokens, { fields: [workerInstances.tokenId], references: [workerTokens.id] }),
}));
