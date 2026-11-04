/**
 * The session's state, without its picture.
 *
 * The live stream carries the pixels; this carries the facts the studio shows
 * around them — whether the browser is still alive, where it has navigated,
 * and how many screens have landed, which is how the page learns a queued
 * capture finished.
 */
import { getSession, listSessionCommands } from "@uxd/api";
import { getAdminContext } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await getAdminContext();
  const { id } = await params;

  const [session, recent] = await Promise.all([getSession(context.db, id), listSessionCommands(context.db, id, 6)]);
  if (!session) return Response.json({ error: "That capture session does not exist." }, { status: 404 });

  return Response.json(
    {
      status: session.status,
      currentUrl: session.currentUrl,
      currentTitle: session.currentTitle,
      screensCaptured: session.screensCaptured,
      errorMessage: session.errorMessage,
      // So the studio can tell a capture that failed from one still running.
      recent: recent.map((command) => ({
        id: command.id,
        type: command.type,
        status: command.status,
        errorMessage: command.errorMessage,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
