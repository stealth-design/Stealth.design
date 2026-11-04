"use client";

import { useState, useTransition } from "react";
import type { StudioProfile } from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import { captureScreenAction } from "@/lib/actions/discovery";
import {
  removeStepAction,
  reorderStepsAction,
  submitFlowAction,
  updateStepAction,
} from "@/lib/actions/flows";

export interface BuilderStep {
  readonly stepId: string;
  readonly position: number;
  readonly label: string | null;
  readonly title: string | null;
}

/**
 * Flow assembly controls (§10, §11).
 *
 * Two ways into a flow, because there are two ways a researcher actually works.
 *
 * **Walk it.** Give a URL, open a live browser, and every screen captured in
 * that session becomes the next step. This is the signup-flow case: the steps
 * only exist as a sequence someone walked, and assembling them afterwards from
 * a library would mean remembering an order they already knew at capture time.
 *
 * **Assemble it.** Reorder and relabel what is already there. This is the
 * case where the screens were captured for other reasons and the journey is
 * recognised later.
 *
 * Reordering is up/down buttons rather than drag-and-drop. A flow is five to
 * ten steps, the whole order is submitted at once so the server can renumber
 * in a single transaction, and a keyboard-reachable button beats a drag target
 * for something used this rarely.
 */
export function FlowBuilder({
  flowId,
  steps,
  sourceId,
  status,
}: {
  flowId: string;
  steps: readonly BuilderStep[];
  sourceId: string | null;
  status: string;
}) {
  const [url, setUrl] = useState("");
  const [profile, setProfile] = useState<StudioProfile>("desktop_1440");
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

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const order = steps.map((step) => step.stepId);
    const moved = order[index];
    const displaced = order[target];
    if (!moved || !displaced) return;
    order[index] = displaced;
    order[target] = moved;
    run(() => reorderStepsAction(flowId, order));
  };

  return (
    <div className="flex flex-col gap-3">
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}

      <section className="rounded-md border border-ink-200 bg-surface p-3">
        <h2 className="text-xs font-semibold text-ink-800">Walk the flow</h2>
        <p className="mt-0.5 text-2xs leading-relaxed text-ink-500">
          Open a live browser at the starting URL. Every screen you capture in that session becomes
          the next step of this flow, in the order you capture them.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input
            type="url"
            value={url}
            placeholder="Where the journey starts"
            onChange={(event) => setUrl(event.target.value)}
            className="h-7 w-72 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <select
            value={profile}
            onChange={(event) => setProfile(event.target.value as StudioProfile)}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Capture device"
          >
            <option value="desktop_1440">Desktop — 1440×900</option>
            <option value="mobile_390">Mobile — 390×844</option>
          </select>
          <Button
            variant="primary"
            disabled={pending || url.trim().length === 0}
            onClick={() =>
              run(() =>
                captureScreenAction({
                  url: url.trim(),
                  profile,
                  flowId,
                  sourceId: sourceId ?? undefined,
                }),
              )
            }
          >
            Open the studio
          </Button>
        </div>
      </section>

      {steps.length > 0 ? (
        <section className="rounded-md border border-ink-200 bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
            <h2 className="text-xs font-semibold text-ink-800">Order and labels</h2>
            {status === "draft" ? (
              // A flow starts as a draft and cannot be approved out of it. This
              // is the transition the lifecycle requires, offered once there is
              // something to review.
              <Button
                variant="primary"
                size="sm"
                disabled={pending}
                onClick={() => run(() => submitFlowAction(flowId))}
              >
                Send to review
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-ink-100">
            {steps.map((step, index) => (
              <StepRow
                key={step.stepId}
                flowId={flowId}
                step={step}
                index={index}
                isFirst={index === 0}
                isLast={index === steps.length - 1}
                pending={pending}
                onMove={move}
                onRun={run}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function StepRow({
  flowId,
  step,
  index,
  isFirst,
  isLast,
  pending,
  onMove,
  onRun,
}: {
  flowId: string;
  step: BuilderStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  pending: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRun: (action: () => Promise<{ error: string | null; message: string | null }>) => void;
}) {
  const [label, setLabel] = useState(step.label ?? "");
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className="w-6 shrink-0 font-mono text-2xs text-ink-400">{step.position}</span>
      <input
        value={label}
        placeholder={step.title ?? "Step label"}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={() => {
          if (label === (step.label ?? "")) return;
          onRun(() => updateStepAction(flowId, step.stepId, { label }));
        }}
        className="h-7 min-w-0 flex-1 rounded-[4px] border border-ink-300 px-2 text-xs"
        aria-label={`Label for step ${step.position}`}
      />
      <Button size="sm" disabled={pending || isFirst} onClick={() => onMove(index, -1)}>
        ↑
      </Button>
      <Button size="sm" disabled={pending || isLast} onClick={() => onMove(index, 1)}>
        ↓
      </Button>
      {confirming ? (
        <>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => onRun(() => removeStepAction(flowId, step.stepId))}
          >
            Remove it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </>
      ) : (
        // Removing a step deletes the step, never the Screen. The confirm is
        // still there because the position is lost and the order shifts.
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(true)}>
          Remove
        </Button>
      )}
    </li>
  );
}
