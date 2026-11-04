/**
 * A locked health check: which startup step fails, and why.
 *
 * On a host that hides server errors (Vercel shows only "This page couldn't
 * load"), this is how to find out whether it is the settings, the database or
 * storage. It answers only to `Authorization: Bearer <WORKER_SHARED_SECRET>`;
 * without it the route does not exist (404), so it tells a stranger nothing.
 *
 * What it reports is safe to show its operator: setting *names* that are
 * missing or invalid, the database *host* it is trying (never the password),
 * and the database's own error message with any connection string removed.
 */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "@uxd/database";
import { createStorage } from "@uxd/media";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => new Response("Not found", { status: 404 });

function scrub(text: string): string {
  return text.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<database url>").slice(0, 500);
}

function describe(error: unknown) {
  const e = error as { name?: string; code?: string; message?: string; stack?: string; cause?: unknown };
  const cause = e?.cause as { name?: string; code?: string; message?: string } | undefined;
  return {
    name: e?.name ?? "Error",
    code: e?.code ?? null,
    message: scrub(String(e?.message ?? error)),
    cause: cause ? scrub(`${cause.name ?? ""} ${cause.code ?? ""} ${cause.message ?? ""}`) : null,
    where: (e?.stack ?? "").split("\n").slice(1, 7).map((line) => scrub(line.trim())),
  };
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return "(not a valid URL)";
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.WORKER_SHARED_SECRET ?? "";
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 32 || given.length !== secret.length) return notFound();
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return notFound();

  const report: Record<string, unknown> = {
    databaseHost: hostOf(process.env.DATABASE_URL),
    storageDriver: process.env.STORAGE_DRIVER ?? "(not set: defaults to local)",
  };

  // 1. Settings.
  let env: ReturnType<typeof loadCmsEnv>;
  try {
    loadEnvFile();
    env = loadCmsEnv();
    report.settings = "ok";
  } catch (error) {
    report.settings = describe(error);
    return Response.json(report, { status: 500, headers: { "cache-control": "no-store" } });
  }

  // 2. Database: connect, then check the tables and accounts exist.
  const handle = createDatabase({ url: env.DATABASE_URL, poolMax: 1, ssl: env.DATABASE_SSL, applicationName: "uxd-health" });
  try {
    await handle.db.execute(sql`select 1`);
    report.database = "connected";
    const users = await handle.db.execute(sql`select count(*)::int as n from users`);
    report.users = (users.rows[0] as { n?: number } | undefined)?.n ?? null;
  } catch (error) {
    report.database = describe(error);
  } finally {
    await handle.close().catch(() => {});
  }

  // 3. Storage: can it be reached with these keys?
  try {
    const storage = createStorage({
      driver: env.STORAGE_DRIVER,
      localRoot: env.STORAGE_LOCAL_ROOT,
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
    });
    const key = "media/healthcheck/probe.txt";
    const body = new TextEncoder().encode("ok");
    await storage.put({ key, body, contentType: "text/plain", contentLength: body.byteLength });
    await storage.delete(key);
    report.storage = "ok (wrote and deleted a test file)";
  } catch (error) {
    report.storage = describe(error);
  }

  // 4. The CMS's real startup, as every page runs it.
  try {
    const server = await import("@/lib/server");
    const db = await server.getDb();
    await db.execute(sql`select 1`);
    await server.getBaseContext();
    report.cmsStartup = "ok";
    try {
      const { listPublicContent, publicMediaBaseUrl } = await import("@uxd/api");
      const storage = await server.getStorage();
      const result = await listPublicContent(db, storage, { termSlugs: [], page: 1, pageSize: 1 } as never, {
        publicBaseUrl: publicMediaBaseUrl(env),
      });
      report.publicQuery = `ok (${result.total} published)`;
    } catch (error) {
      report.publicQuery = describe(error);
    }
  } catch (error) {
    report.cmsStartup = describe(error);
  }

  const healthy = report.settings === "ok" && report.database === "connected" && String(report.storage).startsWith("ok") && report.cmsStartup === "ok";
  return Response.json(report, { status: healthy ? 200 : 500, headers: { "cache-control": "no-store" } });
}
