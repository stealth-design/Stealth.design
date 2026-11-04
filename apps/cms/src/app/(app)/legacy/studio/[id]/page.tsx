import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { captureSessionCommands, contentItems, flowDetails } from "@uxd/database";
import { getSession, listSessionCommands, sessionScreens } from "@uxd/api";
import { DEVICE_PROFILES, type DeviceProfileKey, STUDIO_DISMISS_CONSENT_DEFAULT } from "@uxd/types";
import { PageHeader } from "@/components/ui/primitives";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { Studio } from "./studio";

export const metadata = { title: "Capture studio" };

/**
 * One live capture session (§2, §3).
 *
 * The server half is deliberately thin: it resolves the session, the screens
 * captured so far and the flow it may be feeding, then hands them to a client
 * component that owns the frame loop. Everything that changes second by second
 * is the client's business, and everything that needs the database is settled
 * here before the page renders.
 */
export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContextWith("content.create");
  const { id } = await params;

  const session = await getSession(context.db, id);
  if (!session) notFound();

  const [screens, commands, [lastConsent]] = await Promise.all([
    sessionScreens(context, id),
    listSessionCommands(context.db, id, 8),
    // The setting is the last consent command sent, not a column: it is a
    // property of the conversation with the worker, which already records it.
    context.db
      .select({ payload: captureSessionCommands.payload })
      .from(captureSessionCommands)
      .where(and(eq(captureSessionCommands.sessionId, id), eq(captureSessionCommands.type, "consent")))
      .orderBy(desc(captureSessionCommands.seq))
      .limit(1),
  ]);
  const dismissConsent =
    typeof lastConsent?.payload.dismiss === "boolean"
      ? lastConsent.payload.dismiss
      : STUDIO_DISMISS_CONSENT_DEFAULT;

  const flow = session.flowId
    ? (
        await context.db
          .select({ title: contentItems.title, stepCount: flowDetails.stepCount })
          .from(contentItems)
          .innerJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
          .where(eq(contentItems.id, session.flowId))
          .limit(1)
      )[0]
    : undefined;

  // Thumbnails for the session filmstrip, resolved in one batch — one
  // signed-URL round trip per image would be a request per capture on an S3
  // deployment.
  const mediaUrls = await resolveMediaUrls(screens.map((screen) => screen.thumbnailKey));

  const profile = DEVICE_PROFILES[session.deviceProfile as DeviceProfileKey];

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Discovered pages", href: "/discovered" },
          ...(session.discoveredPageId
            ? [{ label: "Candidate", href: `/discovered/${session.discoveredPageId}` }]
            : []),
        ]}
        title={session.currentTitle ?? session.targetUrl}
        count={profile?.label}
        description="A live browser. Navigate to the state worth keeping, then capture it. Nothing is created until you press Capture."
        actions={
          session.sourceId ? (
            <Link
              href={`/sources/${session.sourceId}`}
              className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
            >
              {session.sourceName ?? "Source"}
            </Link>
          ) : null
        }
      />

      <Studio
        session={{
          id: session.id,
          status: session.status,
          targetUrl: session.targetUrl,
          currentUrl: session.currentUrl,
          currentTitle: session.currentTitle,
          deviceProfile: session.deviceProfile,
          viewportWidth: session.viewportWidth,
          viewportHeight: session.viewportHeight,
          deviceScaleFactor: session.deviceScaleFactor,
          screensCaptured: session.screensCaptured,
          errorMessage: session.errorMessage,
          flowId: session.flowId,
          flowTitle: flow?.title ?? null,
          flowStepCount: flow?.stepCount ?? 0,
          dismissConsent,
        }}
        screens={screens.map((screen) => ({
          id: screen.id,
          title: screen.title,
          stateLabel: screen.stateLabel,
          thumbnailUrl: screen.thumbnailKey ? (mediaUrls.get(screen.thumbnailKey) ?? null) : null,
        }))}
      />

      {commands.length > 0 ? (
        <div className="px-4 pb-6">
          <details className="rounded-md border border-ink-200 bg-surface p-3">
            <summary className="cursor-pointer text-xs font-semibold text-ink-800">
              Recent activity
            </summary>
            <ul className="mt-2 flex flex-col gap-1 font-mono text-2xs text-ink-500">
              {commands.map((command) => (
                <li key={command.id}>
                  #{command.seq} {command.type} — {command.status}
                  {command.errorMessage ? ` — ${command.errorMessage}` : ""}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </>
  );
}
