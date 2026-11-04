/**
 * The capture-session lease protocol (§2, §3).
 *
 * Structurally the same as the crawl queue's lease in `queue.ts` — claim with
 * `FOR UPDATE SKIP LOCKED`, prove ownership with a token on every subsequent
 * write — but one rule differs, and it is the interesting one:
 *
 *   A crawl item whose lease expires goes back to `pending` and another worker
 *   captures it. A **session** whose lease expires is `expired`, permanently.
 *
 * That is not a shortcut. A crawl item is a URL, and any worker can fetch a
 * URL. A session is a browser someone navigated to a particular state — three
 * clicks into a checkout with a modal open. When the worker holding it dies,
 * that state dies with it. Handing the session to a second worker would give
 * the operator a browser that looks alive and is actually back on the homepage,
 * which is worse than telling them plainly that it ended.
 */
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type Logger, addMs, secretToken } from "@uxd/shared";
import { STUDIO_LIMITS } from "@uxd/types";
import type { Database, Db } from "./client.js";
import { captureSessionCommands, captureSessions } from "./schema/studio.js";

export interface ClaimedSession {
  readonly id: string;
  readonly targetUrl: string;
  readonly deviceProfile: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly leaseToken: string;
  readonly expiresAt: Date;
}

/**
 * Take the oldest session waiting for a worker.
 *
 * One at a time. A worker running two live sessions holds two browsers open
 * for as long as two people are thinking, which is a very different memory
 * profile from the batch path where a context lives for a few seconds — the
 * caller decides how many it can afford, and asks again.
 */
export async function claimSession(
  db: Database,
  options: { workerName: string; workerInstanceId?: string | null; logger?: Logger },
): Promise<ClaimedSession | null> {
  const leaseToken = secretToken(16);
  const leaseExpiresAt = addMs(new Date(), STUDIO_LIMITS.leaseSeconds * 1000);

  // `expires_at` is typed as a string here, not a Date, and that is not a
  // mistake. `db.execute` runs raw SQL and returns what the driver gives it;
  // Drizzle's column mappers only apply to the query builder. Typing it as a
  // Date compiled fine and then threw `toISOString is not a function` at the
  // first real claim — the kind of defect that only exists at the seam between
  // two layers, and only shows up against a live database.
  const claimed = await db.execute<{
    id: string;
    target_url: string;
    device_profile: string;
    viewport_width: number;
    viewport_height: number;
    device_scale_factor: number;
    expires_at: string | Date;
  }>(sql`
    with claimable as (
      select s.id
        from ${captureSessions} s
       where s.status = 'pending'
         and s.expires_at > now()
       order by s.created_at asc
       for update skip locked
       limit 1
    )
    update ${captureSessions} as t
       set status = 'starting',
           lease_token = ${leaseToken},
           worker_name = ${options.workerName},
           worker_instance_id = ${options.workerInstanceId ?? null},
           lease_expires_at = ${leaseExpiresAt},
           heartbeat_at = now(),
           started_at = now(),
           updated_at = now()
      from claimable c
     where t.id = c.id
    returning t.id, t.target_url, t.device_profile, t.viewport_width,
              t.viewport_height, t.device_scale_factor, t.expires_at
  `);

  const row = claimed.rows[0];
  if (!row) return null;

  options.logger?.info("Claimed a capture session", { sessionId: row.id, worker: options.workerName });

  return {
    id: row.id,
    targetUrl: row.target_url,
    deviceProfile: row.device_profile,
    viewportWidth: row.viewport_width,
    viewportHeight: row.viewport_height,
    deviceScaleFactor: row.device_scale_factor,
    leaseToken,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

/**
 * Prove the worker still owns this session and push the lease out.
 *
 * Returns false when the token no longer matches — the session was expired or
 * closed underneath the worker, which is the worker's signal to shut the
 * browser rather than keep photographing a page nobody is watching.
 */
export async function touchSession(
  db: Db,
  sessionId: string,
  leaseToken: string,
): Promise<boolean> {
  const updated = await db
    .update(captureSessions)
    .set({
      heartbeatAt: new Date(),
      leaseExpiresAt: addMs(new Date(), STUDIO_LIMITS.leaseSeconds * 1000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(captureSessions.id, sessionId),
        eq(captureSessions.leaseToken, leaseToken),
        inArray(captureSessions.status, ["starting", "live"]),
      ),
    )
    .returning({ id: captureSessions.id });
  return updated.length > 0;
}

/** Commands the worker has not run yet, oldest first. */
export async function pendingCommands(db: Db, sessionId: string, limit = 12) {
  return db
    .select({
      id: captureSessionCommands.id,
      seq: captureSessionCommands.seq,
      type: captureSessionCommands.type,
      payload: captureSessionCommands.payload,
    })
    .from(captureSessionCommands)
    .where(
      and(
        eq(captureSessionCommands.sessionId, sessionId),
        eq(captureSessionCommands.status, "pending"),
      ),
    )
    .orderBy(asc(captureSessionCommands.seq))
    .limit(limit);
}

/**
 * Close out sessions nobody is driving any more.
 *
 * Three separate expiries, because there are three different ways a session
 * stops mattering and conflating them would leave one of them uncovered:
 *
 *   - the hard ceiling passed (`expires_at`), whatever the activity;
 *   - a claimed session's worker stopped heartbeating, so its browser is gone;
 *   - a live session went idle — nobody watching and no commands — for long
 *     enough that holding a browser for it is waste.
 *
 * Returns how many it retired, so the caller can log a number rather than a
 * shrug.
 */
export async function expireStaleSessions(db: Db, logger?: Logger): Promise<number> {
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - STUDIO_LIMITS.idleTimeoutMs);

  const expired = await db
    .update(captureSessions)
    .set({
      status: "expired",
      closedAt: now,
      leaseToken: null,
      // The frame is the largest column in the table and it is worthless once
      // the browser behind it is gone. Dropping it here is what keeps a busy
      // week of sessions from becoming the biggest thing in the database.
      frame: null,
      frameBytes: null,
      errorCode: sql`coalesce(${captureSessions.errorCode}, 'SESSION_EXPIRED')`,
      errorMessage: sql`coalesce(${captureSessions.errorMessage}, 'The session was idle and the browser was released.')`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(captureSessions.status, ["pending", "starting", "live"]),
        or(
          lt(captureSessions.expiresAt, now),
          and(
            inArray(captureSessions.status, ["starting", "live"]),
            lt(captureSessions.leaseExpiresAt, now),
          ),
          // Idle: neither a viewer nor a command since the cutoff. `coalesce`
          // against `started_at` so a session that has never been looked at
          // still gets the full idle window rather than expiring instantly.
          and(
            eq(captureSessions.status, "live"),
            lt(sql`coalesce(${captureSessions.viewerSeenAt}, ${captureSessions.startedAt})`, idleCutoff),
            lt(sql`coalesce(${captureSessions.heartbeatAt}, ${captureSessions.startedAt})`, idleCutoff),
          ),
        ),
      ),
    )
    .returning({ id: captureSessions.id });

  if (expired.length > 0) {
    // Any command still queued for a dead session will never run. Failing them
    // explicitly is what stops the studio showing a spinner forever.
    await db
      .update(captureSessionCommands)
      .set({
        status: "failed",
        errorMessage: "The session ended before this could run.",
        finishedAt: now,
      })
      .where(
        and(
          inArray(
            captureSessionCommands.sessionId,
            expired.map((s) => s.id),
          ),
          inArray(captureSessionCommands.status, ["pending", "running"]),
        ),
      );
    logger?.info("Expired idle capture sessions", { count: expired.length });
  }

  return expired.length;
}
