/**
 * Capture-worker authentication.
 *
 * The worker presents a bearer token to `/api/internal/*`. Two independent
 * mechanisms are accepted:
 *
 *   1. A row in `worker_tokens`, hashed. Revocable per worker, which is what
 *      production should use.
 *   2. `WORKER_SHARED_SECRET`, compared in constant time. A bootstrap path so
 *      a single-worker local setup does not need a provisioning step before it
 *      can capture anything.
 *
 * Either way the result is a `ServiceActor` with scopes — never an `Actor` with
 * a role. A worker credential cannot satisfy a CMS permission check, because
 * `requirePermission` only accepts an actor carrying a role.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { type Db, schema } from "@uxd/database";
import { sha256Hex, timingSafeEqualHex, unauthenticated } from "@uxd/shared";
import type { ServiceActor } from "./permissions.js";

const { workerTokens } = schema;

export const WORKER_SCOPE_CAPTURE = "capture";

export interface WorkerAuthConfig {
  /** Bootstrap secret from the CMS environment. */
  readonly sharedSecret: string;
}

/** Extract a bearer token from an Authorization header. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export async function authenticateWorker(
  db: Db,
  config: WorkerAuthConfig,
  token: string | null,
  options: { readonly reportedName?: string | null } = {},
): Promise<ServiceActor> {
  if (!token) throw unauthenticated("A worker token is required.");

  // Bootstrap path: the shared secret. Constant-time so a wrong token cannot
  // be recovered byte by byte from response timing.
  if (
    config.sharedSecret.length > 0 &&
    token.length === config.sharedSecret.length &&
    timingSafeEqualHex(sha256Hex(token), sha256Hex(config.sharedSecret))
  ) {
    // With the shared secret there is exactly one credential, so every worker
    // presenting it is the same principal and a self-reported name cannot be
    // used to impersonate a *different* one. Adopting it therefore costs
    // nothing and makes provenance ("which worker captured this?") useful,
    // where a generic label would not be.
    //
    // A `worker_tokens` credential is different: it has its own identity, so
    // the row's name is authoritative and the reported one is ignored.
    return {
      kind: "worker",
      name: options.reportedName?.slice(0, 120) || "shared-secret-worker",
      scopes: [WORKER_SCOPE_CAPTURE],
    };
  }

  const [row] = await db
    .select()
    .from(workerTokens)
    .where(
      and(
        eq(workerTokens.tokenHash, sha256Hex(token)),
        isNull(workerTokens.revokedAt),
        or(isNull(workerTokens.expiresAt), gt(workerTokens.expiresAt, new Date())),
      ),
    )
    .limit(1);

  if (!row) throw unauthenticated("That worker token is not valid.");

  return {
    kind: "worker",
    name: row.name,
    tokenId: row.id,
    scopes: row.scopes.length > 0 ? row.scopes : [WORKER_SCOPE_CAPTURE],
  };
}

/** Record that a token was used, for the workers list in Settings. */
export async function touchWorkerToken(db: Db, tokenId: string, ip: string | null): Promise<void> {
  await db
    .update(workerTokens)
    .set({ lastSeenAt: new Date(), lastIp: ip })
    .where(eq(workerTokens.id, tokenId));
}

/** Issue a new worker token. The plaintext is returned once and never stored. */
export async function issueWorkerToken(
  db: Db,
  input: { id: string; name: string; description?: string; createdBy: string; scopes?: string[] },
): Promise<{ id: string; token: string }> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  await db.insert(workerTokens).values({
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    tokenHash: sha256Hex(token),
    scopes: input.scopes ?? [WORKER_SCOPE_CAPTURE],
    createdBy: input.createdBy,
  });
  return { id: input.id, token };
}

export async function revokeWorkerToken(db: Db, tokenId: string): Promise<void> {
  await db
    .update(workerTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(workerTokens.id, tokenId), isNull(workerTokens.revokedAt)));
}

/** Workers that have not heartbeated recently, for the health panel. */
export async function staleWorkerCount(db: Db, staleAfterMs: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.workerInstances)
    .where(
      and(
        isNull(schema.workerInstances.stoppedAt),
        sql`${schema.workerInstances.lastHeartbeatAt} < now() - (${staleAfterMs} || ' milliseconds')::interval`,
      ),
    );
  return row?.n ?? 0;
}
