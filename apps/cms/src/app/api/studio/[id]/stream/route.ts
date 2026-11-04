/**
 * The live view, as one long response.
 *
 * `multipart/x-mixed-replace` is the oldest streaming format the web has and
 * the one an `<img>` understands natively: each part replaces the last, and
 * the browser's own image decoder does the work. No WebSocket (which a Next.js
 * route cannot hold), no base64 in a JSON stream, no client-side decode loop —
 * the studio sets `src` once and the page moves.
 *
 * Frames come from the live relay the moment the worker posts them. When the
 * relay has nothing — the CMS restarted, or this viewer arrived before the
 * first paint — the last frame the database kept is sent instead, so the view
 * is never blank while the browser behind it is fine.
 *
 * Each part is followed immediately by the next boundary. Browsers commit a
 * part when they see the boundary after it; writing the boundary at the start
 * of the next frame instead would show every picture one frame late.
 */
import {
  getSessionFrame,
  latestLiveFrame,
  markViewerPresent,
  subscribeLiveFrames,
  type LiveFrame,
} from "@uxd/api";
import { CAPTURE_SESSION_STATUS_META, STUDIO_FRAME } from "@uxd/types";
import { getAdminContext } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BOUNDARY = "uxdframe";
const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await getAdminContext();
  const { id } = await params;

  const stored = await getSessionFrame(context.db, id);
  if (!stored) return new Response(null, { status: 404 });
  if (!CAPTURE_SESSION_STATUS_META[stored.status].isActive) return new Response(null, { status: 410 });

  await markViewerPresent(context, id).catch(() => undefined);

  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let last: { bytes: Uint8Array; at: number } | null = null;

      const write = (bytes: Uint8Array) => {
        if (closed) return;
        last = { bytes, at: Date.now() };
        try {
          controller.enqueue(
            encoder.encode(`Content-Type: image/jpeg\r\nContent-Length: ${bytes.byteLength}\r\n\r\n`),
          );
          controller.enqueue(bytes);
          controller.enqueue(encoder.encode(`\r\n--${BOUNDARY}\r\n`));
        } catch {
          cleanup();
        }
      };

      const end = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      const unsubscribe = subscribeLiveFrames(id, (frame: LiveFrame) => write(frame.bytes), end);

      // The page may be perfectly still, in which case Chromium paints
      // nothing new. Re-sending the latest picture keeps the connection
      // visibly alive, and doubles as the viewer-present heartbeat that keeps
      // an attended session from idling out.
      const keepAlive = setInterval(() => {
        void markViewerPresent(context, id).catch(() => undefined);
        if (last && Date.now() - last.at >= STUDIO_FRAME.keepAliveMs) write(last.bytes);
      }, STUDIO_FRAME.keepAliveMs);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
      };
      request.signal.addEventListener("abort", end, { once: true });

      controller.enqueue(encoder.encode(`--${BOUNDARY}\r\n`));
      const first = latestLiveFrame(id)?.bytes ?? (stored.frame ? new Uint8Array(stored.frame) : null);
      if (first) write(first);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      // `no-transform` keeps compression from buffering the stream into
      // seconds-long chunks, which would undo the whole point of it.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
