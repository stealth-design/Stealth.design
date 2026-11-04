"use client";

import { EmptyState } from "@/components/gallery";

/** A failed page load. Usually the API being briefly unavailable. */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState
      title="Something went wrong"
      action={
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-9 items-center rounded-md bg-lit px-3.5 text-[13px] font-medium text-background hover:opacity-85"
        >
          Try again
        </button>
      }
    >
      This page could not be loaded. It is usually temporary.
    </EmptyState>
  );
}
