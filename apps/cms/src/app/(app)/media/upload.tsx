"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import clsx from "clsx";
import { UPLOAD_ACCEPT_ATTRIBUTE } from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import { type MediaActionResult, uploadMediaAction } from "@/lib/actions/media";

/**
 * Upload, with drag and drop (§9).
 *
 * Files are uploaded one at a time rather than in one request, so a rejected
 * file reports its own reason and does not take the rest of the batch with it.
 * A crawler-built library accumulates odd files, and "3 of 12 uploaded, here
 * is what was wrong with the others" is far more useful than a single failure.
 */
export function MediaUpload({
  contentItemId,
  role,
  label = "Upload",
}: {
  contentItemId?: string;
  role?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState<readonly { name: string; result: MediaActionResult }[]>([]);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = [...files];
    setResults([]);

    startTransition(async () => {
      const collected: { name: string; result: MediaActionResult }[] = [];
      for (const file of list) {
        const formData = new FormData();
        formData.set("file", file);
        if (contentItemId) formData.set("contentItemId", contentItemId);
        if (role) formData.set("role", role);
        collected.push({ name: file.name, result: await uploadMediaAction(formData) });
        setResults([...collected]);
      }
    });
  };

  return (
    <div className="relative">
      <Button variant="primary" onClick={() => setOpen((value) => !value)}>
        {label}
      </Button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close upload"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 w-96 rounded-md border border-ink-200 bg-surface p-3 shadow-lg">
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                upload(event.dataTransfer.files);
              }}
              className={clsx(
                "flex flex-col items-center justify-center rounded-[4px] border-2 border-dashed p-6 text-center transition-colors",
                dragging ? "border-[var(--color-accent)] bg-[var(--color-tone-info-bg)]" : "border-ink-300",
              )}
            >
              <p className="text-xs text-ink-700">Drop files here</p>
              <p className="mt-0.5 text-2xs text-ink-500">or</p>
              <Button className="mt-1.5" onClick={() => inputRef.current?.click()} disabled={isPending}>
                Choose files
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={UPLOAD_ACCEPT_ATTRIBUTE}
                className="hidden"
                onChange={(event) => upload(event.target.files)}
              />
              <p className="mt-2 text-2xs text-ink-500">
                The file type is detected from its contents, not its name. Anything a browser could
                execute is stored as a download only.
              </p>
            </div>

            {isPending ? (
              <p className="mt-2 text-2xs text-ink-500">Uploading…</p>
            ) : null}

            {results.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {results.map(({ name, result }) => (
                  <li key={name}>
                    <Note tone={result.ok ? (result.deduplicated ? "info" : "success") : "danger"}>
                      <span className="font-medium">{name}</span>
                      <span className="block text-2xs">{result.message ?? result.error}</span>
                      {result.ok && result.mediaId ? (
                        <Link
                          href={`/media/${result.mediaId}`}
                          className="mt-0.5 block text-2xs underline"
                        >
                          Open its record
                        </Link>
                      ) : null}
                    </Note>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
