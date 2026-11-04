/**
 * Server-side wiring for the CMS.
 *
 * Builds the shared singletons (database pool, storage driver, classification
 * provider, logger) once per process and hands out request contexts. Everything
 * a page, a server action or a route handler needs comes from `getContext()` or
 * `requireActor()`.
 *
 * Server components and server actions call the services in `@uxd/api`
 * *directly*, not over HTTP to this same process. There is one implementation
 * of each operation and two thin entry points into it — an HTTP route for
 * programmatic callers, and a server action for the UI — so the permission
 * checks, audit writes and transactions cannot differ between them.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { type ClassificationProvider, createClassificationProvider } from "@uxd/classification";
import { type Actor, SESSION_COOKIE_NAME, requirePermission, resolveSession } from "@uxd/auth";
import { type DatabaseHandle, getDatabase } from "@uxd/database";
import { type StorageDriver, createStorage } from "@uxd/media";
import { type Logger, createLogger, hours, uuidv7 } from "@uxd/shared";
import { type CmsEnv, loadCmsEnv, loadEnvFile } from "@uxd/shared/env";
import type { AdminContext, BaseContext } from "@uxd/api";
import type { Permission } from "@uxd/types";

// --- Process singletons ---------------------------------------------------

let cached:
  | {
      env: CmsEnv;
      logger: Logger;
      handle: DatabaseHandle;
      storage: StorageDriver;
      classifier: ClassificationProvider;
    }
  | null = null;

/**
 * Build (or reuse) the process-wide services.
 *
 * `getDatabase` caches its pool on `globalThis`, which matters in development:
 * Next re-evaluates modules on every edit, and without that cache each reload
 * would open a new pool and exhaust connections within a few minutes of work.
 */
async function services() {
  if (cached) return cached;

  loadEnvFile();
  const env = loadCmsEnv();

  const logger = createLogger({
    service: "cms",
    level: env.UXD_LOG_LEVEL,
    format: env.UXD_LOG_FORMAT,
  });

  const handle = getDatabase({
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL,
    logger,
    logQueries: env.NODE_ENV === "development" && env.UXD_LOG_LEVEL === "debug",
    applicationName: "uxd-cms",
  });

  const storage = createStorage({
    driver: env.STORAGE_DRIVER,
    localRoot: env.STORAGE_LOCAL_ROOT,
    // The local driver's files are served by this app's own /media route.
    localPublicBaseUrl: `${env.CMS_BASE_URL.replace(/\/$/, "")}/media`,
    s3:
      env.STORAGE_DRIVER === "s3"
        ? {
            bucket: env.STORAGE_S3_BUCKET!,
            region: env.STORAGE_S3_REGION,
            endpoint: env.STORAGE_S3_ENDPOINT,
            accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID!,
            secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY!,
            forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
            publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
          }
        : undefined,
    blob:
      env.STORAGE_DRIVER === "blob" && env.BLOB_READ_WRITE_TOKEN
        ? { token: env.BLOB_READ_WRITE_TOKEN, access: env.STORAGE_BLOB_ACCESS }
        : undefined,
    logger,
  });

  const classifier = await createClassificationProvider({
    provider: env.CLASSIFICATION_PROVIDER,
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.CLASSIFICATION_MODEL,
    logger,
  });

  cached = { env, logger, handle, storage, classifier };
  return cached;
}

export async function getEnv(): Promise<CmsEnv> {
  return (await services()).env;
}

export async function getLogger(): Promise<Logger> {
  return (await services()).logger;
}

export async function getDb() {
  return (await services()).handle.db;
}

export async function getStorage(): Promise<StorageDriver> {
  return (await services()).storage;
}

// --- Contexts -------------------------------------------------------------

/** A context with no principal. For sign-in and health checks. */
export async function getBaseContext(): Promise<BaseContext> {
  // Headers first, for the same prerender reason as `getActor`.
  const headerList = await headers();
  const { env, logger, handle, storage, classifier } = await services();
  return {
    db: handle.db,
    storage,
    classifier,
    logger,
    env,
    requestId: headerList.get("x-request-id") ?? uuidv7(),
    ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: headerList.get("user-agent"),
  };
}

/**
 * The signed-in actor, or null.
 *
 * `cookies()` is read *before* the services are built. That ordering matters
 * in Next: reading cookies is what opts a route out of static prerendering, and
 * if the environment were loaded first, a build with no DATABASE_URL present
 * would fail while trying to prerender pages that are inherently per-request.
 */
export async function getActor(): Promise<Actor | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const { env, handle, logger } = await services();

  const session = await resolveSession(
    handle.db,
    {
      ttlMs: hours(env.SESSION_TTL_HOURS),
      cookieSecure: env.SESSION_COOKIE_SECURE,
      logger,
    },
    token,
  );
  return session?.actor ?? null;
}

/**
 * The signed-in actor, or a redirect to sign-in.
 *
 * Used by every page in the authenticated shell. It redirects rather than
 * throwing so an unauthenticated visit to a deep link lands on the sign-in
 * form and returns afterwards.
 */
export async function requireActor(returnTo?: string): Promise<Actor> {
  const actor = await getActor();
  if (!actor) {
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login";
    redirect(target);
  }
  return actor;
}

/** An authenticated context for services. Redirects if not signed in. */
export async function getAdminContext(returnTo?: string): Promise<AdminContext> {
  const base = await getBaseContext();
  const actor = await requireActor(returnTo);
  return { ...base, actor };
}

/**
 * An authenticated context that also asserts a permission.
 *
 * Server actions call this first. `requirePermission` throws an `AppError` with
 * a 403, which the action's caller surfaces as a message — the same check the
 * HTTP API performs, because it is the same function.
 */
export async function getAdminContextWith(permission: Permission): Promise<AdminContext> {
  const context = await getAdminContext();
  requirePermission(context.actor, permission);
  return context;
}

// --- Media URLs -----------------------------------------------------------

/**
 * Resolve storage keys to URLs in one batch.
 *
 * With the S3 driver each URL may be a presign, so resolving them one at a
 * time would mean a signature per thumbnail — 48 of them on a media grid.
 */
export async function resolveMediaUrls(
  keys: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const storage = await getStorage();
  const unique = [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
  const out = new Map<string, string>();
  await Promise.all(
    unique.map(async (key) => {
      try {
        out.set(key, await storage.url(key));
      } catch {
        // A missing or unreadable object should render as a broken thumbnail,
        // not fail the whole page.
      }
    }),
  );
  return out;
}

/** Convenience for a single key. */
export async function mediaUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const resolved = await resolveMediaUrls([key]);
  return resolved.get(key) ?? null;
}
