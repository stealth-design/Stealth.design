import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { captureSessionCommands, contentItems, flowDetails } from "@uxd/database";
import { canDiscardScreen, getSession, listTaxonomyTerms, screenTags, sessionScreens } from "@uxd/api";
import { DEVICE_PROFILES, type DeviceProfileKey, STUDIO_DISMISS_CONSENT_DEFAULT } from "@uxd/types";
import type { TagOption } from "@/components/tag-picker";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { Studio } from "./studio";

export const metadata = { title: "Studio" };

/**
 * The studio: a live browser on one product, and the captures made in it.
 *
 * The server half settles everything that needs the database — the session,
 * what has been captured so far and how each is tagged, the taxonomy to tag
 * from — and the client half owns everything that changes second by second.
 */
export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContextWith("content.create");
  const { id } = await params;

  const session = await getSession(context.db, id);
  if (!session) notFound();

  const [screens, terms, [lastConsent]] = await Promise.all([
    sessionScreens(context, id),
    listTaxonomyTerms(context.db, { statuses: ["active"] }),
    // The consent setting is the last consent command sent, not a column: it
    // is a property of the conversation with the worker, which records it.
    context.db
      .select({ payload: captureSessionCommands.payload })
      .from(captureSessionCommands)
      .where(and(eq(captureSessionCommands.sessionId, id), eq(captureSessionCommands.type, "consent")))
      .orderBy(desc(captureSessionCommands.seq))
      .limit(1),
  ]);

  const [assigned, mediaUrls, flow] = await Promise.all([
    screenTags(
      context,
      screens.map((screen) => screen.id),
    ),
    resolveMediaUrls(screens.map((screen) => screen.thumbnailKey)),
    session.flowId
      ? context.db
          .select({ title: contentItems.title, stepCount: flowDetails.stepCount })
          .from(contentItems)
          .innerJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
          .where(eq(contentItems.id, session.flowId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  const tags: TagOption[] = terms.map((term) => ({
    id: term.id,
    name: term.name,
    kind: term.kind,
    usageCount: term.usageCount,
    aliases: term.aliases,
  }));

  const dismissConsent =
    typeof lastConsent?.payload.dismiss === "boolean" ? lastConsent.payload.dismiss : STUDIO_DISMISS_CONSENT_DEFAULT;
  const profile = DEVICE_PROFILES[session.deviceProfile as DeviceProfileKey];

  return (
    <Studio
      session={{
        id: session.id,
        status: session.status,
        targetUrl: session.targetUrl,
        currentUrl: session.currentUrl,
        deviceLabel: profile?.label ?? session.deviceProfile,
        mobile: session.deviceClass !== "desktop",
        viewportWidth: session.viewportWidth,
        viewportHeight: session.viewportHeight,
        screensCaptured: session.screensCaptured,
        errorMessage: session.errorMessage,
        productId: session.sourceId,
        productName: session.sourceName,
        productSite: session.sourceSite,
        flowTitle: flow?.title ?? null,
        flowStepCount: flow?.stepCount ?? 0,
        defaultTermIds: session.defaultTermIds,
        dismissConsent,
      }}
      tags={tags}
      screens={screens.map((screen) => ({
        id: screen.id,
        name: screen.screenName ?? screen.title ?? "Untitled",
        stateLabel: screen.stateLabel,
        // Only when it went somewhere other than this session's product.
        filedUnder: screen.sourceId !== session.sourceId ? screen.sourceName : null,
        thumbnailUrl: screen.thumbnailKey ? (mediaUrls.get(screen.thumbnailKey) ?? null) : null,
        discardable: canDiscardScreen(context.actor, {
          createdBy: session.createdBy,
          status: screen.status,
          everPublished: screen.status === "published",
        }),
        tags: assigned
          .filter((tag) => tag.contentItemId === screen.id)
          .map((tag) => ({ assignmentId: tag.assignmentId, termId: tag.termId })),
      }))}
    />
  );
}
