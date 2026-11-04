"use client";

import { useMemo, useState, useTransition } from "react";
import { ChevronRight, MoreHorizontal, Plus, Search } from "lucide-react";
import clsx from "clsx";
import { TAXONOMY_KINDS, TAXONOMY_KIND_META, type TaxonomyKind } from "@uxd/types";
import { createTagAction, deleteTagAction, mergeTagsAction, renameTagAction } from "@/lib/actions/tags";

export interface ManagedTag {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly depth: number;
  readonly path: string;
  readonly usage: number;
}

type Permissions = { create: boolean; update: boolean; remove: boolean };
type Group = "industry" | "types";

/** Industry is its own filter; every other kind is a design type. */
const GROUP_KINDS: Record<Group, readonly TaxonomyKind[]> = {
  industry: ["industry"],
  types: TAXONOMY_KINDS.filter((kind) => kind !== "industry"),
};

/**
 * The vocabulary, in the two groups the public site filters by. A search
 * across both, every tag with how many screens carry it, and — for admins —
 * add, rename, merge and delete in place.
 */
export function TagManager({ tags, permissions }: { tags: readonly ManagedTag[]; permissions: Permissions }) {
  const [group, setGroup] = useState<Group>("types");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "danger" } | null>(null);

  const q = query.trim().toLowerCase();
  const matches = (tag: ManagedTag) =>
    !q || tag.name.toLowerCase().includes(q) || tag.aliases.some((alias) => alias.toLowerCase().includes(q));

  const counts = useMemo(
    () => ({
      industry: tags.filter((tag) => GROUP_KINDS.industry.includes(tag.kind as TaxonomyKind)).length,
      types: tags.filter((tag) => GROUP_KINDS.types.includes(tag.kind as TaxonomyKind)).length,
    }),
    [tags],
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Filter group" className="flex items-center gap-1">
          {(["types", "industry"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setGroup(value)}
              aria-current={group === value ? "true" : undefined}
              className={clsx(
                "flex h-8 items-center gap-2 rounded-md px-3 text-xs transition-colors",
                group === value ? "bg-ink-200 text-ink-900" : "text-ink-500 hover:bg-ink-100 hover:text-ink-900",
              )}
            >
              {value === "types" ? "Types" : "Industry"}
              <span className="font-mono text-[11px] text-ink-400">{counts[value]}</span>
            </button>
          ))}
        </nav>
        <label className="ml-auto flex h-9 w-full items-center gap-2 rounded-lg border border-ink-200 bg-surface px-3 sm:w-72">
          <Search aria-hidden className="size-3.5 text-ink-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a tag"
            aria-label="Find a tag"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus-visible:outline-none"
          />
        </label>
      </div>

      <p className="mt-3 text-xs text-ink-500">
        {group === "types"
          ? "Everything about the design: sections, patterns, components, styles."
          : "What the company does. Used to filter websites by sector."}
      </p>

      {notice ? (
        <p
          className={clsx(
            "mt-3 text-xs",
            notice.tone === "danger" ? "text-[var(--color-tone-danger)]" : "text-ink-600",
          )}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="mt-6 space-y-8">
        {GROUP_KINDS[group].map((kind) => {
          const inKind = tags.filter((tag) => tag.kind === kind);
          const shown = inKind.filter(matches);
          if (q && shown.length === 0) return null;
          return (
            <KindSection
              key={kind}
              kind={kind}
              tags={shown}
              allTags={tags}
              total={inKind.length}
              showHeading={group === "types"}
              permissions={permissions}
              onNotice={setNotice}
              searching={Boolean(q)}
            />
          );
        })}
      </div>
    </div>
  );
}

function KindSection({
  kind,
  tags,
  allTags,
  total,
  showHeading,
  permissions,
  onNotice,
  searching,
}: {
  kind: TaxonomyKind;
  tags: readonly ManagedTag[];
  allTags: readonly ManagedTag[];
  total: number;
  showHeading: boolean;
  permissions: Permissions;
  onNotice: (notice: { text: string; tone: "info" | "danger" } | null) => void;
  searching: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const meta = TAXONOMY_KIND_META[kind];

  const create = () =>
    start(async () => {
      const result = await createTagAction(kind, name);
      if (result.ok) {
        onNotice({ text: `Added "${name.trim()}" to ${meta.plural}.`, tone: "info" });
        setName("");
        setAdding(false);
      } else onNotice({ text: result.error ?? "That tag couldn't be created.", tone: "danger" });
    });

  return (
    <section aria-label={meta.plural}>
      <div className="flex items-baseline justify-between gap-3 border-b border-ink-200 pb-2">
        {showHeading ? (
          <h2 className="flex items-baseline gap-2 text-[13px] text-ink-900">
            {meta.plural}
            <span className="font-mono text-[11px] text-ink-400">{total}</span>
          </h2>
        ) : (
          <span />
        )}
        {permissions.create && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-ink-600 hover:text-ink-900"
          >
            <Plus aria-hidden className="size-3" />
            Add tag
          </button>
        ) : null}
      </div>

      {adding ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create();
          }}
          className="mt-3 flex gap-2"
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
            placeholder={`New ${meta.label.toLowerCase()}`}
            className="h-8 min-w-0 flex-1 rounded-md border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none sm:max-w-xs"
          />
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="h-8 rounded-md bg-ink-900 px-3 text-xs font-medium text-ink-50 disabled:opacity-40"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="h-8 rounded-md px-3 text-xs text-ink-600 hover:bg-ink-100"
          >
            Cancel
          </button>
        </form>
      ) : null}

      {tags.length === 0 ? (
        <p className="mt-3 text-xs text-ink-500">No tags here yet.</p>
      ) : (
        // A tag and its sub-tags stay together in one block, so "Log in" is
        // always read under "Auth" — columns would otherwise split them.
        <div className="mt-1 gap-x-6 sm:columns-2 xl:columns-3">
          {families(tags).map((family) => (
            <Family
              key={family[0]!.id}
              family={family}
              allTags={allTags}
              permissions={permissions}
              onNotice={onNotice}
              searching={searching}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A top-level tag and its sub-tags. Closed by default, so a long vocabulary
 * reads as its headings; opened by its arrow, or by itself while searching.
 */
function Family({
  family,
  allTags,
  permissions,
  onNotice,
  searching,
}: {
  family: readonly ManagedTag[];
  allTags: readonly ManagedTag[];
  permissions: Permissions;
  onNotice: (notice: { text: string; tone: "info" | "danger" } | null) => void;
  searching: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [root, ...children] = family;
  const expanded = open || searching;
  return (
    <ul className="break-inside-avoid">
      <TagRow
        tag={root!}
        allTags={allTags}
        permissions={permissions}
        onNotice={onNotice}
        childCount={children.length}
        expanded={expanded}
        onToggle={children.length > 0 ? () => setOpen((value) => !value) : undefined}
      />
      {expanded
        ? children.map((tag) => (
            <TagRow key={tag.id} tag={tag} allTags={allTags} permissions={permissions} onNotice={onNotice} />
          ))
        : null}
    </ul>
  );
}

function TagRow({
  tag,
  allTags,
  permissions,
  onNotice,
  childCount = 0,
  expanded = false,
  onToggle,
}: {
  tag: ManagedTag;
  allTags: readonly ManagedTag[];
  permissions: Permissions;
  onNotice: (notice: { text: string; tone: "info" | "danger" } | null) => void;
  childCount?: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "menu" | "rename" | "merge" | "delete">("idle");
  const [name, setName] = useState(tag.name);
  const [mergeQuery, setMergeQuery] = useState("");
  const [pending, start] = useTransition();
  const canEdit = permissions.update || permissions.remove;

  const run = (task: () => Promise<{ ok: boolean; error: string | null; message?: string }>, success: string) =>
    start(async () => {
      const result = await task();
      setMode("idle");
      onNotice(
        result.ok
          ? { text: result.message ? `${tag.name}: ${result.message}` : success, tone: "info" }
          : { text: result.error ?? "That didn't work.", tone: "danger" },
      );
    });

  const mergeTargets = useMemo(() => {
    const q = mergeQuery.trim().toLowerCase();
    return allTags
      .filter((other) => other.id !== tag.id && (!q || other.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.kind === tag.kind) - Number(a.kind === tag.kind) || b.usage - a.usage)
      .slice(0, 8);
  }, [allTags, mergeQuery, tag]);

  return (
    <li className="relative border-b border-ink-200/60 py-2">
      {mode === "rename" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(() => renameTagAction(tag.id, name), `Renamed to "${name.trim()}".`);
          }}
          className="flex gap-2"
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setMode("idle")}
            className="h-7 min-w-0 flex-1 rounded-md border border-ink-200 bg-ink-50 px-2 text-[13px] text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none"
          />
          <button type="submit" disabled={pending} className="h-7 rounded-md bg-ink-900 px-2.5 text-xs text-ink-50">
            Save
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-2" style={{ paddingLeft: `${Math.min(tag.depth, 3) * 16}px` }}>
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} ${childCount} sub-tags of ${tag.name}`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <ChevronRight
                aria-hidden
                className={clsx("size-3.5 shrink-0 text-ink-500 transition-transform", expanded && "rotate-90")}
              />
              <span className="truncate text-[13px] text-ink-900" title={tag.aliases.join(", ") || undefined}>
                {tag.name}
              </span>
              <span className="shrink-0 rounded bg-ink-100 px-1.5 text-[10px] text-ink-500">{childCount}</span>
            </button>
          ) : (
            <span
              className={clsx("min-w-0 flex-1 truncate pl-5 text-[13px]", tag.depth > 0 ? "text-ink-700" : "text-ink-900")}
              title={tag.aliases.join(", ") || undefined}
            >
              {tag.name}
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px] text-ink-400" title="Screens with this tag">
            {tag.usage}
          </span>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setMode(mode === "menu" ? "idle" : "menu")}
              aria-label={`Options for ${tag.name}`}
              className="flex size-6 shrink-0 items-center justify-center rounded text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            >
              <MoreHorizontal aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </div>
      )}

      {mode === "menu" ? (
        <div className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-lg border border-ink-200 bg-surface py-1 shadow-2xl shadow-black/60">
          {permissions.update ? (
            <>
              <MenuItem onClick={() => setMode("rename")}>Rename</MenuItem>
              <MenuItem onClick={() => setMode("merge")}>Merge into…</MenuItem>
            </>
          ) : null}
          {permissions.remove ? (
            <MenuItem danger onClick={() => setMode("delete")}>
              Delete
            </MenuItem>
          ) : null}
        </div>
      ) : null}

      {mode === "merge" ? (
        <div className="mt-2 rounded-lg border border-ink-200 bg-surface p-2">
          <p className="px-1 text-[11px] text-ink-500">
            Move every screen tagged &ldquo;{tag.name}&rdquo; to:
          </p>
          <input
            autoFocus
            value={mergeQuery}
            onChange={(event) => setMergeQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setMode("idle")}
            placeholder="Find the tag to keep"
            className="mt-1.5 h-7 w-full rounded-md border border-ink-200 bg-ink-50 px-2 text-xs text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none"
          />
          <ul className="mt-1">
            {mergeTargets.map((target) => (
              <li key={target.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() => mergeTagsAction(tag.id, target.id), `Merged "${tag.name}" into "${target.name}".`)
                  }
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs text-ink-800 hover:bg-ink-100"
                >
                  <span className="min-w-0 flex-1 truncate">{target.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-500">
                    {TAXONOMY_KIND_META[target.kind as TaxonomyKind]?.label ?? target.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setMode("idle")} className="mt-1 px-1.5 text-[11px] text-ink-500 hover:text-ink-900">
            Cancel
          </button>
        </div>
      ) : null}

      {mode === "delete" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-600">
            {tag.usage > 0
              ? `Delete and take it off ${tag.usage} ${tag.usage === 1 ? "screen" : "screens"}?`
              : "Delete this tag?"}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => deleteTagAction(tag.id), `Deleted "${tag.name}".`)}
            className="h-6 rounded-md bg-[var(--color-tone-danger)] px-2.5 text-[11px] font-medium text-ink-50 disabled:opacity-60"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            className="h-6 rounded-md border border-ink-300 px-2.5 text-[11px] text-ink-800 hover:bg-ink-100"
          >
            Keep
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Group tags (already ordered by path) into families: each top-level tag
 * followed by everything beneath it. A sub-tag whose parent was filtered out
 * by the search starts a family of its own.
 */
function families(tags: readonly ManagedTag[]): ManagedTag[][] {
  const out: ManagedTag[][] = [];
  for (const tag of tags) {
    const current = out.at(-1);
    if (current && tag.path.startsWith(`${current[0]!.path}/`)) current.push(tag);
    else out.push([tag]);
  }
  return out;
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "block w-full px-3 py-1.5 text-left text-xs hover:bg-ink-100",
        danger ? "text-[var(--color-tone-danger)]" : "text-ink-800",
      )}
    >
      {children}
    </button>
  );
}
