/**
 * The durable work queue.
 *
 * Every function here is the *only* way its operation happens, so the lease
 * protocol lives in one file and nothing outside it needs to know how work is
 * claimed. That is deliberate: if this system ever outgrows a Postgres queue,
 * this module is the seam to replace.
 *
 * The protocol, and why each part exists:
 *
 *   claimItems()      Claims work with `FOR UPDATE SKIP LOCKED`, so several
 *                     workers can poll concurrently without blocking each
 *                     other and without two of them getting the same URL.
 *                     Returns a `leaseToken` per item.
 *
 *   heartbeat()       Extends a lease. A worker capturing a slow page keeps
 *                     its claim alive; one that has hung or died stops
 *                     extending and its claim expires.
 *
 *   completeItem()    Records the outcome. Requires the matching lease token,
 *                     so a worker that woke up after its lease expired cannot
 *                     overwrite the newer attempt's result.
 *
 *   reclaimExpiredLeases()
 *                     Returns abandoned items to `pending` with a backoff.
 *                     This is what makes §6's "do not lose state if the worker
 *                     crashes" true: a `kill -9` mid-capture costs one lease
 *                     interval, not the item.
 *
 * All counter updates happen in the same transaction as the state change, so
 * the job's progress figures can never disagree with its items.
 */
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  type Logger,
  addMs,
  backoffDelay,
  secretToken,
  uuidv7,
} from "@uxd/shared";
import {
  type JobEventCode,
  type JobItemStatus,
  JOB_PRIORITY_WEIGHT,
  type JobPriority,
} from "@uxd/types";
import type { Database, Db } from "./client.js";
import { crawlJobEvents, crawlJobItems, crawlJobs } from "./schema/jobs.js";

// --- Claiming -------------------------------------------------------------

export interface ClaimedItem {
  readonly id: string;
  readonly jobId: string;
  readonly url: string;
  readonly normalizedUrlHash: string;
  readonly host: string;
  readonly depth: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  /** The job's configuration, so the worker needs no second round trip. */
  readonly config: unknown;
  readonly jobReference: string;
}

export interface ClaimOptions {
  readonly workerName: string;
  readonly limit: number;
  readonly leaseMs: number;
  /** Restrict to one job. Used by the "run this job now" action. */
  readonly jobId?: string;
  readonly logger?: Logger;
}

/**
 * Claim up to `limit` items.
 *
 * The `SELECT ... FOR UPDATE SKIP LOCKED` subquery is the whole mechanism:
 * rows another transaction is already claiming are skipped rather than waited
 * on, so N workers polling simultaneously each get a distinct batch instead of
 * serialising behind one lock.
 *
 * Only items belonging to a `queued` or `running` job are eligible, which is
 * how pause works — pausing sets the job to `paused`, and its items simply stop
 * being visible to this query. Items already in flight finish normally.
 */
export async function claimItems(db: Database, options: ClaimOptions): Promise<ClaimedItem[]> {
  const leaseToken = secretToken(16);
  const leaseExpiresAt = addMs(new Date(), options.leaseMs);

  const jobFilter = options.jobId ? sql`and i.job_id = ${options.jobId}` : sql``;

  const claimed = await db.execute<{
    id: string;
    job_id: string;
    url: string;
    normalized_url_hash: string;
    host: string;
    depth: number;
    attempts: number;
    max_attempts: number;
    config: unknown;
    reference: string;
  }>(sql`
    with claimable as (
      -- The job's config and reference are selected here, inside the CTE,
      -- rather than joined in the UPDATE's FROM clause: Postgres forbids
      -- referencing the update target table from within its own FROM join
      -- condition, so joining crawl_jobs on t.job_id is not available to us.
      -- Carrying the columns through the CTE gives the worker its config in
      -- the same round trip.
      select i.id, j.config, j.reference
      from ${crawlJobItems} i
      join ${crawlJobs} j on j.id = i.job_id
      where i.status = 'pending'
        and i.available_at <= now()
        and j.status in ('queued', 'running')
        ${jobFilter}
      order by i.priority desc, i.available_at asc, i.id asc
      -- Lock only the item rows, and skip any another worker is already
      -- claiming rather than waiting behind it.
      for update of i skip locked
      limit ${options.limit}
    )
    update ${crawlJobItems} as t
    set status = 'leased',
        lease_token = ${leaseToken},
        leased_by = ${options.workerName},
        leased_at = now(),
        lease_expires_at = ${leaseExpiresAt},
        heartbeat_at = now(),
        attempts = t.attempts + 1,
        updated_at = now()
    from claimable c
    where t.id = c.id
    returning t.id, t.job_id, t.url, t.normalized_url_hash, t.host, t.depth,
              t.attempts, t.max_attempts, c.config, c.reference
  `);

  const rows = claimed.rows;
  if (rows.length === 0) return [];

  // Move each touched job to `running` and adjust its counters. Done in one
  // statement per job rather than per item.
  const jobIds = [...new Set(rows.map((r) => r.job_id))];
  for (const jobId of jobIds) {
    const n = rows.filter((r) => r.job_id === jobId).length;
    await db
      .update(crawlJobs)
      .set({
        status: sql`case when ${crawlJobs.status} = 'queued' then 'running'::job_status else ${crawlJobs.status} end`,
        startedAt: sql`coalesce(${crawlJobs.startedAt}, now())`,
        queuedCount: sql`greatest(0, ${crawlJobs.queuedCount} - ${n})`,
        runningCount: sql`${crawlJobs.runningCount} + ${n}`,
        updatedAt: new Date(),
      })
      .where(eq(crawlJobs.id, jobId));
  }

  options.logger?.debug("Claimed queue items", { count: rows.length, worker: options.workerName });

  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    url: r.url,
    normalizedUrlHash: r.normalized_url_hash,
    host: r.host,
    depth: r.depth,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseToken,
    leaseExpiresAt,
    config: r.config,
    jobReference: r.reference,
  }));
}

/** Mark a claimed item as actively running. */
export async function markItemRunning(
  db: Db,
  itemId: string,
  leaseToken: string,
): Promise<boolean> {
  const updated = await db
    .update(crawlJobItems)
    .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(crawlJobItems.id, itemId),
        eq(crawlJobItems.leaseToken, leaseToken),
        inArray(crawlJobItems.status, ["leased", "running"]),
      ),
    )
    .returning({ id: crawlJobItems.id });
  return updated.length > 0;
}

/**
 * Extend a lease.
 *
 * Returns false when the lease is no longer ours — the item was reclaimed and
 * given to another worker while we were busy. The worker treats that as a
 * cancellation signal and abandons the capture rather than finishing work whose
 * result will be rejected anyway.
 */
export async function heartbeat(
  db: Db,
  itemIds: readonly string[],
  leaseToken: string,
  leaseMs: number,
): Promise<{ alive: string[]; lost: string[] }> {
  if (itemIds.length === 0) return { alive: [], lost: [] };
  const updated = await db
    .update(crawlJobItems)
    .set({ heartbeatAt: new Date(), leaseExpiresAt: addMs(new Date(), leaseMs) })
    .where(
      and(
        inArray(crawlJobItems.id, [...itemIds]),
        eq(crawlJobItems.leaseToken, leaseToken),
        inArray(crawlJobItems.status, ["leased", "running"]),
      ),
    )
    .returning({ id: crawlJobItems.id });

  const alive = new Set(updated.map((r) => r.id));
  return {
    alive: [...alive],
    lost: itemIds.filter((id) => !alive.has(id)),
  };
}

// --- Completion -----------------------------------------------------------

export interface CompleteItemInput {
  readonly itemId: string;
  readonly leaseToken: string;
  readonly status: Extract<
    JobItemStatus,
    "succeeded" | "failed" | "skipped_duplicate" | "skipped_limit" | "blocked"
  >;
  readonly httpStatus?: number | null;
  readonly finalUrl?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly captureId?: string | null;
  readonly contentItemId?: string | null;
  readonly durationMs?: number | null;
  readonly resultSummary?: Record<string, unknown>;
  /** Whether a retry should be scheduled instead of a terminal failure. */
  readonly retryable?: boolean;
}

export interface CompleteItemResult {
  readonly accepted: boolean;
  readonly finalStatus: JobItemStatus | null;
  readonly willRetry: boolean;
}

/**
 * Record the outcome of an attempt.
 *
 * The lease token is checked in the WHERE clause, which is what makes a stale
 * worker harmless: if its lease expired and the item was re-claimed, this
 * updates zero rows and returns `accepted: false`. The worker logs it and moves
 * on; the newer attempt owns the item.
 *
 * A retryable failure with attempts left goes back to `pending` with an
 * exponential-backoff `available_at`, rather than being retried immediately —
 * hammering a site that just timed out makes it less likely to work, not more.
 */
export async function completeItem(
  db: Database,
  input: CompleteItemInput,
): Promise<CompleteItemResult> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: crawlJobItems.id,
        jobId: crawlJobItems.jobId,
        attempts: crawlJobItems.attempts,
        maxAttempts: crawlJobItems.maxAttempts,
        startedAt: crawlJobItems.startedAt,
      })
      .from(crawlJobItems)
      .where(
        and(
          eq(crawlJobItems.id, input.itemId),
          eq(crawlJobItems.leaseToken, input.leaseToken),
          inArray(crawlJobItems.status, ["leased", "running"]),
        ),
      )
      .limit(1);

    // Stale lease, or already completed by someone else.
    if (!item) return { accepted: false, finalStatus: null, willRetry: false };

    const shouldRetry =
      input.status === "failed" && (input.retryable ?? true) && item.attempts < item.maxAttempts;

    const finalStatus: JobItemStatus = shouldRetry
      ? "pending"
      : input.status === "failed" && item.attempts >= item.maxAttempts
        ? // Out of attempts on a retryable error is still `failed` — an operator
          // can retry it by hand. `dead_letter` is reserved for errors that
          // retrying provably will not fix.
          "failed"
        : input.status;

    const durationMs =
      input.durationMs ??
      (item.startedAt ? Math.max(0, Date.now() - item.startedAt.getTime()) : null);

    await tx
      .update(crawlJobItems)
      .set({
        status: finalStatus,
        // Clear the lease so the row satisfies `crawl_job_items_lease_consistent`.
        leaseToken: null,
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: shouldRetry
          ? addMs(new Date(), backoffDelay(item.attempts, 2_000, 300_000))
          : new Date(),
        finishedAt: shouldRetry ? null : new Date(),
        durationMs,
        httpStatus: input.httpStatus ?? null,
        finalUrl: input.finalUrl ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage?.slice(0, 2000) ?? null,
        captureId: input.captureId ?? null,
        contentItemId: input.contentItemId ?? null,
        resultSummary: input.resultSummary ?? {},
        updatedAt: new Date(),
      })
      .where(eq(crawlJobItems.id, item.id));

    // Counters, in the same transaction as the state change.
    const delta: Record<string, unknown> = {
      runningCount: sql`greatest(0, ${crawlJobs.runningCount} - 1)`,
      updatedAt: new Date(),
    };
    if (shouldRetry) {
      delta.queuedCount = sql`${crawlJobs.queuedCount} + 1`;
      delta.retriedCount = sql`${crawlJobs.retriedCount} + 1`;
    } else if (finalStatus === "succeeded") {
      delta.completedCount = sql`${crawlJobs.completedCount} + 1`;
    } else if (finalStatus === "failed") {
      delta.failedCount = sql`${crawlJobs.failedCount} + 1`;
    } else if (finalStatus === "blocked") {
      delta.blockedCount = sql`${crawlJobs.blockedCount} + 1`;
    } else {
      delta.skippedCount = sql`${crawlJobs.skippedCount} + 1`;
      if (finalStatus === "skipped_duplicate") {
        delta.duplicateCount = sql`${crawlJobs.duplicateCount} + 1`;
      }
    }
    await tx.update(crawlJobs).set(delta).where(eq(crawlJobs.id, item.jobId));

    await appendJobEvent(tx, {
      jobId: item.jobId,
      itemId: item.id,
      level: input.status === "succeeded" ? "info" : shouldRetry ? "warn" : "error",
      code: shouldRetry
        ? "item_retrying"
        : input.status === "succeeded"
          ? "item_succeeded"
          : input.status === "blocked"
            ? "item_blocked"
            : input.status === "skipped_duplicate"
              ? "item_duplicate"
              : "item_failed",
      data: {
        attempt: item.attempts,
        maxAttempts: item.maxAttempts,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.httpStatus ? { httpStatus: input.httpStatus } : {}),
      },
    });

    return { accepted: true, finalStatus, willRetry: shouldRetry };
  });
}

/**
 * Return abandoned items to the queue.
 *
 * Called on a timer by the control plane. An item whose lease has expired
 * without a heartbeat had its worker die, hang, or lose the network. It goes
 * back to `pending` if it has attempts left, and to `dead_letter` if it does
 * not — an item that has consumed every attempt without ever reporting an
 * outcome is stuck on something a retry will not solve, and needs a person.
 */
export async function reclaimExpiredLeases(
  db: Database,
  logger?: Logger,
): Promise<{ requeued: number; deadLettered: number }> {
  const expired = await db
    .select({
      id: crawlJobItems.id,
      jobId: crawlJobItems.jobId,
      attempts: crawlJobItems.attempts,
      maxAttempts: crawlJobItems.maxAttempts,
      leasedBy: crawlJobItems.leasedBy,
      url: crawlJobItems.url,
    })
    .from(crawlJobItems)
    .where(
      and(
        inArray(crawlJobItems.status, ["leased", "running"]),
        isNotNull(crawlJobItems.leaseExpiresAt),
        lt(crawlJobItems.leaseExpiresAt, new Date()),
      ),
    )
    .limit(500);

  if (expired.length === 0) return { requeued: 0, deadLettered: 0 };

  let requeued = 0;
  let deadLettered = 0;
  // Jobs that lost an item to `dead_letter` here. That is a terminal status,
  // so this reclaim may have retired a job's last outstanding item — and
  // nothing else will notice, because job completion is normally checked when
  // a worker reports an outcome and a lost worker reports nothing. Without
  // this, a job whose final items die with their worker stays `running`
  // forever: no worker will ever lease them again, and no operator can tell
  // the difference between that and a crawl still in progress.
  const jobsToFinalize = new Set<string>();

  for (const item of expired) {
    const canRetry = item.attempts < item.maxAttempts;
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(crawlJobItems)
        .set({
          status: canRetry ? "pending" : "dead_letter",
          leaseToken: null,
          leasedBy: null,
          leasedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          availableAt: addMs(new Date(), backoffDelay(item.attempts, 5_000, 300_000)),
          errorCode: canRetry ? null : "WORKER_LOST",
          errorMessage: canRetry
            ? null
            : "The worker handling this URL stopped responding and it ran out of attempts.",
          finishedAt: canRetry ? null : new Date(),
          updatedAt: new Date(),
        })
        // Re-check the expiry inside the transaction: a heartbeat may have
        // landed between the select and here.
        .where(
          and(
            eq(crawlJobItems.id, item.id),
            inArray(crawlJobItems.status, ["leased", "running"]),
            lt(crawlJobItems.leaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: crawlJobItems.id });

      if (updated.length === 0) return;

      if (canRetry) {
        requeued += 1;
      } else {
        deadLettered += 1;
        jobsToFinalize.add(item.jobId);
      }

      await tx
        .update(crawlJobs)
        .set({
          runningCount: sql`greatest(0, ${crawlJobs.runningCount} - 1)`,
          queuedCount: canRetry ? sql`${crawlJobs.queuedCount} + 1` : crawlJobs.queuedCount,
          failedCount: canRetry ? crawlJobs.failedCount : sql`${crawlJobs.failedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(crawlJobs.id, item.jobId));

      await appendJobEvent(tx, {
        jobId: item.jobId,
        itemId: item.id,
        level: "warn",
        code: "item_lease_expired",
        data: { worker: item.leasedBy, attempts: item.attempts, requeued: canRetry },
      });
    });
  }

  // Outside the per-item transactions, so a job is judged on the state all of
  // them left behind rather than the state mid-loop.
  for (const jobId of jobsToFinalize) {
    const finalized = await finalizeJobIfComplete(db, jobId).catch((error) => {
      // A job left running is a reporting problem, not a data-loss one; the
      // items are already correctly terminal. Losing the reclaim's own result
      // to a throw here would be the worse outcome.
      logger?.error("Could not finalize a job after reclaiming its lost items", { jobId, error });
      return false;
    });
    if (finalized) logger?.info("Finalized a job whose last items were lost", { jobId });
  }

  if (requeued + deadLettered > 0) {
    logger?.warn("Reclaimed expired leases", { requeued, deadLettered });
  }
  return { requeued, deadLettered };
}

// --- Enqueue --------------------------------------------------------------

export interface EnqueueInput {
  readonly jobId: string;
  readonly url: string;
  readonly normalizedUrlHash: string;
  readonly host: string;
  readonly depth?: number;
  readonly parentItemId?: string | null;
  readonly discoveredFromUrl?: string | null;
  readonly priority?: JobPriority;
  readonly maxAttempts?: number;
}

/**
 * Add URLs to a job.
 *
 * `onConflictDoNothing` on `(job_id, normalized_url_hash)` makes this
 * idempotent, which matters for discovery: a crawl that finds the same link on
 * forty pages tries to enqueue it forty times, and forty-nine times out of
 * fifty the right answer is "already queued, carry on".
 *
 * Returns how many were actually new, which is what the discovery limits count.
 */
export async function enqueueItems(
  db: Db,
  items: readonly EnqueueInput[],
): Promise<{ inserted: number; ids: string[] }> {
  if (items.length === 0) return { inserted: 0, ids: [] };

  const rows = items.map((item) => ({
    id: uuidv7(),
    jobId: item.jobId,
    url: item.url,
    normalizedUrlHash: item.normalizedUrlHash,
    host: item.host,
    depth: item.depth ?? 0,
    parentItemId: item.parentItemId ?? null,
    discoveredFromUrl: item.discoveredFromUrl ?? null,
    priority: JOB_PRIORITY_WEIGHT[item.priority ?? "normal"],
    maxAttempts: item.maxAttempts ?? 3,
    status: "pending" as const,
  }));

  const inserted = await db
    .insert(crawlJobItems)
    .values(rows)
    .onConflictDoNothing({ target: [crawlJobItems.jobId, crawlJobItems.normalizedUrlHash] })
    .returning({ id: crawlJobItems.id });

  if (inserted.length > 0) {
    const jobId = items[0]!.jobId;
    await db
      .update(crawlJobs)
      .set({
        queuedCount: sql`${crawlJobs.queuedCount} + ${inserted.length}`,
        updatedAt: new Date(),
      })
      .where(eq(crawlJobs.id, jobId));
  }

  return { inserted: inserted.length, ids: inserted.map((r) => r.id) };
}

// --- Job control (§6) -----------------------------------------------------

/**
 * Pause a job.
 *
 * Pausing does not touch items. It flips the job's status, and `claimItems`
 * stops seeing that job's work — items already leased finish normally, which is
 * what an operator expects from "pause" (as opposed to "cancel").
 */
export async function pauseJob(db: Db, jobId: string, actorLabel: string): Promise<boolean> {
  const updated = await db
    .update(crawlJobs)
    .set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(crawlJobs.id, jobId), inArray(crawlJobs.status, ["queued", "running"])))
    .returning({ id: crawlJobs.id });
  if (updated.length > 0) {
    await appendJobEvent(db, { jobId, level: "info", code: "job_paused", actor: actorLabel });
  }
  return updated.length > 0;
}

export async function resumeJob(db: Db, jobId: string, actorLabel: string): Promise<boolean> {
  const updated = await db
    .update(crawlJobs)
    .set({ status: "running", pausedAt: null, updatedAt: new Date() })
    .where(and(eq(crawlJobs.id, jobId), eq(crawlJobs.status, "paused")))
    .returning({ id: crawlJobs.id });
  if (updated.length > 0) {
    await appendJobEvent(db, { jobId, level: "info", code: "job_resumed", actor: actorLabel });
  }
  return updated.length > 0;
}

/**
 * Cancel a job.
 *
 * Pending items are cancelled immediately. Items in flight cannot be
 * interrupted from here — the worker notices on its next heartbeat that the job
 * is cancelling and stops — so the job sits in `cancelling` until those drain,
 * then `finalizeJobIfComplete` moves it to `cancelled`.
 *
 * Completed work and its media are kept. A cancelled job that captured 40 of
 * 250 pages has 40 real captures, and throwing them away would waste the
 * bandwidth and the site's patience.
 */
export async function cancelJob(
  db: Database,
  jobId: string,
  actorLabel: string,
): Promise<{ cancelled: number; inFlight: number }> {
  return db.transaction(async (tx) => {
    const cancelledItems = await tx
      .update(crawlJobItems)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(crawlJobItems.jobId, jobId), eq(crawlJobItems.status, "pending")))
      .returning({ id: crawlJobItems.id });

    const inFlightRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(crawlJobItems)
      .where(and(eq(crawlJobItems.jobId, jobId), inArray(crawlJobItems.status, ["leased", "running"])));
    const inFlight = inFlightRows[0]?.n ?? 0;

    await tx
      .update(crawlJobs)
      .set({
        status: inFlight > 0 ? "cancelling" : "cancelled",
        cancelledAt: new Date(),
        finishedAt: inFlight > 0 ? null : new Date(),
        queuedCount: 0,
        skippedCount: sql`${crawlJobs.skippedCount} + ${cancelledItems.length}`,
        updatedAt: new Date(),
      })
      .where(eq(crawlJobs.id, jobId));

    await appendJobEvent(tx, {
      jobId,
      level: "warn",
      code: "job_cancelled",
      actor: actorLabel,
      data: { cancelledItems: cancelledItems.length, inFlight },
    });

    return { cancelled: cancelledItems.length, inFlight };
  });
}

/**
 * Requeue failed items (§6 "retry failed / retry selected / retry entire job").
 *
 * Resets the attempt counter, because an operator pressing Retry after fixing
 * something is starting over, not continuing a doomed sequence.
 */
export async function retryItems(
  db: Database,
  input: {
    jobId: string;
    itemIds?: readonly string[];
    statuses?: readonly JobItemStatus[];
    actorLabel: string;
  },
): Promise<number> {
  const statuses = input.statuses ?? (["failed", "dead_letter"] as const);
  const scope = input.itemIds && input.itemIds.length > 0
    ? and(eq(crawlJobItems.jobId, input.jobId), inArray(crawlJobItems.id, [...input.itemIds]))
    : and(eq(crawlJobItems.jobId, input.jobId), inArray(crawlJobItems.status, [...statuses]));

  return db.transaction(async (tx) => {
    const requeued = await tx
      .update(crawlJobItems)
      .set({
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
        leaseToken: null,
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(scope)
      .returning({ id: crawlJobItems.id });

    if (requeued.length === 0) return 0;

    await tx
      .update(crawlJobs)
      .set({
        status: sql`case when ${crawlJobs.status} in ('completed','completed_with_errors','failed','cancelled') then 'queued'::job_status else ${crawlJobs.status} end`,
        queuedCount: sql`${crawlJobs.queuedCount} + ${requeued.length}`,
        failedCount: sql`greatest(0, ${crawlJobs.failedCount} - ${requeued.length})`,
        retriedCount: sql`${crawlJobs.retriedCount} + ${requeued.length}`,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(crawlJobs.id, input.jobId));

    await appendJobEvent(tx, {
      jobId: input.jobId,
      level: "info",
      code: "item_queued",
      actor: input.actorLabel,
      message: `Requeued ${requeued.length} item${requeued.length === 1 ? "" : "s"} for another attempt`,
      data: { count: requeued.length },
    });

    return requeued.length;
  });
}

/**
 * Move a job to a terminal status once no work remains.
 *
 * Called after each item completes. `completed_with_errors` rather than
 * `completed` when anything failed, because "finished" and "finished, but 12
 * pages did not capture" need to look different in a job list.
 */
export async function finalizeJobIfComplete(db: Database, jobId: string): Promise<boolean> {
  const [counts] = await db
    .select({
      outstanding: sql<number>`count(*) filter (where ${crawlJobItems.status} in ('pending','leased','running'))::int`,
      failed: sql<number>`count(*) filter (where ${crawlJobItems.status} in ('failed','dead_letter'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(crawlJobItems)
    .where(eq(crawlJobItems.jobId, jobId));

  if (!counts || counts.outstanding > 0) return false;

  const [job] = await db
    .select({ status: crawlJobs.status, startedAt: crawlJobs.startedAt })
    .from(crawlJobs)
    .where(eq(crawlJobs.id, jobId))
    .limit(1);
  if (!job) return false;

  const terminal =
    job.status === "cancelling" || job.status === "cancelled"
      ? "cancelled"
      : counts.failed > 0
        ? "completed_with_errors"
        : "completed";

  const finishedAt = new Date();
  const updated = await db
    .update(crawlJobs)
    .set({
      status: terminal,
      finishedAt,
      durationMs: job.startedAt ? finishedAt.getTime() - job.startedAt.getTime() : null,
      runningCount: 0,
      queuedCount: 0,
      updatedAt: finishedAt,
    })
    .where(and(eq(crawlJobs.id, jobId), inArray(crawlJobs.status, ["queued", "running", "cancelling"])))
    .returning({ id: crawlJobs.id });

  if (updated.length > 0) {
    await appendJobEvent(db, {
      jobId,
      level: counts.failed > 0 ? "warn" : "info",
      code: terminal === "cancelled" ? "job_cancelled" : "job_completed",
      data: { total: counts.total, failed: counts.failed, durationMs: job.startedAt ? finishedAt.getTime() - job.startedAt.getTime() : null },
    });
  }
  return updated.length > 0;
}

/**
 * Recount a job's counters from its items.
 *
 * The incremental counters are maintained transactionally and should not drift,
 * but "should not" is not "cannot" — a crash between two statements, or a
 * hand-written UPDATE during an incident, can leave them wrong. This is the
 * repair, exposed as a button on the job page rather than hidden in a script.
 */
export async function recomputeJobCounters(db: Database, jobId: string): Promise<void> {
  await db.execute(sql`
    update ${crawlJobs} j
    set queued_count    = c.pending,
        running_count   = c.running,
        completed_count = c.succeeded,
        failed_count    = c.failed,
        skipped_count   = c.skipped,
        blocked_count   = c.blocked,
        updated_at      = now()
    from (
      select
        count(*) filter (where status = 'pending')::int                              as pending,
        count(*) filter (where status in ('leased','running'))::int                  as running,
        count(*) filter (where status = 'succeeded')::int                            as succeeded,
        count(*) filter (where status in ('failed','dead_letter'))::int              as failed,
        count(*) filter (where status in ('skipped_duplicate','skipped_limit','cancelled'))::int as skipped,
        count(*) filter (where status = 'blocked')::int                              as blocked
      from ${crawlJobItems}
      where job_id = ${jobId}
    ) c
    where j.id = ${jobId}
  `);
}

// --- Events ---------------------------------------------------------------

export interface JobEventInput {
  readonly jobId: string;
  readonly itemId?: string | null;
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly code: JobEventCode | string;
  readonly message?: string | null;
  readonly data?: Record<string, unknown>;
  readonly actor?: string | null;
}

export async function appendJobEvent(db: Db, input: JobEventInput): Promise<void> {
  await db.insert(crawlJobEvents).values({
    id: uuidv7(),
    jobId: input.jobId,
    itemId: input.itemId ?? null,
    level: input.level ?? "info",
    code: input.code,
    message: input.message ?? null,
    data: input.data ?? {},
    actor: input.actor ?? null,
  });
}

/** Recent events for a job, newest first. */
export async function listJobEvents(
  db: Db,
  jobId: string,
  options: { limit?: number; levels?: readonly ("debug" | "info" | "warn" | "error")[] } = {},
) {
  const conditions = [eq(crawlJobEvents.jobId, jobId)];
  if (options.levels && options.levels.length > 0) {
    conditions.push(inArray(crawlJobEvents.level, [...options.levels]));
  }
  return db
    .select()
    .from(crawlJobEvents)
    .where(and(...conditions))
    .orderBy(desc(crawlJobEvents.createdAt))
    .limit(options.limit ?? 200);
}

// --- Queue health (§24) ---------------------------------------------------

export interface QueueHealth {
  readonly pending: number;
  readonly inFlight: number;
  readonly expiredLeases: number;
  readonly activeJobs: number;
  /** Oldest pending item's age, in ms. The number that says "the queue is
   * stuck" more clearly than a depth does. */
  readonly oldestPendingAgeMs: number | null;
}

export async function queueHealth(db: Db): Promise<QueueHealth> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${crawlJobItems.status} = 'pending')::int`,
      inFlight: sql<number>`count(*) filter (where ${crawlJobItems.status} in ('leased','running'))::int`,
      expiredLeases: sql<number>`count(*) filter (where ${crawlJobItems.status} in ('leased','running') and ${crawlJobItems.leaseExpiresAt} < now())::int`,
      oldestPending: sql<Date | null>`min(${crawlJobItems.createdAt}) filter (where ${crawlJobItems.status} = 'pending')`,
    })
    .from(crawlJobItems);

  const [jobs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crawlJobs)
    .where(inArray(crawlJobs.status, ["queued", "running"]));

  const oldest = row?.oldestPending ? new Date(row.oldestPending) : null;
  return {
    pending: row?.pending ?? 0,
    inFlight: row?.inFlight ?? 0,
    expiredLeases: row?.expiredLeases ?? 0,
    activeJobs: jobs?.n ?? 0,
    oldestPendingAgeMs: oldest ? Date.now() - oldest.getTime() : null,
  };
}

/** Items an operator needs to look at: dead-lettered or blocked. */
export async function listNeedsAttentionItems(db: Db, limit = 100) {
  return db
    .select({
      id: crawlJobItems.id,
      jobId: crawlJobItems.jobId,
      url: crawlJobItems.url,
      status: crawlJobItems.status,
      errorCode: crawlJobItems.errorCode,
      errorMessage: crawlJobItems.errorMessage,
      attempts: crawlJobItems.attempts,
      finishedAt: crawlJobItems.finishedAt,
      jobReference: crawlJobs.reference,
      jobName: crawlJobs.name,
    })
    .from(crawlJobItems)
    .innerJoin(crawlJobs, eq(crawlJobs.id, crawlJobItems.jobId))
    .where(inArray(crawlJobItems.status, ["dead_letter", "blocked", "failed"]))
    .orderBy(desc(crawlJobItems.finishedAt))
    .limit(limit);
}

/** Whether a job is still accepting work, checked by the worker mid-capture. */
export async function isJobActive(db: Db, jobId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: crawlJobs.status })
    .from(crawlJobs)
    .where(eq(crawlJobs.id, jobId))
    .limit(1);
  return row?.status === "queued" || row?.status === "running";
}

/** Per-host pending counts, for politeness scheduling and the job detail page. */
export async function pendingByHost(db: Db, jobId: string, limit = 50) {
  return db
    .select({
      host: crawlJobItems.host,
      pending: sql<number>`count(*) filter (where ${crawlJobItems.status} = 'pending')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(crawlJobItems)
    .where(eq(crawlJobItems.jobId, jobId))
    .groupBy(crawlJobItems.host)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export { asc, or };
