/**
 * Serves files from the local storage driver.
 *
 * Development only. With `STORAGE_DRIVER=s3` media is served directly from the
 * bucket or its CDN and this route is never hit; `loadCmsEnv` refuses to start
 * a production CMS on the local driver at all.
 *
 * Even so, this is the one place in the CMS that returns attacker-influenced
 * bytes to a browser, so it is written as though it were production:
 *
 *   - The storage key is validated by `assertSafeKey` and the driver resolves
 *     it under the storage root, refusing anything that escapes. Two
 *     independent checks, because a traversal bug here reads arbitrary files.
 *   - The content type comes from the database row, never from the file
 *     extension or a client parameter.
 *   - Anything a browser could execute — SVG, HTML snapshots, PDF — is sent as
 *     an attachment with `Content-Disposition`, plus a `default-src 'none'`
 *     CSP and `nosniff`. A captured page's HTML must never run in the CMS's
 *     own origin (§9, §25).
 */
import { and, eq, isNull } from "drizzle-orm";
import { mediaAssets, mediaDerivatives } from "@uxd/database";
import { dispositionFor } from "@uxd/media";
import { getActor, getDb, getEnv, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Types that must never be rendered inline in this origin. */
const FORCE_ATTACHMENT = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/pdf",
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const env = await getEnv();

  // With S3 configured, media URLs point at the bucket. Reaching this route
  // then means a stale URL, and answering it would be serving from a path the
  // deployment does not intend to use.
  // `blob` is served through here too: its files are never linked directly.
  if (env.STORAGE_DRIVER === "s3") {
    return new Response("Not found", { status: 404 });
  }

  // The CMS's media is internal until it is published. Requiring a session
  // here means a development instance does not expose every capture to anyone
  // who can reach the port.
  const actor = await getActor();
  if (!actor) {
    return new Response("Authentication required", { status: 401 });
  }

  const { key: segments } = await context.params;
  const key = segments.join("/");

  const db = await getDb();

  // The key must correspond to a real, live row. That is what stops this route
  // from being a general file reader over the storage root: an attacker cannot
  // ask for a key we did not write.
  const [asset] = await db
    .select({
      mimeType: mediaAssets.mimeType,
      originalFilename: mediaAssets.originalFilename,
      byteSize: mediaAssets.byteSize,
      status: mediaAssets.status,
    })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.storageKey, key), isNull(mediaAssets.deletedAt)))
    .limit(1);

  let mimeType = asset?.mimeType ?? null;
  let filename = asset?.originalFilename ?? null;

  if (!asset) {
    // Derivatives are stored under their own keys and are always images.
    const [derivative] = await db
      .select({ mimeType: mediaDerivatives.mimeType, kind: mediaDerivatives.kind })
      .from(mediaDerivatives)
      .where(eq(mediaDerivatives.storageKey, key))
      .limit(1);
    if (!derivative) return new Response("Not found", { status: 404 });
    mimeType = derivative.mimeType;
    filename = `${derivative.kind}.webp`;
  } else if (asset.status === "quarantined") {
    // A quarantined upload is retained for inspection and never served.
    return new Response("Not available", { status: 403 });
  }

  const storage = await getStorage();
  let stream: Awaited<ReturnType<typeof storage.get>>;
  try {
    stream = await storage.get(key);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const forceDownload =
    request.url.includes("download=1") || (mimeType !== null && FORCE_ATTACHMENT.has(mimeType));

  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "content-type": mimeType ?? "application/octet-stream",
      "content-disposition": forceDownload
        ? `attachment; filename="${(filename ?? "file").replace(/[^\w.\-]/g, "_")}"`
        : dispositionFor(mimeType ?? "application/octet-stream", filename),
      // Keys are content-addressed by uuid and never reused, so a response is
      // immutable — but it is private, because the media is internal.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      // Nothing served from here may load or execute anything.
      "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}

// Explicitly reject anything that is not a read. A storage-serving route that
// silently accepts a POST is a mistake waiting to be made.
export async function POST(): Promise<Response> {
  return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
}
export { POST as PUT, POST as DELETE, POST as PATCH };
