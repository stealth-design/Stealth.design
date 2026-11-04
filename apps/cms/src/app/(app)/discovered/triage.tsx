"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  DISCOVERED_PAGE_STATUS_META,
  IGNORE_REASONS,
  IGNORE_REASON_LABELS,
  type DiscoveredPageStatus,
  type IgnoreReason,
  type StudioProfile,
} from "@uxd/types";
import { Badge, Button, Kbd, Note, Thumbnail, Timestamp } from "@/components/ui/primitives";
import {
  captureScreenAction,
  ignorePagesAction,
  restorePagesAction,
} from "@/lib/actions/discovery";

export interface TriageRow {
  readonly id: string;
  readonly status: DiscoveredPageStatus;
  readonly url: string;
  readonly path: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly httpStatus: number | null;
  readonly wordCount: number | null;
  readonly depth: number;
  readonly seenCount: number;
  readonly screenCount: number;
  readonly ignoreReason: string | null;
  readonly lastSeenAt: string;
  readonly sourceId: string | null;
  readonly sourceName: string | null;
  readonly previewUrl: string | null;
}

/**
 * The triage list (§1).
 *
 * Built around the only measurement that matters here: a researcher decides
 * about a candidate every couple of seconds, so the cost of a decision is the
 * whole design. Three affordances follow from that.
 *
 * **Selection is bulk-first.** Most of a crawl is documentation and blog
 * posts, and a researcher wants them gone in one gesture rather than 180
 * confirmations. Shift-click extends a range, because "ignore everything under
 * /docs/" is the actual shape of the work.
 *
 * **Capture is one click, and it commits.** Pressing Capture opens a live
 * browser on that URL — there is no intermediate form, because the thing a
 * researcher needs to decide (which state is worth having) cannot be decided
 * before seeing the page.
 *
 * **Ignoring asks why.** One click more, and it is the click that makes
 * "how much of what we crawl is worthless, and in which way?" answerable — the
 * question that tells us the crawl scope is wrong.
 */
export function TriageList({
  rows,
  profile,
}: {
  rows: readonly TriageRow[];
  profile: StudioProfile;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [reason, setReason] = useState<IgnoreReason>("not_a_product_screen");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (id: string, shiftKey: boolean) => {
    setSelected((current) => {
      const next = new Set(current);

      // Range select. The anchor is the last row clicked without shift, which
      // is what makes "click the first, shift-click the last" behave the way
      // it does in every file manager.
      if (shiftKey && lastClicked) {
        const from = rows.findIndex((r) => r.id === lastClicked);
        const to = rows.findIndex((r) => r.id === id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          for (let i = start; i <= end; i += 1) {
            const row = rows[i];
            if (row) next.add(row.id);
          }
          return next;
        }
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!shiftKey) setLastClicked(id);
  };

  const run = (action: () => Promise<{ error: string | null; message: string | null }>) => {
    startTransition(async () => {
      const result = await action();
      setMessage(
        result.error
          ? { text: result.error, tone: "danger" }
          : result.message
            ? { text: result.message, tone: "info" }
            : null,
      );
      if (!result.error) setSelected(new Set());
    });
  };

  const ids = [...selected];

  return (
    <div className="flex flex-col gap-3">
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}

      {ids.length > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-[4px] border border-ink-300 bg-surface px-3 py-2 shadow-sm">
          <span className="text-xs font-medium">{ids.length} selected</span>
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value as IgnoreReason)}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Reason for setting aside"
          >
            {IGNORE_REASONS.map((value) => (
              <option key={value} value={value}>
                {IGNORE_REASON_LABELS[value]}
              </option>
            ))}
          </select>
          <Button disabled={pending} onClick={() => run(() => ignorePagesAction(ids, reason))}>
            Set aside
          </Button>
          <Button disabled={pending} onClick={() => run(() => restorePagesAction(ids))}>
            Return to queue
          </Button>
          <button
            type="button"
            className="text-2xs text-ink-500 underline hover:text-ink-800"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
          <span className="ml-auto text-2xs text-ink-500">
            <Kbd>Shift</Kbd> click to select a range
          </span>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const meta = DISCOVERED_PAGE_STATUS_META[row.status];
          const isSelected = selected.has(row.id);
          return (
            <li
              key={row.id}
              className={
                "flex items-start gap-3 rounded-[4px] border px-3 py-2 transition-colors " +
                (isSelected
                  ? "border-[var(--color-accent)] bg-[var(--color-tone-info-bg)]"
                  : "border-ink-200 bg-surface")
              }
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => undefined}
                onClick={(event) => toggle(row.id, event.shiftKey)}
                className="mt-1 size-4 shrink-0"
                aria-label={`Select ${row.path ?? row.url}`}
              />

              <Thumbnail url={row.previewUrl} alt="" width={72} height={48} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="truncate text-xs font-medium">{row.title ?? row.path ?? row.url}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {row.screenCount > 0 ? (
                    <Badge tone="success">
                      {row.screenCount} screen{row.screenCount === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                  {row.ignoreReason ? (
                    <span className="text-2xs text-ink-500">
                      {IGNORE_REASON_LABELS[row.ignoreReason as IgnoreReason] ?? row.ignoreReason}
                    </span>
                  ) : null}
                </div>

                <div className="mt-0.5 truncate font-mono text-2xs text-ink-500">
                  {row.path ?? row.url}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-500">
                  {row.sourceName ? <span>{row.sourceName}</span> : null}
                  {row.httpStatus ? <span>HTTP {row.httpStatus}</span> : null}
                  {row.wordCount !== null ? <span>{row.wordCount.toLocaleString()} words</span> : null}
                  <span>depth {row.depth}</span>
                  {row.seenCount > 1 ? <span>seen {row.seenCount}×</span> : null}
                  <Timestamp value={row.lastSeenAt} />
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      captureScreenAction({
                        url: row.url,
                        profile,
                        discoveredPageId: row.id,
                        sourceId: row.sourceId ?? undefined,
                      }),
                    )
                  }
                >
                  Capture screen
                </Button>
                <Link
                  href={`/discovered/${row.id}`}
                  className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
                >
                  Details
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
