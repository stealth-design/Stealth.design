/**
 * Request context.
 *
 * One object carrying everything a handler or service needs: the database, the
 * storage driver, the classification provider, the logger, and the principal.
 * Passed explicitly rather than reached for through module state, so a service
 * can be called from three entry points — an HTTP route, a Next.js server
 * action, or a test — with no ambient setup.
 *
 * That matters for the architecture the brief asks for. §19 wants admin and
 * public APIs separated, and the CMS wants server-side rendering without an
 * HTTP hop to itself. Both are satisfied by putting the real work in services
 * that take a context, and making the routers and server actions two thin
 * callers of the same functions. There is exactly one implementation of
 * "publish this record", and it cannot behave differently depending on which
 * door the request came through.
 */
import type { Database, Db } from "@uxd/database";
import type { StorageDriver } from "@uxd/media";
import type { ClassificationProvider } from "@uxd/classification";
import type { Actor, ServiceActor } from "@uxd/auth";
import type { CmsEnv } from "@uxd/shared/env";
import type { Logger } from "@uxd/shared";

/** Everything available regardless of who is asking. */
export interface BaseContext {
  readonly db: Database;
  readonly storage: StorageDriver;
  readonly classifier: ClassificationProvider;
  readonly logger: Logger;
  readonly env: CmsEnv;
  /** Correlates logs, audit rows and job events for one request. */
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** A request from a signed-in CMS user. */
export interface AdminContext extends BaseContext {
  readonly actor: Actor;
}

/** A request from the capture worker to `/api/internal/*`. */
export interface WorkerContext extends BaseContext {
  readonly worker: ServiceActor;
}

/** An unauthenticated request to `/api/public/*`. */
export type PublicContext = BaseContext;

/** A background task with no requester. */
export interface SystemContext extends BaseContext {
  readonly actorLabel: string;
}

export type AnyContext = BaseContext & {
  readonly actor?: Actor;
  readonly worker?: ServiceActor;
  readonly actorLabel?: string;
};

/**
 * Run a function inside a transaction, with the context's `db` swapped for the
 * transaction handle.
 *
 * Every multi-table mutation goes through this. It is why a content record and
 * its audit row and its counter update either all land or none do — a published
 * record with no audit trail, or a job counter that disagrees with its items,
 * are both states this makes unreachable.
 */
export async function inTransaction<C extends BaseContext, T>(
  context: C,
  fn: (context: C & { db: Db }) => Promise<T>,
): Promise<T> {
  return context.db.transaction(async (tx) => fn({ ...context, db: tx } as C & { db: Db }));
}

/** Human label for the actor behind a context, for audit rows and job logs. */
export function actorLabelFor(context: AnyContext): string {
  if (context.actor) return `${context.actor.name} <${context.actor.email}>`;
  if (context.worker) return `worker:${context.worker.name}`;
  return context.actorLabel ?? "system";
}

export function actorTypeFor(context: AnyContext): "user" | "worker" | "system" {
  if (context.actor) return "user";
  if (context.worker) return "worker";
  return "system";
}

export function actorIdFor(context: AnyContext): string | null {
  return context.actor?.id ?? null;
}
