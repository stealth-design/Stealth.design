"use server";

/**
 * Discovery triage and studio control (§1, §2, §7).
 *
 * Thin translations of the services in `@uxd/api`: the permission check, the
 * validation and the audit write all live there, so an action can never do
 * something the HTTP route would refuse. What these add is the bit the UI
 * needs — an error an operator can read, and a cache refresh so the list
 * reflects what just happened.
 */
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDiscoveredPageByHand,
  closeSession,
  createFlow,
  enqueueCommand,
  ignoreDiscoveredPages,
  markViewerPresent,
  openSession,
  restoreDiscoveredPages,
  setSessionTags,
  updateScreen,
} from "@uxd/api";
import { AppError } from "@uxd/shared";
import type { IgnoreReason, SessionCommandPayload, StudioProfile } from "@uxd/types";
import { getAdminContext, getAdminContextWith } from "@/lib/server";

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
}

const ok = (message: string): ActionResult => ({ ok: true, message, error: null });

const failed = (error: unknown, fallback: string): ActionResult => ({
  ok: false,
  message: null,
  error: AppError.is(error) ? error.publicMessage : fallback,
});

export async function ignorePagesAction(
  ids: readonly string[],
  reason: IgnoreReason,
  note?: string,
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    const result = await ignoreDiscoveredPages(context, ids, { reason, note });
    refresh();

    if (result.updated === 0 && result.skipped.length > 0) {
      return { ok: false, message: null, error: result.skipped[0]?.reason ?? "Nothing was changed." };
    }
    const suffix =
      result.skipped.length > 0
        ? ` ${result.skipped.length} kept, because screens have already been captured from them.`
        : "";
    return ok(`Set aside ${result.updated} page${result.updated === 1 ? "" : "s"}.${suffix}`);
  } catch (error) {
    return failed(error, "Those pages could not be set aside.");
  }
}

export async function restorePagesAction(ids: readonly string[]): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    const result = await restoreDiscoveredPages(context, ids);
    refresh();
    return ok(`Returned ${result.updated} page${result.updated === 1 ? "" : "s"} to the queue.`);
  } catch (error) {
    return failed(error, "Those pages could not be restored.");
  }
}

export async function addPageAction(url: string, sourceId?: string): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.create");
    const result = await addDiscoveredPageByHand(context, { url, sourceId: sourceId ?? null });
    refresh();
    return ok(result.created ? "Added to the queue." : "That URL was already a candidate.");
  } catch (error) {
    return failed(error, "That URL could not be added.");
  }
}

/**
 * Open a live browser and go to it.
 *
 * Redirects rather than returning the id, because there is nothing useful to
 * do on the triage page once a session is opening — and `redirect` throws, so
 * it has to sit outside the try block or it would be caught as a failure.
 */
export async function captureScreenAction(input: {
  url: string;
  profile: StudioProfile;
  discoveredPageId?: string;
  sourceId?: string;
  flowId?: string;
  /** Start a new flow with this name and capture into it. */
  flowName?: string;
  /** Tags every capture in the session starts with. */
  termIds?: readonly string[];
}): Promise<ActionResult> {
  let sessionId: string;
  try {
    const context = await getAdminContextWith("content.create");
    const flowId =
      input.flowId ??
      (input.flowName?.trim()
        ? (await createFlow(context, { name: input.flowName, sourceId: input.sourceId ?? null })).flowId
        : null);
    const result = await openSession(context, {
      url: input.url,
      profile: input.profile,
      discoveredPageId: input.discoveredPageId ?? null,
      sourceId: input.sourceId ?? null,
      flowId,
      termIds: input.termIds ?? [],
    });
    sessionId = result.sessionId;
  } catch (error) {
    return failed(error, "A capture session could not be opened.");
  }
  redirect(`/studio/${sessionId}`);
}

export async function sendCommandAction(
  sessionId: string,
  payload: SessionCommandPayload,
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.create");
    await enqueueCommand(context, sessionId, payload);
    return ok("Sent.");
  } catch (error) {
    return failed(error, "That command could not be sent.");
  }
}

/**
 * Tell the worker somebody is watching.
 *
 * Called by the studio on a timer. It is what raises the frame rate while a
 * researcher is steering and lets it drop when they walk away — a session
 * nobody is looking at should not cost a screenshot a second.
 */
export async function touchViewerAction(sessionId: string): Promise<void> {
  try {
    const context = await getAdminContext();
    await markViewerPresent(context, sessionId);
  } catch {
    // A missed heartbeat costs one slow frame. Never worth surfacing.
  }
}

/** Change the tags new captures in a session start with. */
export async function setSessionTagsAction(
  sessionId: string,
  termIds: readonly string[],
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.create");
    await setSessionTags(context, sessionId, termIds);
    return ok("Tags updated.");
  } catch (error) {
    return failed(error, "Those tags could not be saved.");
  }
}

export async function closeSessionAction(sessionId: string): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.create");
    await closeSession(context, sessionId);
    refresh();
    return ok("Session closed.");
  } catch (error) {
    return failed(error, "That session could not be closed.");
  }
}

/**
 * Edit a Screen's own fields from the review page (§7).
 *
 * Separate from the suggestion actions because this is the reviewer writing,
 * not the reviewer judging: a corrected name is authored content with no
 * machine proposal behind it, and it carries no confidence and no origin.
 */
export async function updateScreenAction(
  contentItemId: string,
  input: { screenName?: string; stateLabel?: string; description?: string; notes?: string },
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    await updateScreen(context, contentItemId, input);
    refresh();
    return ok("Saved.");
  } catch (error) {
    return failed(error, "That screen could not be saved.");
  }
}
