"use client";

import { useState, useTransition } from "react";
import { MEDIA_STATUS_META, type MediaStatus } from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import {
  type MediaActionResult,
  archiveMediaAction,
  deleteMediaAction,
  updateMediaAction,
} from "@/lib/actions/media";

/**
 * Actions on one media file (§30).
 *
 * Delete asks for a reason and confirms first, and when the file is still in
 * use it says how many records depend on it. §28 asks for destructive action
 * confirmations, and deleting a screenshot three published records rely on is
 * exactly the case that warrants one.
 */
export function MediaActions({
  mediaId,
  status,
  usageCount,
}: {
  mediaId: string;
  status: MediaStatus;
  usageCount: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<MediaActionResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const run = (action: () => Promise<MediaActionResult>) => {
    startTransition(async () => {
      setResult(await action());
      setConfirmingDelete(false);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button disabled={isPending} onClick={() => setEditing((value) => !value)}>
          Edit details
        </Button>

        {status === "ready" ? (
          <Button disabled={isPending} onClick={() => run(() => archiveMediaAction(mediaId))}>
            Archive
          </Button>
        ) : null}

        {MEDIA_STATUS_META[status].usable || status === "archived" ? (
          confirmingDelete ? (
            <>
              <span className="max-w-xs text-2xs text-[var(--color-tone-danger)]">
                {usageCount > 0
                  ? `${usageCount} record${usageCount === 1 ? "" : "s"} use this file. Deleting it removes the image from them.`
                  : "This removes the file from storage permanently."}
              </span>
              <Button
                variant="danger"
                disabled={isPending}
                onClick={() => {
                  const reason = window.prompt("Why is this file being deleted? (kept on the record)");
                  if (reason?.trim()) run(() => deleteMediaAction(mediaId, reason.trim()));
                  else setConfirmingDelete(false);
                }}
              >
                Delete permanently
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="danger" disabled={isPending} onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          )
        ) : null}
      </div>

      {result ? (
        <div className="max-w-md">
          <Note tone={result.ok ? "success" : "danger"}>{result.message ?? result.error}</Note>
        </div>
      ) : null}

      {editing ? (
        <form
          className="w-80 space-y-2 rounded-md border border-ink-300 bg-surface p-3 text-left shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(() =>
              updateMediaAction(mediaId, {
                title: String(form.get("title") ?? "") || null,
                altText: String(form.get("altText") ?? "") || null,
                caption: String(form.get("caption") ?? "") || null,
                internalNotes: String(form.get("internalNotes") ?? "") || null,
              }),
            );
            setEditing(false);
          }}
        >
          {(
            [
              ["title", "Title", "input"],
              ["altText", "Alt text", "input"],
              ["caption", "Caption", "textarea"],
              ["internalNotes", "Internal notes", "textarea"],
            ] as const
          ).map(([name, label, kind]) => (
            <label key={name} className="block">
              <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                {label}
              </span>
              {kind === "input" ? (
                <input
                  name={name}
                  className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs"
                />
              ) : (
                <textarea
                  name={name}
                  rows={2}
                  className="mt-1 w-full rounded-[4px] border border-ink-300 p-1.5 text-xs"
                />
              )}
            </label>
          ))}
          <div className="flex gap-1.5">
            <Button type="submit" variant="primary" disabled={isPending}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
