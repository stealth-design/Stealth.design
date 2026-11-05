"use server";

/**
 * Classification review actions (§14).
 *
 * The service holds the rules — who may decide, what a correction records, how
 * a single-value vocabulary behaves. These translate its errors into something
 * the suggestions queue can show without losing the reviewer's place.
 */
import { refreshAll as refresh } from "@/lib/public-site";
import {
  addAssignment,
  bulkAcceptSuggestions,
  bulkRejectSuggestions,
  removeAssignment,
  reviewSuggestion,
  type SuggestionDecision,
} from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContext } from "@/lib/server";

export interface ClassificationActionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly issues: readonly { path: string; message: string }[];
}

const ok = (message: string): ClassificationActionResult => ({
  ok: true,
  message,
  error: null,
  issues: [],
});

const failed = (error: unknown, fallback: string): ClassificationActionResult => ({
  ok: false,
  message: null,
  error: AppError.is(error) ? error.publicMessage : fallback,
  issues: AppError.is(error) ? (error.issues ?? []) : [],
});

export async function reviewSuggestionAction(input: {
  assignmentId: string;
  decision: SuggestionDecision;
  termId?: string;
  note?: string | null;
}): Promise<ClassificationActionResult> {
  try {
    const context = await getAdminContext();
    await reviewSuggestion(context, input);
    refresh();
    return ok(
      input.decision === "accept"
        ? "Confirmed."
        : input.decision === "modify"
          ? "Corrected. The model's original term is kept for comparison."
          : "Rejected. The suggestion is kept, marked rejected.",
    );
  } catch (error) {
    return failed(error, "Could not record that decision.");
  }
}

export async function bulkAcceptSuggestionsAction(
  assignmentIds: string[],
): Promise<ClassificationActionResult> {
  try {
    const context = await getAdminContext();
    const { accepted } = await bulkAcceptSuggestions(context, assignmentIds);
    refresh();
    return ok(`Confirmed ${accepted.toLocaleString("en-US")} suggestion${accepted === 1 ? "" : "s"}.`);
  } catch (error) {
    return failed(error, "Could not confirm those suggestions.");
  }
}

export async function bulkRejectSuggestionsAction(
  assignmentIds: string[],
  reason: string,
): Promise<ClassificationActionResult> {
  try {
    const context = await getAdminContext();
    const { rejected } = await bulkRejectSuggestions(context, assignmentIds, reason);
    refresh();
    return ok(`Rejected ${rejected.toLocaleString("en-US")} suggestion${rejected === 1 ? "" : "s"}.`);
  } catch (error) {
    return failed(error, "Could not reject those suggestions.");
  }
}

export async function addAssignmentAction(
  contentItemId: string,
  termId: string,
): Promise<ClassificationActionResult> {
  try {
    const context = await getAdminContext();
    const { alreadyPresent } = await addAssignment(context, { contentItemId, termId });
    refresh();
    return ok(alreadyPresent ? "Already there — now confirmed." : "Term added.");
  } catch (error) {
    return failed(error, "Could not add that term.");
  }
}

export async function removeAssignmentAction(
  assignmentId: string,
): Promise<ClassificationActionResult> {
  try {
    const context = await getAdminContext();
    await removeAssignment(context, assignmentId);
    refresh();
    return ok("Term removed.");
  } catch (error) {
    return failed(error, "Could not remove that term.");
  }
}
