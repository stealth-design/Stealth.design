"use client";

import { useState, useTransition } from "react";
import { Button, Note } from "@/components/ui/primitives";
import { addPageAction } from "@/lib/actions/discovery";

/**
 * Add a URL to the queue by hand.
 *
 * The escape hatch for the common case once a researcher knows a product: they
 * already know they want stripe.com/pricing and do not need a crawl to tell
 * them it exists. It goes through the same validation and source resolution as
 * a crawled URL, so a hand-added candidate is indistinguishable downstream.
 */
export function AddCandidate({ sources }: { sources: readonly { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return <Button onClick={() => setOpen(true)}>Add a URL</Button>;
  }

  const submit = () => {
    startTransition(async () => {
      const result = await addPageAction(url.trim(), sourceId || undefined);
      setMessage(
        result.error
          ? { text: result.error, tone: "danger" }
          : { text: result.message ?? "Added.", tone: "info" },
      );
      if (!result.error) {
        setUrl("");
        setOpen(false);
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <input
          type="url"
          value={url}
          autoFocus
          placeholder="Paste a URL"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && url.trim()) submit();
            if (event.key === "Escape") setOpen(false);
          }}
          className="h-7 w-72 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <select
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
          aria-label="Source"
        >
          <option value="">Resolve by domain</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <Button variant="primary" disabled={pending || url.trim().length === 0} onClick={submit}>
          Add
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
    </div>
  );
}
