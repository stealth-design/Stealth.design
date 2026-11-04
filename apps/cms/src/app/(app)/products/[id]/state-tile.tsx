"use client";

import { useState, useTransition } from "react";
import { Smartphone, X } from "lucide-react";
import clsx from "clsx";
import { discardScreenAction } from "@/lib/actions/products";

export type StateStage = "inbox" | "draft" | "published";

const STAGE: Record<StateStage, { label: string; dot: string }> = {
  inbox: { label: "In inbox", dot: "bg-[var(--color-tone-warning)]" },
  draft: { label: "Draft", dot: "bg-ink-500" },
  published: { label: "Published", dot: "bg-[var(--color-tone-success)]" },
};

/**
 * One state of a page: its screenshot, its name and where it is up to. A
 * capture its owner can still throw away carries a ✕; pressing it asks once,
 * on the tile itself, before anything is removed.
 */
export function StateTile({
  id,
  label,
  stage,
  thumbnail,
  mobile,
  discardable,
}: {
  id: string;
  label: string;
  stage: StateStage;
  thumbnail: string | null;
  mobile: boolean;
  discardable: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const meta = STAGE[stage];

  return (
    <figure className="group relative w-56 shrink-0">
      <div className="relative aspect-[16/10] overflow-hidden rounded-lg border border-ink-200 bg-ink-100">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} alt="" loading="lazy" decoding="async" className="size-full object-cover object-top" />
        ) : (
          <span className="flex size-full items-center justify-center text-[11px] text-ink-400">No image</span>
        )}

        {mobile ? (
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-[10px] text-ink-800">
            <Smartphone aria-hidden className="size-2.5" />
            Mobile
          </span>
        ) : null}

        {discardable && !confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Discard ${label}`}
            title="Discard this capture"
            className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-black/70 text-ink-700 opacity-0 transition-opacity hover:text-ink-950 focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        ) : null}

        {confirming ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-3 text-center">
            <p className="text-xs text-ink-800">{error ?? "Discard this capture?"}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await discardScreenAction(id);
                    if (!result.ok) setError(result.error);
                  })
                }
                className="h-7 rounded-md bg-[var(--color-tone-danger)] px-3 text-xs font-medium text-ink-50 disabled:opacity-60"
              >
                {pending ? "Discarding…" : "Discard"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
                className="h-7 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
              >
                Keep
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <figcaption className="mt-2 flex items-center gap-2 text-xs">
        <span aria-hidden className={clsx("size-1.5 shrink-0 rounded-full", meta.dot)} />
        <span className="min-w-0 flex-1 truncate text-ink-800" title={label}>
          {label}
        </span>
        <span className="shrink-0 text-[11px] text-ink-500">{meta.label}</span>
      </figcaption>
    </figure>
  );
}
