/**
 * Database client.
 *
 * One driver (`pg`) and one dialect (PostgreSQL) for every environment. Local
 * development points `DATABASE_URL` at the embedded PGlite server started by
 * `npm run db:serve`, which speaks the real Postgres wire protocol, so there is
 * no dialect drift between a developer's machine and production — the same
 * migrations, the same SQL, the same `tsvector` and `SKIP LOCKED` behaviour.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import type { Logger } from "@uxd/shared";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

/** A transaction handle. Repository functions accept `Database | Transaction`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either a pool-backed database or an open transaction. */
export type Db = Database | Transaction;

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax?: number;
  readonly ssl?: "disable" | "require" | "no-verify";
  readonly logger?: Logger;
  /** Log every statement. Development only — statements can contain page text. */
  readonly logQueries?: boolean;
  readonly applicationName?: string;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  /** Close the pool. Bounded, so a stuck socket cannot hang a shutdown. */
  close(timeoutMs?: number): Promise<void>;
  /** Round-trip the connection. Used by the health endpoint and the dashboard. */
  ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

function sslConfig(mode: DatabaseConfig["ssl"]): pg.PoolConfig["ssl"] {
  switch (mode) {
    case "require":
      return true;
    case "no-verify":
      // For managed providers that terminate TLS with a certificate chain the
      // Node bundle does not carry. Encrypted, but unverified — acceptable only
      // when the network path itself is trusted (a VPC).
      return { rejectUnauthorized: false };
    default:
      return undefined;
  }
}

/**
 * Query executor that discards a connection whose query failed.
 *
 * Works around a limitation of the embedded PGlite dev server: an error raised
 * during an *extended-protocol* (parameterised) query leaves its socket
 * desynchronised — the next statement on that connection fails with
 * "unexpected parseComplete message from backend". Simple queries recover
 * fine, but Drizzle parameterises everything, so without this a single
 * constraint violation or bad input in development would poison a pooled
 * connection and produce a cascade of unrelated-looking errors.
 *
 * Real Postgres does not need this. It is enabled only for local drivers, and
 * the cost when it does fire is one reconnect on a path that was already
 * failing. See docs/known-limitations.md.
 */
function createResilientExecutor(pool: pg.Pool, logger?: Logger): pg.Pool {
  const wrapped = Object.create(pool) as pg.Pool;
  wrapped.query = (async (...args: unknown[]) => {
    const client = await pool.connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (client.query as any)(...args);
      client.release();
      return result;
    } catch (error) {
      // `release(err)` destroys the client rather than returning it to the pool.
      client.release(error instanceof Error ? error : new Error("query failed"));
      logger?.debug("Discarded a database connection after a failed query", {
        reason: "pglite extended-protocol desync guard",
      });
      throw error;
    }
  }) as typeof pool.query;
  return wrapped;
}

/** True for connection strings pointing at a local dev database. */
function isLocalDriver(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function createDatabase(config: DatabaseConfig): DatabaseHandle {
  const local = isLocalDriver(config.url);

  const pool = new pg.Pool({
    connectionString: config.url,
    // One connection against the PGlite dev server, ten against real Postgres.
    //
    // PGlite is a single Postgres backend compiled to WASM, and the *unnamed*
    // prepared statement that the extended protocol uses is global to that
    // backend rather than per-connection. Two pooled connections issuing
    // parameterised queries at the same time therefore overwrite each other's
    // Parse, and the loser fails with "bind message supplies N parameters, but
    // prepared statement \"\" requires M" — a confusing error with no
    // relationship to the query that reports it. Drizzle parameterises
    // everything and list queries run their rows and count concurrently, so
    // this is reachable in ordinary use, not a corner case.
    //
    // Serialising the pool removes the interleaving. Transactions are
    // unaffected: Drizzle runs a transaction's statements on the handle it was
    // given, so nothing waits on a second connection while holding the first.
    // Real Postgres keeps the unnamed statement per-session and needs none of
    // this. See docs/known-limitations.md.
    max: config.poolMax ?? (local ? 1 : 10),
    ssl: sslConfig(config.ssl),
    // A capture-heavy system produces bursts of short writes. Keep idle
    // connections briefly so a burst does not pay TLS setup per statement,
    // but not so long that a serverless platform holds them open forever.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Surfaces in pg_stat_activity, so a stuck query is attributable to a
    // service rather than to "node".
    application_name: config.applicationName ?? "uxd",
    // A single query must never be able to hold a connection indefinitely.
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });

  pool.on("error", (error) => {
    // An idle client erroring is not fatal — the pool replaces it — but it is
    // worth knowing about, because a burst of these means the database is
    // restarting or the network is flapping.
    config.logger?.error("Idle database client error", { error });
  });

  const executor = local ? createResilientExecutor(pool, config.logger) : pool;

  const db = drizzle(executor, {
    schema,
    casing: "snake_case",
    logger: config.logQueries
      ? {
          logQuery(query, params) {
            config.logger?.debug("SQL", { query, paramCount: params.length });
          },
        }
      : false,
  });

  return {
    db,
    pool,
    /**
     * Close the pool, but never hang doing it.
     *
     * `pool.end()` sends a Terminate and waits for each socket to close. The
     * PGlite dev server does not always close promptly, so an unbounded await
     * here means a script that has finished its work sits forever and CI times
     * out instead of reporting a result. It is worth bounding against real
     * Postgres too: a deploy that hangs on shutdown is worse than one that
     * drops a connection the server will reclaim on socket close anyway.
     *
     * Resolving on timeout is safe because the process is on its way out and
     * the only thing lost is the courtesy of a graceful Terminate. It is logged
     * rather than swallowed, so a pool that *always* fails to close — which
     * would mean queries are genuinely stuck — is visible.
     */
    async close(timeoutMs = 5_000) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        pool.end().then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        config.logger?.debug("Database pool did not close within the timeout", {
          timeoutMs,
          idle: pool.idleCount,
          total: pool.totalCount,
          waiting: pool.waitingCount,
        });
      }
    },
    async ping() {
      const start = performance.now();
      try {
        await db.execute(sql`select 1`);
        return { ok: true, latencyMs: Math.round(performance.now() - start) };
      } catch (error) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          error: error instanceof Error ? error.message : "unknown error",
        };
      }
    },
  };
}

/**
 * Process-wide handle.
 *
 * Next.js in development re-evaluates modules on every edit. Without this
 * cache each reload would open a fresh pool and the old ones would linger,
 * exhausting connections within a few minutes of editing. Keyed on a symbol so
 * it cannot collide with anything else on `globalThis`.
 */
const HANDLE_KEY = Symbol.for("uxd.database.handle");

interface GlobalWithHandle {
  [HANDLE_KEY]?: DatabaseHandle;
}

export function getDatabase(config: DatabaseConfig): DatabaseHandle {
  const g = globalThis as unknown as GlobalWithHandle;
  const existing = g[HANDLE_KEY];
  if (existing) return existing;
  const handle = createDatabase(config);
  g[HANDLE_KEY] = handle;
  return handle;
}

/** Drop the cached handle. Used by tests that need a clean pool. */
export async function resetDatabase(): Promise<void> {
  const g = globalThis as unknown as GlobalWithHandle;
  const existing = g[HANDLE_KEY];
  if (existing) {
    delete g[HANDLE_KEY];
    await existing.close();
  }
}

export { schema };
export { sql } from "drizzle-orm";
