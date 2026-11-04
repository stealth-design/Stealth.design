/**
 * Audit recording (§21).
 *
 * Every consequential mutation calls `recordAudit` inside the same transaction
 * as the change it describes. That coupling is the point: an audit log that can
 * be missing entries is not an audit log, and the only reliable way to
 * guarantee it is not missing entries is to make the write atomic with the
 * mutation.
 *
 * Snapshots are field-level and driven by the action's own metadata
 * (`AUDIT_ACTIONS[action].snapshot`), so the log records what changed rather
 * than dumping whole rows — a full-row snapshot on every edit would bloat the
 * table and bury the one field that actually moved.
 */
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { type Db, auditEvents } from "@uxd/database";
import { type Logger, uuidv7 } from "@uxd/shared";
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEntityType,
  auditSentence,
} from "@uxd/types";
import { type AnyContext, actorIdFor, actorLabelFor, actorTypeFor } from "./context.js";

export interface RecordAuditInput {
  readonly action: AuditAction;
  readonly entityType?: AuditEntityType;
  readonly entityId?: string | null;
  /** Human name of the thing, captured now so the log reads correctly even
   * after the record is deleted. */
  readonly entityLabel?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  /** Groups the rows of one bulk operation (§16). */
  readonly batchId?: string | null;
  readonly context?: Record<string, unknown>;
}

/**
 * Fields never written into an audit snapshot.
 *
 * A snapshot is a diff of what an operator changed; it must not become a
 * durable copy of a secret. `passwordHash` in particular would otherwise be
 * captured by a `user.updated` snapshot and retained indefinitely.
 */
const SNAPSHOT_EXCLUDED = new Set([
  "passwordHash",
  "password_hash",
  "tokenHash",
  "token_hash",
  "searchVector",
  "search_vector",
  "leaseToken",
  "lease_token",
]);

/** Field-level diff of two row shapes. Returns null when nothing changed. */
export function diffFields<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  options: { readonly only?: readonly string[] } = {},
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  if (!before || !after) return null;
  const keys = options.only ?? [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};

  for (const key of keys) {
    if (SNAPSHOT_EXCLUDED.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (isEqual(a, b)) continue;
    beforeDiff[key] = normalise(a);
    afterDiff[key] = normalise(b);
  }

  return Object.keys(afterDiff).length > 0 ? { before: beforeDiff, after: afterDiff } : null;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Dates to ISO, long strings truncated, so a snapshot stays readable. */
function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 2_000) {
    return `${value.slice(0, 2_000)}…[${value.length} chars]`;
  }
  return value;
}

/**
 * Write an audit row.
 *
 * Call inside the mutation's transaction, passing `context.db` from an
 * `inTransaction` block. Never throws in a way that could roll back the caller
 * for a logging reason alone — but it does not swallow errors either: a failing
 * audit write means the transaction fails, which is the correct trade for a
 * mutation that must be attributable.
 */
export async function recordAudit(
  db: Db,
  context: AnyContext,
  input: RecordAuditInput,
): Promise<void> {
  const meta = AUDIT_ACTIONS[input.action];
  const entityType = input.entityType ?? meta.entity;

  const snapshot = meta.snapshot
    ? { before: input.before ?? null, after: input.after ?? null }
    : { before: null, after: null };

  await db.insert(auditEvents).values({
    id: uuidv7(),
    actorType: actorTypeFor(context),
    actorId: actorIdFor(context),
    actorLabel: actorLabelFor(context),
    action: input.action,
    entityType,
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel?.slice(0, 300) ?? null,
    before: snapshot.before,
    after: snapshot.after,
    batchId: input.batchId ?? null,
    requestId: context.requestId,
    ip: context.ip,
    userAgent: context.userAgent?.slice(0, 500) ?? null,
    context: input.context ?? {},
  });
}

/**
 * Record one audit row per item in a bulk operation, plus a summary row.
 *
 * §16 wants bulk approve/reject/publish/archive, and §21 wants every mutation
 * audited. Doing both naively produces forty rows for one click. The `batchId`
 * ties them together so the CMS shows one entry — "Ada published 40 items" —
 * that expands to the individual rows, without losing per-record
 * attributability.
 */
export async function recordBulkAudit(
  db: Db,
  context: AnyContext,
  input: {
    readonly action: AuditAction;
    readonly entityType: AuditEntityType;
    readonly items: readonly { id: string; label?: string | null }[];
    readonly summary: string;
    readonly context?: Record<string, unknown>;
  },
): Promise<string> {
  const batchId = uuidv7();

  await recordAudit(db, context, {
    action: "bulk.executed",
    entityType: "system",
    entityId: batchId,
    entityLabel: input.summary,
    batchId,
    context: {
      ...input.context,
      operation: input.action,
      entityType: input.entityType,
      count: input.items.length,
    },
  });

  for (const item of input.items) {
    await recordAudit(db, context, {
      action: input.action,
      entityType: input.entityType,
      entityId: item.id,
      entityLabel: item.label ?? null,
      batchId,
    });
  }

  return batchId;
}

// --- Reading --------------------------------------------------------------

export interface AuditQuery {
  readonly entityType?: AuditEntityType;
  /** Several types at once, for the Audit log screen's filter chips. */
  readonly entityTypes?: readonly AuditEntityType[];
  readonly entityId?: string;
  readonly actorId?: string;
  readonly actions?: readonly AuditAction[];
  /** All rows of one bulk operation. */
  readonly batchId?: string;
  /** Substring match on the entity label, the actor label or the action. */
  readonly q?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly significantOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly sentence: string;
  readonly actorLabel: string | null;
  readonly actorType: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly entityLabel: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly batchId: string | null;
  /**
   * How many rows share this row's batch.
   *
   * Approving forty records writes forty rows, and a log that renders those as
   * forty lines buries everything else that happened. With the size on each
   * row the screen can collapse them into one expandable entry without a
   * follow-up query per row.
   */
  readonly batchSize: number;
  readonly requestId: string | null;
  readonly context: Record<string, unknown>;
  readonly createdAt: Date;
  readonly significant: boolean;
}

export async function listAuditEvents(
  db: Db,
  query: AuditQuery,
): Promise<{ rows: AuditRow[]; total: number }> {
  const conditions = [];
  if (query.entityType) conditions.push(eq(auditEvents.entityType, query.entityType));
  if (query.entityTypes && query.entityTypes.length > 0) {
    conditions.push(inArray(auditEvents.entityType, [...query.entityTypes]));
  }
  if (query.entityId) conditions.push(eq(auditEvents.entityId, query.entityId));
  if (query.actorId) conditions.push(eq(auditEvents.actorId, query.actorId));
  if (query.batchId) conditions.push(eq(auditEvents.batchId, query.batchId));
  if (query.q && query.q.trim().length > 0) {
    // A substring match, not full text: the useful searches here are a record
    // title, a person's name and an action name, all of which are short labels
    // where `ilike` is both adequate and predictable.
    const term = `%${query.q.trim().slice(0, 200)}%`;
    conditions.push(
      or(
        sql`${auditEvents.entityLabel} ilike ${term}`,
        sql`${auditEvents.actorLabel} ilike ${term}`,
        sql`${auditEvents.action} ilike ${term}`,
      )!,
    );
  }
  if (query.actions && query.actions.length > 0) {
    conditions.push(inArray(auditEvents.action, [...query.actions]));
  }
  if (query.from) conditions.push(gte(auditEvents.createdAt, query.from));
  if (query.to) conditions.push(lte(auditEvents.createdAt, query.to));
  if (query.significantOnly) {
    const significant = (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
      (a) => AUDIT_ACTIONS[a].significant,
    );
    conditions.push(inArray(auditEvents.action, significant));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        row: auditEvents,
        batchSize: sql<number>`case
          when ${auditEvents}.batch_id is null then 1
          else (select count(*)::int from ${auditEvents} b where b.batch_id = ${auditEvents}.batch_id)
        end`,
      })
      .from(auditEvents)
      .where(where)
      // Tie-broken on the id, which is a uuidv7 and therefore time-ordered, so
      // two events written in the same millisecond still paginate stably.
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where),
  ]);

  return {
    rows: rows.map(({ row, batchSize }) => ({
      id: row.id,
      action: row.action,
      sentence: auditSentence(
        row.actorLabel ?? "Someone",
        row.action as AuditAction,
        row.entityLabel,
      ),
      actorLabel: row.actorLabel,
      actorType: row.actorType,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: row.entityLabel,
      before: row.before ?? null,
      after: row.after ?? null,
      batchId: row.batchId,
      batchSize,
      requestId: row.requestId,
      context: row.context,
      createdAt: row.createdAt,
      significant: AUDIT_ACTIONS[row.action as AuditAction]?.significant ?? false,
    })),
    total: countResult[0]?.n ?? 0,
  };
}

/** The audit history for one record, for the content and media detail pages. */
export async function entityHistory(
  db: Db,
  entityType: AuditEntityType,
  entityId: string,
  limit = 50,
): Promise<AuditRow[]> {
  const { rows } = await listAuditEvents(db, { entityType, entityId, limit });
  return rows;
}

/** Recent significant activity, for the dashboard's "what changed" panel. */
export async function recentActivity(db: Db, limit = 20): Promise<AuditRow[]> {
  const { rows } = await listAuditEvents(db, { significantOnly: true, limit });
  return rows;
}

/**
 * Log an audit failure without failing the caller.
 *
 * Used only on paths where the mutation has already committed and an audit row
 * could not be written — a situation that should be impossible given the
 * transactional coupling, but which must be loudly visible rather than silent
 * if it ever happens.
 */
export function warnAuditFailure(logger: Logger, action: string, error: unknown): void {
  logger.error("AUDIT WRITE FAILED — a mutation may be unattributed", { action, error });
}

/**
 * Which actions actually occur, for the Audit log screen's filter chips.
 *
 * Built from the data rather than from `AUDIT_ACTIONS`, so the chips offer the
 * dozen actions a given installation really produces instead of all sixty-odd
 * the code can emit.
 */
export async function auditActionCounts(
  db: Db,
  since?: Date,
): Promise<{ action: string; label: string; count: number }[]> {
  const rows = await db
    .select({ action: auditEvents.action, n: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(since ? gte(auditEvents.createdAt, since) : undefined)
    .groupBy(auditEvents.action)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(80);

  return rows.map((row) => ({
    action: row.action,
    label: AUDIT_ACTIONS[row.action as AuditAction]?.label ?? row.action,
    count: row.n,
  }));
}
