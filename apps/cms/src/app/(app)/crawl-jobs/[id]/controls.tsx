"use client";

import { useState, useTransition } from "react";
import { JOB_STATUS_META, canJobTransition, type JobStatus } from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import {
  cancelJobAction,
  pauseJobAction,
  recomputeCountersAction,
  resumeJobAction,
  retryJobItemsAction,
  startJobAction,
} from "@/lib/actions/ingestion";

/**
 * Job controls (§6: pause, resume, cancel, retry).
 *
 * Which buttons appear is derived from `canJobTransition`, the same transition
 * map the server checks — so the UI never offers an action the server would
 * refuse, and adding a status does not mean hunting for buttons to update.
 *
 * Cancel asks for confirmation, because it is the one action here that
 * discards queued work (§28: destructive action confirmations).
 */
export function JobControls({ jobId, status }: { jobId: string; status: JobStatus }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

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
      setConfirmingCancel(false);
    });
  };

  const canStart = canJobTransition(status, "queued");
  const canPause = canJobTransition(status, "paused");
  const canResume = status === "paused";
  const canCancel = canJobTransition(status, "cancelling") || canJobTransition(status, "cancelled");
  const isTerminal = JOB_STATUS_META[status].isTerminal;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        {canStart ? (
          <Button variant="primary" disabled={pending} onClick={() => run(() => startJobAction(jobId))}>
            {status === "ready" ? "Start job" : "Run again"}
          </Button>
        ) : null}

        {canResume ? (
          <Button variant="primary" disabled={pending} onClick={() => run(() => resumeJobAction(jobId))}>
            Resume
          </Button>
        ) : canPause ? (
          <Button disabled={pending} onClick={() => run(() => pauseJobAction(jobId))}>
            Pause
          </Button>
        ) : null}

        <Button disabled={pending} onClick={() => run(() => retryJobItemsAction(jobId))}>
          Retry failed
        </Button>

        {canCancel ? (
          confirmingCancel ? (
            <>
              <span className="text-2xs text-[var(--color-tone-danger)]">
                Cancel queued URLs?
              </span>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => run(() => cancelJobAction(jobId))}
              >
                Yes, cancel
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingCancel(false)}>
                Keep running
              </Button>
            </>
          ) : (
            <Button variant="danger" disabled={pending} onClick={() => setConfirmingCancel(true)}>
              Cancel
            </Button>
          )
        ) : null}

        {isTerminal ? (
          <Button
            variant="ghost"
            disabled={pending}
            title="Recount this job's totals from its items. Use if the numbers look wrong."
            onClick={() => run(() => recomputeCountersAction(jobId))}
          >
            Recount
          </Button>
        ) : null}
      </div>

      {message ? (
        <div className="max-w-md">
          <Note tone={message.tone}>{message.text}</Note>
        </div>
      ) : null}
    </div>
  );
}
