"use client";

import { useState, useTransition } from "react";
import {
  IGNORE_REASONS,
  IGNORE_REASON_LABELS,
  type DiscoveredPageStatus,
  type IgnoreReason,
  type StudioProfile,
} from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import {
  captureScreenAction,
  ignorePagesAction,
  restorePagesAction,
} from "@/lib/actions/discovery";

/**
 * The things a person can do with a candidate (§1).
 *
 * Capture it, or set it aside. Nothing else — a candidate has no other states,
 * and offering a third option here would be inventing one.
 *
 * "Add to flow" is deliberately not here. A flow step is a captured Screen, and
 * a candidate is not one yet; the gesture lives on the flow's own page, where
 * capturing into the flow is what creates the step. Offering it on a URL would
 * promise something the data model cannot hold.
 */
export function CandidateActions({
  id,
  url,
  status,
  sourceId,
  screenCount,
}: {
  id: string;
  url: string;
  status: DiscoveredPageStatus;
  sourceId: string | null;
  screenCount: number;
}) {
  const [profile, setProfile] = useState<StudioProfile>("desktop_1440");
  const [reason, setReason] = useState<IgnoreReason>("not_a_product_screen");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [pending, startTransition] = useTransition();

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
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <select
          value={profile}
          onChange={(event) => setProfile(event.target.value as StudioProfile)}
          className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
          aria-label="Capture device"
        >
          <option value="desktop_1440">Desktop</option>
          <option value="mobile_390">Mobile</option>
        </select>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            run(() =>
              captureScreenAction({
                url,
                profile,
                discoveredPageId: id,
                sourceId: sourceId ?? undefined,
              }),
            )
          }
        >
          Capture screen
        </Button>

        {status === "ignored" ? (
          <Button disabled={pending} onClick={() => run(() => restorePagesAction([id]))}>
            Return to queue
          </Button>
        ) : (
          <>
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as IgnoreReason)}
              className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
              aria-label="Reason"
              disabled={screenCount > 0}
            >
              {IGNORE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {IGNORE_REASON_LABELS[value]}
                </option>
              ))}
            </select>
            <Button
              disabled={pending || screenCount > 0}
              title={
                screenCount > 0 ? "Screens have already been captured from this page." : undefined
              }
              onClick={() => run(() => ignorePagesAction([id], reason))}
            >
              Ignore
            </Button>
          </>
        )}
      </div>
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
    </div>
  );
}
