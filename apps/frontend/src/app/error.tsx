"use client";

import { EmptyState } from "@/components/gallery";

/** A failed page load. Usually the API being briefly unavailable. */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="pt-24">
      <EmptyState
        title="Something went wrong"
        action={
          <button
            type="button"
            onClick={reset}
            className="t-nav inline-flex h-11 items-center rounded-[4px] bg-ink px-4 text-ink-foreground hover:opacity-80"
          >
            Try again
          </button>
        }
      >
        This page didn&apos;t load. Please try again in a moment.
      </EmptyState>
    </div>
  );
}
