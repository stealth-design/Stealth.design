"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import clsx from "clsx";
import { TAXONOMY_KIND_META, type TaxonomyKind } from "@uxd/types";

export interface TagOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly usageCount: number;
  readonly aliases: readonly string[];
}

/**
 * Choosing tags from the taxonomy.
 *
 * The chosen tags sit as chips; "Add tag" opens a search over every active
 * term, grouped by what kind of tag it is. With nothing typed it leads with
 * the most-used terms, so the tags a team reaches for every day are one click
 * away. Nothing here knows any term by name — the list is whatever the
 * taxonomy holds.
 */
export function TagPicker({
  options,
  selected,
  onChange,
  disabled,
  size = "md",
  align = "left",
}: {
  options: readonly TagOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const chosen = selected.map((id) => byId.get(id)).filter((option): option is TagOption => Boolean(option));

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      {chosen.map((tag) => (
        <span
          key={tag.id}
          className={clsx(
            "flex items-center gap-1 rounded-md border border-ink-200 bg-ink-100 text-ink-800",
            size === "sm" ? "h-6 pl-2 pr-1 text-[11px]" : "h-7 pl-2.5 pr-1 text-xs",
          )}
        >
          {tag.name}
          <button
            type="button"
            disabled={disabled}
            onClick={() => toggle(tag.id)}
            aria-label={`Remove ${tag.name}`}
            className="flex size-4 items-center justify-center rounded text-ink-500 hover:bg-ink-200 hover:text-ink-900"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}

      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={clsx(
          "flex items-center gap-1 rounded-md border border-dashed border-ink-300 text-ink-600 transition-colors hover:border-ink-400 hover:text-ink-900 disabled:opacity-50",
          size === "sm" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
        )}
      >
        <Plus aria-hidden className="size-3" />
        {chosen.length === 0 ? "Add tags" : "Add"}
      </button>

      {open ? (
        <TagSearch
          options={options}
          selected={selected}
          onToggle={toggle}
          onClose={() => setOpen(false)}
          align={align}
        />
      ) : null}
    </div>
  );
}

function TagSearch({
  options,
  selected,
  onToggle,
  onClose,
  align,
}: {
  options: readonly TagOption[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  onClose: () => void;
  align: "left" | "right";
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const popular = [...options]
        .filter((option) => option.usageCount > 0)
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, 8);
      const rest = groupByKind(options);
      return popular.length > 0 ? [{ label: "Most used", items: popular }, ...rest] : rest;
    }
    const matches = options.filter(
      (option) =>
        option.name.toLowerCase().includes(q) || option.aliases.some((alias) => alias.toLowerCase().includes(q)),
    );
    // Names that start with what was typed come first: "her" should find
    // "Hero section" before "Other".
    matches.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || b.usageCount - a.usageCount || a.name.localeCompare(b.name);
    });
    return groupByKind(matches);
  }, [options, query]);

  const flat = groups.flatMap((group) => group.items);

  return (
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={onClose} />
      <div
        className={clsx(
          "absolute top-full z-40 mt-2 w-72 overflow-hidden rounded-xl border border-ink-200 bg-surface shadow-2xl shadow-black/60",
          align === "right" ? "right-0" : "left-0",
        )}
      >
        <label className="flex items-center gap-2 border-b border-ink-200 px-3">
          <Search aria-hidden className="size-3.5 text-ink-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Close the search only — not a dialog the picker sits in.
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((value) => Math.min(flat.length - 1, value + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const hit = flat[cursor];
                if (hit) onToggle(hit.id);
              }
            }}
            placeholder="Search tags"
            aria-label="Search tags"
            className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus-visible:outline-none"
          />
        </label>
        <div className="max-h-72 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-ink-500">No tag called that.</p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="py-1">
                <p className="px-3 pb-1 pt-1.5 text-[11px] text-ink-500">{group.label}</p>
                {group.items.map((option) => {
                  const index = flat.indexOf(option);
                  const isSelected = selected.includes(option.id);
                  return (
                    <button
                      key={`${group.label}-${option.id}`}
                      type="button"
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => onToggle(option.id)}
                      className={clsx(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                        index === cursor ? "bg-ink-100 text-ink-900" : "text-ink-700",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {isSelected ? <Check aria-hidden className="size-3.5 text-ink-900" /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function groupByKind(options: readonly TagOption[]): { label: string; items: TagOption[] }[] {
  const groups = new Map<string, TagOption[]>();
  for (const option of options) {
    const list = groups.get(option.kind) ?? [];
    list.push(option);
    groups.set(option.kind, list);
  }
  return [...groups.entries()].map(([kind, items]) => ({
    label: TAXONOMY_KIND_META[kind as TaxonomyKind]?.plural ?? kind,
    items,
  }));
}
