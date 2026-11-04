"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  LIFECYCLE_STATUS_META,
  RIGHTS_STATUSES,
  RIGHTS_STATUS_META,
  SOURCE_HEALTH_META,
  type SourceHealth,
} from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import {
  type SourceActionResult,
  flagSourceAction,
  recaptureSourceAction,
  updateSourceRightsAction,
} from "@/lib/actions/sources";

/**
 * Actions on a source (§3, §22, §40).
 *
 * Recapture is the one that needs explaining rather than just doing, so it
 * opens a small panel: "everything" and "only what is published" are genuinely
 * different intents, and the second is the one a team reaches for when they
 * want the live site accurate without re-opening records that are still in
 * review. The panel states how many URLs will be queued before it queues them.
 */
export function SourceActions({
  sourceId,
  health,
  publishedCount,
  totalCount,
}: {
  sourceId: string;
  health: SourceHealth;
  publishedCount: number;
  totalCount: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<SourceActionResult | null>(null);
  const [panel, setPanel] = useState<"recapture" | "rights" | null>(null);

  const run = (action: () => Promise<SourceActionResult>) => {
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) setPanel(null);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button
          disabled={isPending}
          onClick={() => setPanel(panel === "recapture" ? null : "recapture")}
          title="Queue a fresh capture of the URLs already held for this source."
        >
          Recapture
        </Button>
        <Button disabled={isPending} onClick={() => setPanel(panel === "rights" ? null : "rights")}>
          Rights
        </Button>
        {health !== "requires_review" ? (
          <Button
            variant="danger"
            disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Why does this source need a person to look at it?");
              if (reason?.trim()) run(() => flagSourceAction(sourceId, reason.trim()));
            }}
          >
            Flag
          </Button>
        ) : null}
      </div>

      {result ? (
        <div className="max-w-md">
          <Note tone={result.ok ? "success" : "danger"}>
            <p>
              {result.message ?? result.error}
              {result.jobId ? (
                <>
                  {" "}
                  <Link href={`/crawl-jobs/${result.jobId}`} className="underline">
                    Open the job
                  </Link>
                  .
                </>
              ) : null}
            </p>
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

      {/* --- Recapture (§40) ------------------------------------ */}
      {panel === "recapture" ? (
        <div className="w-96 space-y-2.5 rounded-md border border-ink-300 bg-surface p-3 text-left shadow-lg">
          <p className="text-2xs leading-relaxed text-ink-600">
            Re-fetches URLs this source already has, so the change detection has a previous capture
            to compare against. It does not crawl outward, so the number below is the whole job.
            Every URL is re-checked against the safety rules first — one that was fine before is not
            thereby fine now.
          </p>
          <div className="space-y-1.5">
            <Button
              variant="primary"
              disabled={isPending || totalCount === 0}
              onClick={() => run(() => recaptureSourceAction(sourceId))}
            >
              Everything ({totalCount.toLocaleString("en-US")})
            </Button>
            <Button
              disabled={isPending || publishedCount === 0}
              onClick={() =>
                run(() => recaptureSourceAction(sourceId, { statuses: ["published"] }))
              }
              title={`Keep the ${publishedCount} live records accurate without re-opening anything in review.`}
            >
              Published only ({publishedCount.toLocaleString("en-US")})
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
              Cancel
            </Button>
          </div>
          <p className="text-2xs text-ink-500">
            Recaptured records that a person has already decided on keep that decision —{" "}
            {LIFECYCLE_STATUS_META.published.label.toLowerCase()} stays{" "}
            {LIFECYCLE_STATUS_META.published.label.toLowerCase()}, and an open review is not
            re-opened.
          </p>
        </div>
      ) : null}

      {/* --- Source rights (§22) -------------------------------- */}
      {panel === "rights" ? (
        <form
          className="w-80 space-y-2 rounded-md border border-ink-300 bg-surface p-3 text-left shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(() =>
              updateSourceRightsAction(sourceId, {
                rightsStatus: String(form.get("rightsStatus")),
                rightsOwner: String(form.get("rightsOwner") ?? "") || null,
                attribution: String(form.get("attribution") ?? "") || null,
                rightsNotes: String(form.get("rightsNotes") ?? "") || null,
              }),
            );
          }}
        >
          <p className="text-2xs leading-relaxed text-ink-500">
            The source-level position: what the team knows about this product as a whole. Operational
            labels, not legal determinations.
          </p>

          <label className="block">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">Status</span>
            <select
              name="rightsStatus"
              className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 bg-surface px-1.5 text-xs"
            >
              {RIGHTS_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {RIGHTS_STATUS_META[value].label}
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
            <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
              Cancel
            </Button>
          </div>

          <p className="text-2xs text-ink-500">
            This does not rewrite the rights status on individual content records. Each publish
            decision reads the record's own position, and overwriting hundreds of them from one
            dropdown would discard decisions a reviewer made deliberately.
          </p>
        </form>
      ) : null}

      {SOURCE_HEALTH_META[health].needsAttention ? (
        <span className="max-w-xs text-right text-2xs text-[var(--color-tone-warning)]">
          {SOURCE_HEALTH_META[health].description}
        </span>
      ) : null}
    </div>
  );
}
