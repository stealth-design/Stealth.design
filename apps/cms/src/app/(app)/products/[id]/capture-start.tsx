"use client";

import { useEffect, useState } from "react";
import { GitCommitHorizontal, Image as ImageIcon, X } from "lucide-react";
import clsx from "clsx";
import { TagPicker, type TagOption } from "@/components/tag-picker";

export type CaptureMode = "screens" | "flow";

export interface CaptureChoice {
  readonly mode: CaptureMode;
  readonly flowName: string | null;
  readonly termIds: readonly string[];
}

// The last tags someone started with. A team capturing a hundred hero
// sections in a row should not have to choose the same tag a hundred times.
const LAST_TAGS_KEY = "uxd.capture.last-tags";

function readLastTags(valid: ReadonlySet<string>): string[] {
  try {
    const raw = window.localStorage.getItem(LAST_TAGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && valid.has(id)) : [];
  } catch {
    return [];
  }
}

function writeLastTags(termIds: readonly string[]): void {
  try {
    window.localStorage.setItem(LAST_TAGS_KEY, JSON.stringify(termIds));
  } catch {
    // Remembering is a convenience; a private window simply starts empty.
  }
}

/**
 * "What are you capturing?" — asked once, before the browser opens.
 *
 * Two answers, because they produce different things: separate screens, or a
 * flow whose screens are steps in order. Tags are optional and apply to every
 * capture in the session; anything can be retagged later, which is why
 * skipping is a first-class choice rather than a small link.
 */
export function CaptureStart({
  address,
  tags,
  pending,
  error,
  onStart,
  onClose,
}: {
  address: string;
  tags: readonly TagOption[];
  pending: boolean;
  error: string | null;
  onStart: (choice: CaptureChoice) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<CaptureMode>("screens");
  const [flowName, setFlowName] = useState("");
  const [termIds, setTermIds] = useState<string[]>([]);

  useEffect(() => {
    setTermIds(readLastTags(new Set(tags.map((tag) => tag.id))));
  }, [tags]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const needsName = mode === "flow" && flowName.trim().length === 0;

  const start = (withTags: boolean) => {
    const chosen = withTags ? termIds : [];
    if (withTags) writeLastTags(chosen);
    onStart({ mode, flowName: mode === "flow" ? flowName.trim() : null, termIds: chosen });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-[10vh]">
      <button type="button" aria-label="Close" className="fixed inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-start-title"
        className="relative w-full max-w-lg rounded-2xl border border-ink-200 bg-surface p-6 shadow-2xl shadow-black/60"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex size-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
        >
          <X aria-hidden className="size-4" />
        </button>

        <h2 id="capture-start-title" className="text-[15px] font-medium text-ink-900">
          What are you capturing?
        </h2>
        <p className="mt-1 truncate font-mono text-xs text-ink-500">{address}</p>

        <div role="radiogroup" aria-label="What to capture" className="mt-5 grid grid-cols-2 gap-3">
          <ModeCard
            active={mode === "screens"}
            onClick={() => setMode("screens")}
            icon={<ImageIcon aria-hidden className="size-4" />}
            title="Screens"
            body="One or more screens of this site, each kept on its own."
          />
          <ModeCard
            active={mode === "flow"}
            onClick={() => setMode("flow")}
            icon={<GitCommitHorizontal aria-hidden className="size-4" />}
            title="A flow"
            body="A journey, screen by screen — each capture is the next step."
          />
        </div>

        {mode === "flow" ? (
          <label className="mt-4 block">
            <span className="text-xs text-ink-600">Name the flow</span>
            <input
              autoFocus
              value={flowName}
              onChange={(event) => setFlowName(event.target.value)}
              placeholder="Sign up"
              className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none"
            />
          </label>
        ) : null}

        <div className="mt-5">
          <p className="text-xs text-ink-600">
            Tags <span className="text-ink-400">— optional, added to every capture</span>
          </p>
          <div className="mt-2">
            <TagPicker options={tags} selected={termIds} onChange={setTermIds} disabled={pending} />
          </div>
        </div>

        {error ? <p className="mt-4 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-ink-200 pt-4">
          <button
            type="button"
            disabled={pending || needsName}
            onClick={() => start(false)}
            className="h-9 rounded-lg px-3 text-[13px] text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:opacity-40"
          >
            Skip, tag later
          </button>
          <button
            type="button"
            disabled={pending || needsName}
            onClick={() => start(true)}
            className="h-9 rounded-lg bg-ink-900 px-4 text-[13px] font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-40"
          >
            {pending ? "Opening browser…" : "Start capturing"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={clsx(
        "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors",
        active ? "border-ink-500 bg-ink-100" : "border-ink-200 hover:border-ink-300 hover:bg-ink-100/60",
      )}
    >
      <span
        className={clsx(
          "flex size-8 items-center justify-center rounded-lg",
          active ? "bg-ink-900 text-ink-50" : "bg-ink-200 text-ink-700",
        )}
      >
        {icon}
      </span>
      <span className="text-[13px] font-medium text-ink-900">{title}</span>
      <span className="text-xs leading-relaxed text-ink-500">{body}</span>
    </button>
  );
}
