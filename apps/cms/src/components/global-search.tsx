"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";
import clsx from "clsx";
import { NAV_ITEMS } from "@/lib/navigation";
import { searchAction, type SearchResults } from "@/lib/actions/search";

const EMPTY: SearchResults = { groups: [] };

/**
 * Global search.
 *
 * Opens on Cmd/Ctrl-K from anywhere, searches content, sources, media,
 * taxonomy, jobs and collections in one pass, and resolves a pasted URL to the
 * page it belongs to — an operator is often working from a URL somebody sent
 * them, and "paste it and go" is the shortest path there is. With nothing
 * typed, it lists the sections, so it doubles as a way to move around.
 *
 * ↑ ↓ to move, ↵ to open, Esc to close.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults(EMPTY);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setResults(EMPTY);
      return;
    }
    // Debounced, because this runs a handful of database queries and an
    // operator types faster than any of them return.
    debounce.current = setTimeout(() => {
      startTransition(async () => {
        setResults(await searchAction(query));
      });
    }, 180);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  const searching = query.trim().length >= 2;
  const groups = useMemo(
    () =>
      searching
        ? results.groups.filter((group) => group.items.length > 0)
        : [{ label: "Go to", items: NAV_ITEMS.map((item) => ({ label: item.label, href: item.href, hint: undefined })) }],
    [results, searching],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => setCursor(0), [groups]);

  const go = (href: string) => {
    close();
    router.push(href);
  };

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(value + 1, flat.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      const target = flat[cursor];
      if (target) {
        event.preventDefault();
        go(target.href);
      }
    }
  };

  let position = -1;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-ink-200 bg-surface px-2 text-[13px] text-ink-500 transition-colors hover:border-ink-300 hover:text-ink-800"
      >
        <Search aria-hidden className="size-3.5" />
        <span className="flex-1 text-left">Search</span>
        <span aria-hidden className="flex items-center gap-0.5">
          <kbd className="flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-ink-300 bg-ink-100 px-1 font-sans text-[12px] leading-none text-ink-600">
            ⌘
          </kbd>
          <kbd className="flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-ink-300 bg-ink-100 px-1 font-sans text-[11px] leading-none text-ink-600">
            K
          </kbd>
        </span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
          <button type="button" aria-label="Close search" className="absolute inset-0 cursor-default bg-black/60" onClick={close} />
          <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-ink-200 bg-surface shadow-2xl shadow-black/60">
            <div className="flex items-center gap-2.5 border-b border-ink-200 px-3.5">
              <Search aria-hidden className="size-4 shrink-0 text-ink-500" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                placeholder="Search everything, or paste a URL"
                aria-label="Search everything"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKey}
                className="h-12 w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400 focus-visible:outline-none"
              />
              {isPending ? <span className="text-[11px] text-ink-400">Searching…</span> : null}
            </div>

            <div className="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5">
              {flat.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-[13px] text-ink-500">
                  {isPending ? "Searching…" : `Nothing matched “${query.trim()}”.`}
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.label} className="mb-1 last:mb-0">
                    <p className="px-2.5 pb-1 pt-2 text-[11px] text-ink-400">{group.label}</p>
                    <ul>
                      {group.items.map((item) => {
                        position += 1;
                        const index = position;
                        const active = index === cursor;
                        return (
                          <li key={`${group.label}-${item.href}`}>
                            <button
                              type="button"
                              onMouseMove={() => setCursor(index)}
                              onClick={() => go(item.href)}
                              className={clsx(
                                "flex h-9 w-full items-center justify-between gap-3 rounded-md px-2.5 text-left",
                                active ? "bg-ink-100 text-ink-900" : "text-ink-700",
                              )}
                            >
                              <span className="min-w-0 truncate text-[13px]">{item.label}</span>
                              {item.hint ? (
                                <span className="shrink-0 text-[11px] text-ink-500">{item.hint}</span>
                              ) : active ? (
                                <CornerDownLeft aria-hidden className="size-3.5 shrink-0 text-ink-400" />
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
