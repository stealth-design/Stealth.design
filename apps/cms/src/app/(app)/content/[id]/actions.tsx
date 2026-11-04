"use client";

import { useEffect, useState, useTransition } from "react";
import {
  LIFECYCLE_STATUS_META,
  RIGHTS_STATUSES,
  RIGHTS_STATUS_META,
  type LifecycleStatus,
  type RightsStatus,
  canTransition,
} from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import {
  type ActionResult,
  decideAction,
  publishAction,
  publishabilityAction,
  unpublishAction,
  updateRightsAction,
} from "@/lib/actions/review";

/**
 * Actions on a single content record (§29).
 *
 * Which actions appear comes from `canTransition`, the same map the server
 * enforces. Publish is special: it is disabled with the *reasons* shown rather
 * than hidden, because "why can't I publish this?" is the question a reviewer
 * actually has, and a missing button does not answer it.
 */
export function ContentActions({
  contentId,
  status,
  rightsStatus,
}: {
  contentId: string;
  status: LifecycleStatus;
  rightsStatus: RightsStatus;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [blockers, setBlockers] = useState<readonly { code: string; message: string }[]>([]);
  const [showRights, setShowRights] = useState(false);

  // Ask the server why publishing is blocked, so the explanation is the same
  // one the publish gate would give rather than a guess made in the browser.
  useEffect(() => {
    if (status !== "approved" && status !== "needs_review") {
      setBlockers([]);
      return;
    }
    let cancelled = false;
    void publishabilityAction(contentId).then((outcome) => {
      if (!cancelled) setBlockers(outcome.allowed ? [] : outcome.blockers);
    });
    return () => {
      cancelled = true;
    };
  }, [contentId, status, rightsStatus]);

  const run = (action: () => Promise<ActionResult>) => {
    startTransition(async () => setResult(await action()));
  };

  const canApprove = canTransition(status, "approved");
  const canPublishTransition = canTransition(status, "published");
  const publishBlocked = blockers.length > 0;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {canApprove ? (
          <Button disabled={isPending} onClick={() => run(() => decideAction({ contentId, decision: "approved" }))}>
            Approve
          </Button>
        ) : null}

        {canPublishTransition ? (
          <Button
            variant="primary"
            disabled={isPending || publishBlocked}
            title={
              publishBlocked
                ? blockers.map((blocker) => blocker.message).join(" ")
                : "Make this live on the public API."
            }
            onClick={() => run(() => publishAction(contentId))}
          >
            Publish
          </Button>
        ) : null}

        {status === "published" ? (
          <Button
            variant="danger"
            disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Why is this being unpublished? (recorded on the record)");
              if (reason?.trim()) run(() => unpublishAction(contentId, reason.trim()));
            }}
          >
            Unpublish
          </Button>
        ) : null}

        {canTransition(status, "rejected") ? (
          <Button
            variant="danger"
            disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Why is this being rejected?");
              if (reason?.trim()) {
                run(() => decideAction({ contentId, decision: "rejected", notes: reason.trim() }));
              }
            }}
          >
            Reject
          </Button>
        ) : null}

        <Button disabled={isPending} onClick={() => setShowRights((value) => !value)}>
          Rights
        </Button>
      </div>

      {/* Publish blockers, listed rather than hidden behind a disabled button. */}
      {publishBlocked && canPublishTransition ? (
        <div className="max-w-md">
          <Note tone="warning">
            <p className="font-medium">Not publishable yet:</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
              {blockers.map((blocker) => (
                <li key={blocker.code} className="text-2xs">
                  {blocker.message}
                </li>
              ))}
            </ul>
          </Note>
        </div>
      ) : null}

      {result ? (
        <div className="max-w-md">
          <Note tone={result.ok ? "success" : "danger"}>
            <p>{result.message ?? result.error}</p>
            {result.issues.length > 0 ? (
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                {result.issues.map((issue) => (
                  <li key={`${issue.path}-${issue.message}`} className="text-2xs">
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Note>
        </div>
      ) : null}

      {/* --- Rights editor (§22) ------------------------------- */}
      {showRights ? (
        <form
          className="w-80 space-y-2 rounded-md border border-ink-300 bg-surface p-3 text-left shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(() =>
              updateRightsAction(contentId, {
                rightsStatus: String(form.get("rightsStatus")),
                rightsOwner: String(form.get("rightsOwner") ?? "") || null,
                attribution: String(form.get("attribution") ?? "") || null,
                rightsNotes: String(form.get("rightsNotes") ?? "") || null,
              }),
            );
            setShowRights(false);
          }}
        >
          <p className="text-2xs text-ink-500">
            These are operational labels recording what your team knows and has decided. They are
            not legal determinations, and nothing here computes one.
          </p>

          <label className="block">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">Status</span>
            <select
              name="rightsStatus"
              defaultValue={rightsStatus}
              className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 bg-surface px-1.5 text-xs"
            >
              {RIGHTS_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {RIGHTS_STATUS_META[value].label}
                  {RIGHTS_STATUS_META[value].blocksPublishing ? " (blocks publishing)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">Owner</span>
            <input
              name="rightsOwner"
              className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">
              Attribution
            </span>
            <input
              name="attribution"
              className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">Notes</span>
            <textarea
              name="rightsNotes"
              rows={3}
              className="mt-1 w-full rounded-[4px] border border-ink-300 p-1.5 text-xs"
            />
          </label>

          <div className="flex gap-1.5">
            <Button type="submit" variant="primary" disabled={isPending}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setShowRights(false)}>
              Cancel
            </Button>
          </div>

          <p className="text-2xs text-ink-500">
            Setting a blocking status on published content withdraws it from the public API
            immediately.
          </p>
        </form>
      ) : null}

      {LIFECYCLE_STATUS_META[status].needsAttention ? (
        <span className="text-2xs text-[var(--color-tone-warning)]">
          {LIFECYCLE_STATUS_META[status].description}
        </span>
      ) : null}
    </div>
  );
}
