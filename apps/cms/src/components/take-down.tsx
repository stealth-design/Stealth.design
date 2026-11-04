"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreWebsiteAction, takeDownWebsiteAction } from "@/lib/actions/products";

/**
 * Take a whole website off the public site — for when a company asks to be
 * removed. Asks for a reason, then sends everything live back to Drafts and
 * blocks new captures; nothing is deleted.
 */
export function TakeDown({ productId, name, live }: { productId: string; name: string; live: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 rounded-lg px-3 text-xs text-ink-500 transition-colors hover:text-[var(--color-tone-danger)]"
      >
        Take down website
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-ink-200 bg-surface p-4 sm:w-96">
      <p className="text-[13px] text-ink-900">Take {name} off the public site?</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        All {live} live {live === 1 ? "screen goes" : "screens go"} back to Drafts and the website can&apos;t be captured
        until an admin allows it again. Nothing is deleted.
      </p>
      <input
        autoFocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why — e.g. the company asked to be removed"
        className="mt-3 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none"
      />
      {error ? <p className="mt-2 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending || !reason.trim()}
          onClick={() =>
            start(async () => {
              const result = await takeDownWebsiteAction(productId, reason.trim());
              if (result.ok) router.push(`/products/${productId}`);
              else setError(result.error);
            })
          }
          className="h-8 rounded-md bg-[var(--color-tone-danger)] px-3 text-xs font-medium text-ink-50 disabled:opacity-50"
        >
          {pending ? "Taking down…" : "Take down"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setReason("");
          }}
          className="h-8 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
        >
          Keep it live
        </button>
      </div>
    </div>
  );
}

/** Lift a takedown's block. Nothing is republished; that is done from Drafts. */
export function AllowCapturing({ productId }: { productId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-xs text-[var(--color-tone-danger)]">{error}</span> : null}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await restoreWebsiteAction(productId);
            if (!result.ok) setError(result.error);
          })
        }
        className="h-8 shrink-0 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100 disabled:opacity-60"
      >
        {pending ? "Allowing…" : "Allow capturing again"}
      </button>
    </span>
  );
}
