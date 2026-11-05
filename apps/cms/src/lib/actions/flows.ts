"use server";

/**
 * Flow assembly (§10, §11).
 *
 * Every one of these delegates to `@uxd/api`'s flow service, which owns the
 * position renumbering and the derived shape. Nothing here computes an order.
 */
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  addScreensToFlow,
  createFlow,
  removeFlowStep,
  reorderFlowSteps,
  submitFlowForReview,
  updateFlow,
  updateFlowStep,
} from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContextWith } from "@/lib/server";

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

/**
 * Create a flow and go to it.
 *
 * The redirect is the point: "Create Flow" is the first half of a gesture
 * whose second half is walking the product, so landing on the empty flow with
 * a Capture button is what makes the two feel like one action.
 */
export async function createFlowAction(input: {
  name: string;
  goal?: string;
  description?: string;
  sourceId?: string;
}): Promise<ActionResult> {
  let flowId: string;
  try {
    const context = await getAdminContextWith("content.create");
    const result = await createFlow(context, {
      name: input.name,
      goal: input.goal ?? null,
      description: input.description ?? null,
      sourceId: input.sourceId ?? null,
    });
    flowId = result.flowId;
  } catch (error) {
    return failed(error, "That flow could not be created.");
  }
  redirect(`/flows/${flowId}`);
}

export async function addScreensAction(
  flowId: string,
  screenIds: readonly string[],
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    const result = await addScreensToFlow(context, flowId, screenIds);
    refresh();
    return ok(`Added ${result.added} screen${result.added === 1 ? "" : "s"}.`);
  } catch (error) {
    return failed(error, "Those screens could not be added.");
  }
}

export async function reorderStepsAction(
  flowId: string,
  orderedStepIds: readonly string[],
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    await reorderFlowSteps(context, flowId, orderedStepIds);
    refresh();
    return ok("Order saved.");
  } catch (error) {
    return failed(error, "The order could not be saved.");
  }
}

export async function removeStepAction(flowId: string, stepId: string): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    await removeFlowStep(context, flowId, stepId);
    refresh();
    return ok("Step removed.");
  } catch (error) {
    return failed(error, "That step could not be removed.");
  }
}

export async function updateStepAction(
  flowId: string,
  stepId: string,
  input: { label?: string; note?: string },
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    await updateFlowStep(context, flowId, stepId, input);
    refresh();
    return ok("Step updated.");
  } catch (error) {
    return failed(error, "That step could not be updated.");
  }
}

export async function updateFlowAction(
  flowId: string,
  input: { name?: string; goal?: string; description?: string; observations?: string },
): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    await updateFlow(context, flowId, input);
    refresh();
    return ok("Saved.");
  } catch (error) {
    return failed(error, "That flow could not be saved.");
  }
}

/**
 * Send a flow to review (§11).
 *
 * The step the lifecycle requires and the UI previously had no button for: a
 * flow starts as a draft and cannot be approved out of it, so without this a
 * finished flow had nowhere to go.
 */
export async function submitFlowAction(flowId: string): Promise<ActionResult> {
  try {
    const context = await getAdminContextWith("content.update");
    const result = await submitFlowForReview(context, flowId);
    refresh();
    return ok(`Sent to review with ${result.stepCount} step${result.stepCount === 1 ? "" : "s"}.`);
  } catch (error) {
    return failed(error, "That flow could not be sent to review.");
  }
}
