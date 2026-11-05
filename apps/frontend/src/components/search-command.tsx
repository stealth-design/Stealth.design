"use client";

import {
  ArrowRight,
  Boxes,
  Layers,
  LayoutGrid,
  Search,
  Shapes,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const PLACES = [
  { href: "/screens", label: "Screens", icon: LayoutGrid },
  { href: "/websites", label: "Websites", icon: Boxes },
  { href: "/patterns", label: "Patterns", icon: Shapes },
  { href: "/collections", label: "Collections", icon: Layers },
] as const;

/**
 * Search, from anywhere: a field-shaped button in the header that opens a
 * command palette, and ⌘K / Ctrl+K.
 *
 * Searching hands off to the screens listing as a plain URL (`/screens?q=…`),
 * so a result is shareable and the listing stays the one implementation of
 * search. The palette adds jumping between sections, nothing more.
 */
export function SearchCommand({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  const trimmed = query.trim();
  const places = PLACES.filter((place) =>
    place.label.toLowerCase().includes(trimmed.toLowerCase()),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-8 items-center gap-2 rounded-[4px] bg-ink px-2.5 text-ink-foreground transition-opacity hover:opacity-80",
          className,
        )}
      >
        <Search className="size-4 md:hidden" />
        <span className="t-nav hidden md:inline">Search</span>
        <span className="sr-only md:hidden">Search</span>
        <Kbd className="hidden bg-ink-foreground/15 text-ink-foreground lg:inline-flex">
          ⌘K
        </Kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search the library"
        description="Search screens, or jump to a section."
      >
        {/* This version of `CommandDialog` does not create the cmdk root
            itself, so the palette brings its own. */}
        <Command>
          <CommandInput
            placeholder="Search screens, products, patterns…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>Nothing to jump to.</CommandEmpty>
            {trimmed ? (
              <CommandGroup heading="Search">
                <CommandItem
                  value={`search-screens ${trimmed}`}
                  onSelect={() =>
                    go(`/screens?q=${encodeURIComponent(trimmed)}`)
                  }
                >
                  <Search />
                  <span className="flex-1 truncate">
                    Screens matching “{trimmed}”
                  </span>
                  <ArrowRight />
                </CommandItem>
              </CommandGroup>
            ) : null}
            {places.length > 0 ? (
              <CommandGroup heading="Go to">
                {places.map((place) => (
                  <CommandItem
                    key={place.href}
                    value={`go ${place.label}`}
                    onSelect={() => go(place.href)}
                  >
                    <place.icon />
                    {place.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
