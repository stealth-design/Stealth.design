"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  REVIEW_DECISIONS,
  REVIEW_DECISION_META,
  REVIEW_REASON_META,
  REVIEW_SHORTCUTS,
  RIGHTS_STATUS_META,
  type ReviewDecision,
  type ReviewReason,
  type RightsStatus,
} from "@uxd/types";
import {
  Badge,
  Button,
  InlineMeta,
  Kbd,
  Note,
  Panel,
  Thumbnail,
} from "@/components/ui/primitives";
import {
  type BulkActionResult,
  bulkApproveAction,
  bulkAssignAction,
  bulkRejectAction,
  decideAction,
} from "@/lib/actions/review";

export interface QueueItem {
  readonly id: string;
  readonly title: string | null;
  readonly kind: string;
  readonly sourceUrl: string | null;
  readonly sourceName: string | null;
  readonly sourceId: string | null;
  readonly rightsStatus: string;
  readonly capturedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
  readonly reviewReason: string | null;
  readonly assignedToName: string | null;
  readonly pendingSuggestions: number;
  readonly classificationConfidence: number | null;
  readonly thumbnailUrl: string | null;
}

/**
 * The review queue.
 *
 * Two panes: a compact list on the left showing where you are in the backlog,
 * and the current item on the right at a size where a screenshot can actually
 * be judged. Every decision is one key, and the cursor advances automatically,
 * so a reviewer's hands never leave the keyboard.
 *
 * Two details matter for throughput:
 *
 *   - A decision is optimistic. The item leaves the list immediately and the
 *     cursor moves on; the server call resolves behind it. Waiting for a round
 *     trip per decision is what makes a queue feel like work.
 *   - Time-on-item is measured and sent with the decision, which is how §15's
 *     claim that the team's time is valuable becomes a number someone can act
 *     on.
 */
export function ReviewQueue({
  items,
  reviewers,
  canPublish,
}: {
  items: readonly QueueItem[];
  reviewers: readonly { id: string; name: string }[];
  canPublish: boolean;
}) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Items already decided this session, hidden from the list without waiting
  // for the server round trip or a page refresh.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [notesFor, setNotesFor] = useState<{ id: string; decision: ReviewDecision } | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const notesRef = useRef<HTMLTextAreaElement>(null);
  const openedAt = useRef<number>(Date.now());

  const visible = items.filter((item) => !settled.has(item.id));
  const current = visible[Math.min(cursor, Math.max(0, visible.length - 1))] ?? null;

  // Reset the timer whenever the reviewer moves to a different item, so
  // "time on item" measures judgement rather than idle time on the page.
  useEffect(() => {
    openedAt.current = Date.now();
  }, [current?.id]);

  const decide = useCallback(
    (decision: ReviewDecision, options: { publish?: boolean; notes?: string } = {}) => {
      if (!current) return;
      const meta = REVIEW_DECISION_META[decision];

      // A decision that needs a written reason opens the note field instead of
      // firing — the requirement is enforced server side too, but blocking here
      // avoids a pointless round trip.
      if (meta.requiresNote && !options.notes) {
        setNotesFor({ id: current.id, decision });
        requestAnimationFrame(() => notesRef.current?.focus());
        return;
      }

      const id = current.id;
      const durationMs = Date.now() - openedAt.current;

      setSettled((previous) => new Set(previous).add(id));
      setNotesFor(null);
      setFeedback(null);

      startTransition(async () => {
        const result = await decideAction({
          contentId: id,
          decision,
          notes: options.notes,
          durationMs,
          publishImmediately: options.publish ?? false,
        });
        if (!result.ok) {
          // Put it back: the decision did not stick, and silently dropping it
          // from the queue would lose the work.
          setSettled((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
          setFeedback({ text: result.error ?? "That decision did not save.", tone: "danger" });
        } else if (result.issues.length > 0) {
          setFeedback({
            text: `${result.message} ${result.issues.map((i) => i.message).join(" ")}`,
            tone: "info",
          });
        } else if (result.message) {
          setFeedback({ text: result.message, tone: "info" });
        }
      });
    },
    [current],
  );

  const toggleSelected = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // --- Keyboard map (§15) ------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never hijack a key while the reviewer is typing a note.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        if (event.key === "Escape") {
          setNotesFor(null);
          target.blur();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          setCursor((c) => Math.min(c + 1, Math.max(0, visible.length - 1)));
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          setCursor((c) => Math.max(0, c - 1));
          break;
        case "a":
          event.preventDefault();
          decide("approved");
          break;
        case "r":
          event.preventDefault();
          decide("rejected");
          break;
        case "c":
          event.preventDefault();
          decide("changes_requested");
          break;
        case "e":
          event.preventDefault();
          decide("escalated");
          break;
        case "p":
          event.preventDefault();
          if (canPublish) decide("approved", { publish: true });
          break;
        case "x":
          event.preventDefault();
          if (current) toggleSelected(current.id);
          break;
        case "?":
          event.preventDefault();
          setShowHelp((value) => !value);
          break;
        case "Escape":
          setShowHelp(false);
          setNotesFor(null);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canPublish, current, decide, toggleSelected, visible.length]);

  const runBulk = (action: () => Promise<BulkActionResult>) => {
    startTransition(async () => {
      const result = await action();
      setBulkResult(result);
      if (result.ok) {
        // Optimistically hide everything that succeeded.
        setSettled((previous) => {
          const next = new Set(previous);
          for (const id of selected) next.add(id);
          for (const failure of result.failures) next.delete(failure.id);
          return next;
        });
        setSelected(new Set());
      }
    });
  };

  if (visible.length === 0) {
    return (
      <Panel>
        <div className="p-8 text-center">
          <p className="text-sm font-medium text-ink-800">Queue cleared</p>
          <p className="mt-1 text-xs text-ink-500">
            You have worked through everything that was waiting. Reload for anything new.
          </p>
          {feedback ? (
            <div className="mx-auto mt-4 max-w-md">
              <Note tone={feedback.tone}>{feedback.text}</Note>
            </div>
          ) : null}
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      {feedback ? <Note tone={feedback.tone}>{feedback.text}</Note> : null}

      {/* --- Bulk bar (§16) --------------------------------------- */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-tone-info-bg)] px-3 py-2">
          <span className="text-xs font-medium text-ink-800">
            {selected.size} selected
          </span>
          <Button disabled={isPending} onClick={() => runBulk(() => bulkApproveAction([...selected]))}>
            Approve all
          </Button>
          {canPublish ? (
            <Button
              variant="primary"
              disabled={isPending}
              onClick={() => runBulk(() => bulkApproveAction([...selected]))}
              title="Approve the selection. Publish from the Approved list once you have checked them."
            >
              Approve selection
            </Button>
          ) : null}
          <Button
            variant="danger"
            disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Why are these being rejected? (recorded on each record)");
              if (reason && reason.trim().length > 0) {
                runBulk(() => bulkRejectAction([...selected], reason.trim()));
              }
            }}
          >
            Reject all
          </Button>
          <select
            className="h-6 rounded-[4px] border border-ink-300 bg-surface px-1 text-2xs"
            defaultValue=""
            onChange={(event) => {
              const value = event.target.value;
              if (value) runBulk(() => bulkAssignAction([...selected], value === "none" ? null : value));
              event.target.value = "";
            }}
          >
            <option value="">Assign to…</option>
            <option value="none">Unassign</option>
            {reviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>
                {reviewer.name}
              </option>
            ))}
          </select>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {bulkResult?.failures && bulkResult.failures.length > 0 ? (
        <Note tone="warning">
          <p className="font-medium">{bulkResult.message}</p>
          <ul className="mt-1 space-y-0.5">
            {bulkResult.failures.slice(0, 8).map((failure) => (
              <li key={failure.id} className="text-2xs">
                <Link href={`/content/${failure.id}`} className="underline">
                  {failure.id.slice(0, 8)}
                </Link>{" "}
                — {failure.reason}
              </li>
            ))}
          </ul>
        </Note>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
        {/* --- Queue list ----------------------------------------- */}
        <Panel
          title={`Queue (${visible.length})`}
          description="j / k to move"
          className="self-start"
        >
          <ul className="max-h-[calc(100vh-260px)] overflow-y-auto">
            {visible.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setCursor(index)}
                  className={clsx(
                    "flex w-full items-start gap-2 border-b border-ink-100 px-2 py-1.5 text-left transition-colors",
                    index === cursor ? "bg-[var(--color-tone-info-bg)]" : "hover:bg-ink-100",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggleSelected(item.id)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Select ${item.title ?? "untitled"}`}
                    className="mt-0.5 shrink-0"
                  />
                  <Thumbnail url={item.thumbnailUrl} alt="" width={40} height={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink-800">
                      {item.title ?? "Untitled"}
                    </span>
                    <span className="block truncate text-2xs text-ink-500">
                      {item.sourceName ?? item.sourceUrl ?? item.kind}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        {/* --- Current item --------------------------------------- */}
        {current ? (
          <div className="min-w-0 space-y-3">
            <Panel>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-ink-900">
                      {current.title ?? "Untitled"}
                    </h2>
                    <Badge tone="neutral">{current.kind}</Badge>
                    {current.version > 1 ? (
                      <Badge tone="info" title="This page has been captured before.">
                        v{current.version}
                      </Badge>
                    ) : null}
                    {current.reviewReason ? (
                      <Badge
                        tone="warning"
                        title={REVIEW_REASON_META[current.reviewReason as ReviewReason]?.description}
                      >
                        {REVIEW_REASON_META[current.reviewReason as ReviewReason]?.label ??
                          current.reviewReason}
                      </Badge>
                    ) : null}
                    {RIGHTS_STATUS_META[current.rightsStatus as RightsStatus]?.blocksPublishing ? (
                      <Badge
                        tone="danger"
                        title={RIGHTS_STATUS_META[current.rightsStatus as RightsStatus].description}
                      >
                        Rights hold
                      </Badge>
                    ) : null}
                  </div>
                  {current.sourceUrl ? (
                    <a
                      href={current.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="mono mt-0.5 block truncate text-2xs text-ink-500 hover:text-ink-800 hover:underline"
                    >
                      {current.sourceUrl}
                    </a>
                  ) : null}
                  <InlineMeta
                    items={[
                      current.sourceName,
                      current.assignedToName ? `assigned to ${current.assignedToName}` : "unassigned",
                      current.pendingSuggestions > 0
                        ? `${current.pendingSuggestions} suggestion${current.pendingSuggestions === 1 ? "" : "s"} to confirm`
                        : null,
                      current.classificationConfidence !== null
                        ? `lowest confidence ${Math.round(current.classificationConfidence * 100)}%`
                        : null,
                    ]}
                  />
                </div>
                <Link
                  href={`/content/${current.id}`}
                  className="shrink-0 text-2xs text-ink-500 underline hover:text-ink-800"
                >
                  Open full record
                </Link>
              </div>

              {/* The screenshot, at a size where it can be judged. */}
              <div className="flex max-h-[52vh] justify-center overflow-y-auto bg-ink-100 p-3">
                {current.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={current.thumbnailUrl}
                    alt={`Capture of ${current.title ?? current.sourceUrl ?? "this page"}`}
                    className="max-w-full rounded-[3px] border border-ink-200 bg-surface object-contain"
                  />
                ) : (
                  <p className="py-12 text-xs text-ink-500">
                    No screenshot was stored for this record.
                  </p>
                )}
              </div>

              {/* --- Decisions --------------------------------------- */}
              <div className="space-y-2 border-t border-ink-200 bg-ink-50 p-3">
                {notesFor?.id === current.id ? (
                  <div className="space-y-2">
                    <label
                      htmlFor="decision-notes"
                      className="block text-2xs font-medium uppercase tracking-wide text-ink-500"
                    >
                      {REVIEW_DECISION_META[notesFor.decision].label} — why?
                      <span className="ml-1 font-normal normal-case text-ink-400">
                        Required, and kept on the record so it explains itself later.
                      </span>
                    </label>
                    <textarea
                      id="decision-notes"
                      ref={notesRef}
                      rows={2}
                      className="w-full rounded-[4px] border border-ink-300 p-2 text-xs outline-none focus:border-[var(--color-accent)]"
                      onKeyDown={(event) => {
                        // Enter submits, so a note costs no mouse movement.
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          const value = event.currentTarget.value.trim();
                          if (value.length > 0) decide(notesFor.decision, { notes: value });
                        }
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        disabled={isPending}
                        onClick={() => {
                          const value = notesRef.current?.value.trim() ?? "";
                          if (value.length > 0) decide(notesFor.decision, { notes: value });
                        }}
                      >
                        {REVIEW_DECISION_META[notesFor.decision].label}
                      </Button>
                      <Button variant="ghost" onClick={() => setNotesFor(null)}>
                        Cancel
                      </Button>
                      <span className="text-2xs text-ink-500">
                        <Kbd>Enter</Kbd> to submit · <Kbd>Esc</Kbd> to cancel
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {REVIEW_DECISIONS.map((decision) => {
                      const meta = REVIEW_DECISION_META[decision];
                      return (
                        <Button
                          key={decision}
                          variant={
                            decision === "approved"
                              ? "primary"
                              : decision === "rejected"
                                ? "danger"
                                : "secondary"
                          }
                          disabled={isPending}
                          title={meta.description}
                          onClick={() => decide(decision)}
                        >
                          {meta.label}
                          <Kbd>{meta.shortcut}</Kbd>
                        </Button>
                      );
                    })}
                    {canPublish ? (
                      <Button
                        variant="primary"
                        disabled={isPending}
                        title="Approve and publish in one step, if nothing blocks publication."
                        onClick={() => decide("approved", { publish: true })}
                      >
                        Approve &amp; publish
                        <Kbd>p</Kbd>
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setShowHelp(true)}
                      className="ml-auto text-2xs text-ink-500 underline hover:text-ink-800"
                    >
                      Shortcuts <Kbd>?</Kbd>
                    </button>
                  </div>
                )}
              </div>
            </Panel>
          </div>
        ) : null}
      </div>

      {/* --- Shortcut help ----------------------------------------- */}
      {showHelp ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <button
            type="button"
            aria-label="Close shortcuts"
            className="absolute inset-0 cursor-default"
            onClick={() => setShowHelp(false)}
          />
          <div className="relative w-full max-w-md rounded-md border border-ink-300 bg-surface p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-ink-900">Keyboard shortcuts</h2>
            <p className="mt-0.5 text-2xs text-ink-500">
              These work anywhere in the queue except while typing a note.
            </p>
            <dl className="mt-3 space-y-1">
              {REVIEW_SHORTCUTS.map((shortcut) => (
                <div key={shortcut.action} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-ink-700">{shortcut.label}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {shortcut.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
            <Button className="mt-4 w-full" onClick={() => setShowHelp(false)}>
              Close
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
