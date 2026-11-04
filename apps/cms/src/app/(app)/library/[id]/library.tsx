"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Search, Smartphone, Star, X } from "lucide-react";
import clsx from "clsx";
import { TagPicker, type TagOption } from "@/components/tag-picker";
import { unpublishAction } from "@/lib/actions/review";
import { SaveBar } from "@/components/save-bar";
import { useScreenDraft } from "@/lib/use-screen-draft";
import { TakeDown } from "@/components/take-down";

export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string | null;
  readonly url: string | null;
  readonly mobile: boolean;
  readonly publicUrl: string | null;
  readonly publishedAgo: string | null;
  readonly featured: boolean;
  readonly publishedBy: string | null;
  readonly gridUrl: string | null;
  readonly imageUrl: string | null;
  readonly tags: readonly { readonly assignmentId: string; readonly termId: string; readonly name: string }[];
}

type Permissions = { unpublish: boolean; feature: boolean; rename: boolean; tag: boolean; takeDown: boolean };

/**
 * One website's live screens: a grid to scan, a search and a tag filter to
 * narrow it, and a panel to open any one of them in.
 */
export function Library({
  product,
  total,
  query,
  activeTag,
  featuredOnly,
  featuredCount,
  facets,
  tags,
  permissions,
  items,
}: {
  product: { readonly id: string; readonly name: string; readonly domain: string | null };
  total: number;
  query: string;
  activeTag: string | null;
  featuredOnly: boolean;
  featuredCount: number;
  facets: readonly { termId: string; name: string; count: number }[];
  tags: readonly TagOption[];
  permissions: Permissions;
  items: readonly LibraryEntry[];
}) {
  const router = useRouter();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => items.filter((item) => !removed.has(item.id)), [items, removed]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const open = visible.find((item) => item.id === openId) ?? null;

  const base = `/library/${product.id}`;
  const hrefWith = (next: { q?: string; tag?: string | null; featured?: boolean }) => {
    const params = new URLSearchParams();
    const q = next.q ?? query;
    const tag = next.tag === undefined ? activeTag : next.tag;
    const featured = next.featured === undefined ? featuredOnly : next.featured;
    if (q) params.set("q", q);
    if (tag) params.set("tag", tag);
    if (featured) params.set("featured", "1");
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const step = useCallback(
    (delta: number) => {
      const index = visible.findIndex((item) => item.id === openId);
      const next = visible[index + delta];
      if (next) setOpenId(next.id);
    },
    [visible, openId],
  );

  const filtered = Boolean(query || activeTag || featuredOnly);
  const shown = Math.max(0, total - removed.size);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 md:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-5 pt-6 md:pt-8">
        <div className="min-w-0">
          <Link
            href="/library"
            className="inline-flex items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink-900"
          >
            <ArrowLeft aria-hidden className="size-3" />
            Library
          </Link>
          <h1 className="mt-1 flex items-baseline gap-2 text-lg font-medium tracking-[-0.01em] text-ink-900">
            {product.name}
            {product.domain ? <span className="font-mono text-xs font-normal text-ink-500">{product.domain}</span> : null}
          </h1>
          <p className="mt-1 text-[13px] text-ink-500">
            {shown} {shown === 1 ? "screen" : "screens"} {filtered ? "match" : "live"}
          </p>
        </div>
        <form action={base} className="flex h-9 w-full items-center gap-2 rounded-lg border border-ink-200 bg-surface px-3 sm:w-72">
          <Search aria-hidden className="size-3.5 text-ink-500" />
          <input
            name="q"
            defaultValue={query}
            placeholder="Search by name"
            aria-label="Search screens by name"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus-visible:outline-none"
          />
          {activeTag ? <input type="hidden" name="tag" value={activeTag} /> : null}
        </form>
        {permissions.takeDown && !filtered ? (
          <div className="flex w-full justify-end">
            <TakeDown productId={product.id} name={product.name} live={shown} />
          </div>
        ) : null}
      </header>

      {facets.length > 0 || featuredCount > 0 ? (
        <nav aria-label="Filter by tag" className="-mx-1 mb-5 flex flex-wrap gap-1.5">
          <FacetLink href={hrefWith({ tag: null, featured: false })} active={!activeTag && !featuredOnly} label="All" />
          <FacetLink
            href={hrefWith({ featured: !featuredOnly })}
            active={featuredOnly}
            label="Featured"
            count={featuredCount}
          />
          <span aria-hidden className="mx-1 w-px self-stretch bg-ink-200" />
          {facets.map((facet) => (
            <FacetLink
              key={facet.termId}
              href={hrefWith({ tag: facet.termId === activeTag ? null : facet.termId })}
              active={facet.termId === activeTag}
              label={facet.name}
              count={facet.count}
            />
          ))}
        </nav>
      ) : null}

      {notice ? <p className="mb-4 text-xs text-ink-600">{notice}</p> : null}

      {visible.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-ink-200 text-center">
          <p className="text-[13px] text-ink-600">{filtered ? "No screens match." : `Nothing from ${product.name} is live.`}</p>
          {filtered ? (
            <Link href={base} className="text-xs text-ink-700 underline hover:text-ink-900">
              Clear the filter
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setOpenId(item.id)}
                className="group block w-full overflow-hidden rounded-xl border border-ink-200 bg-surface text-left transition-colors hover:border-ink-300"
              >
                <span className="relative block aspect-[16/10] overflow-hidden border-b border-ink-200 bg-ink-100">
                  {item.gridUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.gridUrl}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.015]"
                    />
                  ) : null}
                  {item.featured ? (
                    <span className="absolute right-2 top-2 flex items-center gap-1 rounded-[4px] bg-black/75 px-1.5 py-0.5 text-[10px] text-ink-900">
                      <Star aria-hidden className="size-2.5 fill-current" /> Featured
                    </span>
                  ) : null}
                  {item.mobile ? (
                    <span className="absolute left-2 top-2 flex items-center gap-1 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-[10px] text-ink-800">
                      <Smartphone aria-hidden className="size-2.5" /> Mobile
                    </span>
                  ) : null}
                </span>
                <span className="block p-3">
                  <span className="block truncate text-[13px] text-ink-900">
                    {item.name}
                    {item.stateLabel ? <span className="text-ink-500"> — {item.stateLabel}</span> : null}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[11px] text-ink-500">
                    <span className="min-w-0 flex-1 truncate">{item.tags.map((tag) => tag.name).join(" · ") || "No tags"}</span>
                    {item.publishedAgo ? <span className="shrink-0">{item.publishedAgo}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <Panel
          key={open.id}
          entry={open}
          tags={tags}
          permissions={permissions}
          onClose={() => setOpenId(null)}
          onStep={step}
          onUnpublished={(entry) => {
            setRemoved((previous) => new Set(previous).add(entry.id));
            setOpenId(null);
            setNotice(`${entry.name} is off the public site and back in Drafts.`);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function FacetLink({ href, active, label, count }: { href: string; active: boolean; label: string; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={clsx(
        "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
        active ? "border-ink-500 bg-ink-200 text-ink-900" : "border-ink-200 text-ink-600 hover:border-ink-300 hover:text-ink-900",
      )}
    >
      {label}
      {count !== undefined ? <span className="font-mono text-[11px] text-ink-400">{count}</span> : null}
    </Link>
  );
}

/** One live screen, opened: large, editable, and with a way off the site. */
function Panel({
  entry,
  tags,
  permissions,
  onClose,
  onStep,
  onUnpublished,
}: {
  entry: LibraryEntry;
  tags: readonly TagOption[];
  permissions: Permissions;
  onClose: () => void;
  onStep: (delta: number) => void;
  onUnpublished: (entry: LibraryEntry) => void;
}) {
  const draft = useScreenDraft(entry);
  const [unpublishing, setUnpublishing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Leaving the panel — closing it or moving to the next screen — asks
  // first when there is something unsaved.
  const close = useCallback(() => {
    if (draft.confirmLeave()) onClose();
  }, [draft, onClose]);
  const move = useCallback(
    (delta: number) => {
      if (draft.confirmLeave()) onStep(delta);
    },
    [draft, onStep],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") close();
      if (target?.closest("input, textarea, select")) return;
      if (event.key === "ArrowRight") move(1);
      if (event.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, move]);

  const unpublish = () =>
    start(async () => {
      const result = await unpublishAction(entry.id, reason.trim());
      if (result.ok) onUnpublished(entry);
      else setError(result.error ?? "That couldn't be unpublished.");
    });

  const canEdit = permissions.rename || permissions.tag || permissions.feature;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default bg-black/60" onClick={close} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={entry.name}
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-ink-200 bg-surface shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-ink-200 px-5 py-3">
          <p className="min-w-0 flex-1 truncate text-[13px] text-ink-900">{entry.name}</p>
          <span className="hidden text-[11px] text-ink-500 sm:inline">← → to move</span>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
          {/* The grid's smaller image, already loaded, holds the space while
              the large one arrives — so opening a screen never flashes blank. */}
          <div
            className="overflow-hidden rounded-xl border border-ink-200 bg-ink-100 bg-cover bg-top"
            style={entry.gridUrl ? { backgroundImage: `url(${entry.gridUrl})` } : undefined}
          >
            {entry.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={entry.imageUrl}
                alt={entry.name}
                className={clsx("mx-auto block min-h-40 w-full", entry.mobile && "max-w-xs")}
              />
            ) : (
              <div className="flex aspect-[16/10] items-center justify-center text-xs text-ink-500">No image</div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            <span className="flex items-center gap-1.5 text-ink-800">
              <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-tone-success)]" />
              Live
            </span>
            {entry.publishedAgo ? (
              <span>
                Published {entry.publishedAgo}
                {entry.publishedBy ? ` by ${entry.publishedBy}` : ""}
              </span>
            ) : null}
            {entry.url ? (
              <a href={entry.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 font-mono hover:text-ink-900">
                {shortUrl(entry.url)}
                <ArrowUpRight aria-hidden className="size-3" />
              </a>
            ) : null}
          </div>

          <div className="grid grid-cols-[1fr_9rem] gap-2">
            <label className="block min-w-0">
              <span className="text-xs text-ink-600">Name</span>
              <input
                value={draft.values.name}
                disabled={!permissions.rename}
                onChange={(event) => draft.set("name", event.target.value)}
                className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-xs text-ink-600">
                State <span className="text-ink-400">optional</span>
              </span>
              <input
                value={draft.values.stateLabel}
                disabled={!permissions.rename}
                onChange={(event) => draft.set("stateLabel", event.target.value)}
                placeholder="Menu open"
                className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none disabled:opacity-60"
              />
            </label>
          </div>

          <div>
            <p className="text-xs text-ink-600">Tags</p>
            <div className="mt-2">
              <TagPicker
                options={tags}
                selected={draft.values.tagIds}
                onChange={(next) => draft.set("tagIds", next)}
                disabled={!permissions.tag}
              />
            </div>
          </div>

          {permissions.feature ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-200 p-3 hover:border-ink-300">
              <input
                type="checkbox"
                checked={draft.values.featured}
                onChange={(event) => draft.set("featured", event.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-[13px] text-ink-900">Featured</span>
                <span className="mt-0.5 block text-xs text-ink-500">
                  Shown first, in the featured section of this website&apos;s page.
                </span>
              </span>
            </label>
          ) : null}

          {error ? <p className="text-xs text-[var(--color-tone-danger)]">{error}</p> : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-ink-200 pt-4">
            {entry.publicUrl ? (
              <a
                href={entry.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 items-center gap-1.5 rounded-lg border border-ink-300 px-3 text-[13px] text-ink-800 transition-colors hover:bg-ink-100 hover:text-ink-900"
              >
                View on site
                <ArrowUpRight aria-hidden className="size-3.5" />
              </a>
            ) : null}
            {permissions.unpublish && !unpublishing ? (
              <button
                type="button"
                onClick={() => setUnpublishing(true)}
                className="h-9 rounded-lg px-3 text-[13px] text-ink-500 transition-colors hover:text-[var(--color-tone-danger)]"
              >
                Unpublish
              </button>
            ) : null}
          </div>

          {unpublishing ? (
            <div className="rounded-xl border border-ink-200 p-4">
              <p className="text-[13px] text-ink-900">Take this off the public site?</p>
              <p className="mt-1 text-xs text-ink-500">It goes back to Drafts, so nothing is lost. Say why, for the record.</p>
              <input
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && reason.trim()) unpublish();
                }}
                placeholder="Wrong tag, low quality, duplicate…"
                className="mt-3 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={pending || !reason.trim()}
                  onClick={unpublish}
                  className="h-8 rounded-md bg-[var(--color-tone-danger)] px-3 text-xs font-medium text-ink-50 disabled:opacity-50"
                >
                  {pending ? "Unpublishing…" : "Unpublish"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUnpublishing(false);
                    setReason("");
                  }}
                  className="h-8 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
                >
                  Keep it live
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Pinned to the bottom of the panel, so Save is always in reach. */}
        {canEdit ? (
          <SaveBar
            dirty={draft.dirty}
            saving={draft.saving}
            error={draft.error}
            onSave={() => void draft.save()}
            onDiscard={draft.discard}
            className="border-t border-ink-200 bg-surface px-5 py-3"
          />
        ) : null}
      </aside>
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "/" : parsed.pathname}`;
  } catch {
    return url;
  }
}
