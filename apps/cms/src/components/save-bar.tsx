"use client";

import clsx from "clsx";

/**
 * Where an edit is saved. Always in the same place on every editing surface,
 * always saying whether there is anything to save — so "did that save?" is
 * never a question.
 */
export function SaveBar({
  dirty,
  saving,
  error,
  onSave,
  onDiscard,
  className,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-2", className)}>
      <p
        role="status"
        className={clsx(
          "min-w-0 flex-1 text-xs",
          error ? "text-[var(--color-tone-danger)]" : dirty ? "text-[var(--color-tone-warning)]" : "text-ink-500",
        )}
      >
        {error ?? (saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved")}
      </p>
      {dirty ? (
        <button
          type="button"
          disabled={saving}
          onClick={onDiscard}
          className="h-8 rounded-md px-3 text-xs text-ink-600 hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
        >
          Discard changes
        </button>
      ) : null}
      <button
        type="button"
        disabled={!dirty || saving}
        onClick={onSave}
        className="h-8 rounded-md bg-ink-900 px-4 text-xs font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
