/**
 * Serves published media to the public.
 *
 * The public API hands out URLs for screenshots, so something has to serve
 * them. With `STORAGE_DRIVER=s3` and a public bucket or CDN those URLs point
 * straight at storage and this route is never reached. With the local driver —
 * development, and the `npm run dev` demo — they point here.
 *
 * ## Why this is not the same route as `/media/[...key]`
 *
 * That route is session-gated, and correctly: the CMS's media is internal until
 * someone publishes it. This one is not gated, and therefore has to be far
 * stricter about *what* it will serve. Two different policies, so two routes —
 * one route with a mode flag is how a policy gets applied to the wrong request.
 *
 * ## What it will and will not serve
 *
 * - **The publish gate applies.** `findPublicMediaByKey` resolves a key only
 *   when the asset is ready and used by at least one *published* record.
 *   Withdraw the record and the image 404s on the next request. That is the
 *   same condition every other public read uses, so there is no way for the
 *   API to advertise an image this route will not serve, or the reverse.
 * - **Nothing executable renders inline.** A derivative is re-encoded by sharp
 *   and is always a raster image, so it is safe. An *original* is only served
 *   inline when its type is a raster image; anything a browser could execute —
 *   SVG above all — is sent as an attachment with a `default-src 'none'` CSP.
 *   Serving a captured SVG inline from our own origin would be handing an
 *   attacker script execution in it (§9, §25).
 * - **The content type comes from the database**, never from the extension or
 *   a query parameter.
 * - **Reads only.** Anything that is not a GET is refused.
 */
import { findPublicMediaByKey } from "@uxd/api";
import { assertSafeKey } from "@uxd/media";
import { getDb, getEnv, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Types that may render inline.
 *
 * An allowlist, not a blocklist. A blocklist of executable types is a bet that
 * nobody will ever add a new one, and browsers keep adding them.
 */
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const env = await getEnv();

  // With S3 configured, public media URLs point at the bucket or its CDN.
  // Reaching this route then means a stale URL, and answering it would serve
  // from a path the deployment does not intend to use.
  // `blob` is served through here too: its files are never linked directly.
  if (env.STORAGE_DRIVER === "s3") {
    return notFound();
  }

  const { key: segments } = await context.params;
  const key = segments.join("/");

  // Two independent checks against traversal, because a bug here reads
  // arbitrary files: the key is validated, and the driver resolves it under
  // the storage root and refuses anything that escapes.
  try {
    assertSafeKey(key);
  } catch {
    return notFound();
  }

  const db = await getDb();
  const file = await findPublicMediaByKey(db, key);

  // Null covers three cases — no such key, an unpublished record, a withdrawn
  // one — and they are deliberately indistinguishable.
  if (!file) return notFound();

  const storage = await getStorage();
  let stream: Awaited<ReturnType<typeof storage.get>>;
  try {
    stream = await storage.get(key);
  } catch {
    return notFound();
  }

  const inline = file.isDerivative || INLINE_SAFE.has(file.mimeType);

  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": inline ? "inline" : 'attachment; filename="download"',
      // Keys are addressed by a uuid that is never reused, so a body at a given
      // key never changes — immutable is honest here rather than optimistic.
      // A withdrawal changes whether the key resolves at all, and the public
      // API stops advertising it, so a cached image cannot outlive its record
      // in any surface a reader reaches.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      // An image needs no capabilities. `sandbox` costs nothing on a raster
      // image and closes the door on whatever a future format turns out to do.
      "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "cross-origin-resource-policy": "cross-site",
      ...(file.byteSize !== null ? { "content-length": String(file.byteSize) } : {}),
    },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function POST(): Promise<Response> {
  return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
}
export { POST as PUT, POST as DELETE, POST as PATCH };
