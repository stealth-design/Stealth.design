"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A "Filters" button that opens the filter rows beneath it.
 *
 * Open from the start when a filter is on, so a filtered page shows why it
 * is filtered. Choosing a filter is a link to the same page, and this
 * component keeps its state across that navigation, so the panel stays open
 * while you pick.
 */
export function FiltersPanel({
  activeCount,
  children,
}: {
  activeCount: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(activeCount > 0);
  const id = useId();
  return (
    <div className="mb-10 md:mb-14">
      <div className="page-grid">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "col-span-full inline-flex h-9 w-fit items-center gap-2 rounded-[6px] border px-3 text-[15px] tracking-[-0.01em] uppercase transition-colors",
            open
              ? "border-foreground bg-foreground text-background"
              : "border-foreground/80 hover:bg-foreground hover:text-background",
          )}
        >
          Filters
          {activeCount > 0 ? (
            <span className="font-mono text-[11px] tabular-nums opacity-60">
              {activeCount}
            </span>
          ) : null}
          <ChevronDown
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {/*
        Slides open and shut: the row's height animates between 0fr and 1fr
        (a grid track can transition where `height: auto` cannot), and the
        contents fade with it. `inert` keeps a closed panel out of the tab
        order and away from screen readers, as `hidden` did.
      */}
      <div
        id={id}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
