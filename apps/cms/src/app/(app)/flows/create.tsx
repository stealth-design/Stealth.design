"use client";

import { useState, useTransition } from "react";
import { Button, Note } from "@/components/ui/primitives";
import { createFlowAction } from "@/lib/actions/flows";

/**
 * Create a flow (§10).
 *
 * Name and goal only. Everything else about a flow — its steps, its order, its
 * cover image — comes from walking it, and asking for those up front would be
 * asking a researcher to describe a journey before they have taken it.
 */
export function CreateFlow({ sources }: { sources: readonly { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) return <Button variant="primary" onClick={() => setOpen(true)}>Create flow</Button>;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <input
          value={name}
          autoFocus
          placeholder="Signup"
          onChange={(event) => setName(event.target.value)}
          className="h-7 w-40 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
          aria-label="Flow name"
        />
        <input
          value={goal}
          placeholder="What the user is trying to do"
          onChange={(event) => setGoal(event.target.value)}
          className="h-7 w-56 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
          aria-label="Goal"
        />
        <select
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
          aria-label="Source"
        >
          <option value="">No source</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          disabled={pending || name.trim().length === 0}
          onClick={() =>
            startTransition(async () => {
              const result = await createFlowAction({
                name: name.trim(),
                goal: goal.trim() || undefined,
                sourceId: sourceId || undefined,
              });
              if (result.error) setMessage(result.error);
            })
          }
        >
          Create
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {message ? <Note tone="danger">{message}</Note> : null}
    </div>
  );
}
