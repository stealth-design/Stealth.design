"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  LIFECYCLE_STATUSES,
  LIFECYCLE_STATUS_META,
  type LifecycleStatus,
  canTransition,
} from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import {
  type BulkActionResult,
  bulkApproveAction,
  bulkArchiveAction,
  bulkPublishAction,
  bulkRejectAction,
  bulkSetStatusAction,
} from "@/lib/actions/review";

/**
 * Bulk operations on a content table (§16).
 *
 * Wraps the table and reads the checkbox state from the DOM rather than
 * lifting every row into React state. The table itself is server-rendered —
 * that is what keeps a 50-row page fast — and a controlled checkbox per row
 * would mean hydrating all of it for the sake of a selection.
 *
 * Failures are reported per record. A bulk publish of 40 items where 3 lack a
 * title publishes 37 and names the 3, because the alternative leaves a reviewer
 * unable to make progress until every record is perfect.
 */
export function ContentBulkBar({
  ids,
  children,
}: {
  ids: readonly string[];
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [result, setResult] = useState<BulkActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  // Read the checkboxes on change. One listener on the container rather than a
  // handler per row.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sync = () => {
      const boxes = container.querySelectorAll<HTMLInputElement>('input[name="contentIds"]:checked');
      setSelected([...boxes].map((box) => box.value));
    };
    container.addEventListener("change", sync);
    return () => container.removeEventListener("change", sync);
  }, [ids]);

  const setAll = (checked: boolean) => {
    const container = containerRef.current;
    if (!container) return;
    for (const box of container.querySelectorAll<HTMLInputElement>('input[name="contentIds"]')) {
      box.checked = checked;
    }
    setSelected(checked ? [...ids] : []);
  };

  const run = (action: () => Promise<BulkActionResult>) => {
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) setAll(false);
    });
  };

  return (
    <div ref={containerRef}>
      {selected.length > 0 ? (
        <div className="sticky top-12 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--color-accent)]/30 bg-[var(--color-tone-info-bg)] px-3 py-2">
          <span className="text-xs font-medium text-ink-800">{selected.length} selected</span>

          <Button disabled={isPending} onClick={() => run(() => bulkApproveAction([...selected]))}>
            Approve
          </Button>
          <Button
            variant="primary"
            disabled={isPending}
            onClick={() => run(() => bulkPublishAction([...selected]))}
          >
            Publish
          </Button>
          <Button
            variant="danger"
            disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Why are these being rejected?");
              if (reason?.trim()) run(() => bulkRejectAction([...selected], reason.trim()));
            }}
          >
            Reject
          </Button>
          <Button disabled={isPending} onClick={() => run(() => bulkArchiveAction([...selected]))}>
            Archive
          </Button>

          <select
            className="h-6 rounded-[4px] border border-ink-300 bg-surface px-1 text-2xs"
            defaultValue=""
            disabled={isPending}
            onChange={(event) => {
              const status = event.target.value as LifecycleStatus;
              event.target.value = "";
              if (status) run(() => bulkSetStatusAction([...selected], status));
            }}
          >
            <option value="">Set status…</option>
            {LIFECYCLE_STATUSES.filter(
              // Only offer statuses something could plausibly move to. The
              // server re-checks each record's own transition, so a mixed
              // selection produces per-record failures rather than a silent
              // partial result.
              (status) => status !== "capturing" && status !== "queued" && status !== "discovered",
            ).map((status) => (
              <option key={status} value={status}>
                {LIFECYCLE_STATUS_META[status].label}
              </option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" onClick={() => setAll(true)}>
              Select all {ids.length}
            </Button>
            <Button variant="ghost" onClick={() => setAll(false)}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="border-b border-ink-100 p-3">
          <Note tone={result.ok ? (result.failures.length > 0 ? "warning" : "success") : "danger"}>
            <p>{result.message ?? result.error}</p>
            {result.failures.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {result.failures.slice(0, 10).map((failure) => (
                  <li key={failure.id} className="text-2xs">
                    <Link href={`/content/${failure.id}`} className="underline">
                      {failure.id.slice(0, 8)}
                    </Link>{" "}
                    — {failure.reason}
                  </li>
                ))}
                {result.failures.length > 10 ? (
                  <li className="text-2xs text-ink-500">
                    …and {result.failures.length - 10} more
                  </li>
                ) : null}
              </ul>
            ) : null}
          </Note>
        </div>
      ) : null}

      {children}
    </div>
  );
}

/** Whether a transition is offered, exported for the detail page's actions. */
export function canOffer(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return canTransition(from, to);
}
