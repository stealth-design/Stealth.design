/**
 * The live view's image source.
 *
 * A route rather than a server action because the studio uses it as an
 * `<img src>` — the browser's own image loader handles the decode, the
 * progressive paint and the memory, none of which we would want to reimplement
 * around a base64 string in a React state variable.
 *
 * Authenticated as the signed-in operator, like every other CMS surface. A
 * frame is a photograph of a page a researcher navigated to, taken inside our
 * infrastructure; it is not public and it does not become public by being an
 * image URL.
 */
import { getSessionFrame, markViewerPresent } from "@uxd/api";
import { getAdminContext } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await getAdminContext();
  const { id } = await params;

  const row = await getSessionFrame(context.db, id);
  if (!row?.frame) {
    // 204 rather than 404: the session may be perfectly healthy and simply not
    // have painted its first frame yet, and a 404 would make the studio show a
    // broken image for the second between claiming a session and loading it.
    return new Response(null, { status: 204 });
  }

  // Fetching a frame is the definition of watching. Recording it here rather
  // than on a separate heartbeat means the worker's frame rate follows the
  // thing it should follow — whether a picture is actually being looked at.
  await markViewerPresent(context, id).catch(() => undefined);

  return new Response(new Uint8Array(row.frame), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(row.frame.byteLength),
      // Every frame is a different picture at the same URL, and a cached one is
      // a live view that has quietly stopped being live.
      "cache-control": "no-store, must-revalidate",
      "x-frame-seq": String(row.frameSeq),
      "x-session-status": row.status,
      // Lets the studio notice a capture landing — the capture command only
      // queues the work, so the page has no other way to learn it finished.
      "x-screens-captured": String(row.screensCaptured),
    },
  });
}
