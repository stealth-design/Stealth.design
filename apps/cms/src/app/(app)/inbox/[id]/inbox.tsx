"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Check, Inbox as InboxIcon, Smartphone, Sparkles, Trash2 } from "lucide-react";
import clsx from "clsx";
import { TagPicker, type TagOption } from "@/components/tag-picker";
import { decideAction, publishAction } from "@/lib/actions/review";
import { LocalTime } from "@/components/local-time";
import { SaveBar } from "@/components/save-bar";
import { useScreenDraft } from "@/lib/use-screen-draft";
import { WebsiteProfile, type WebsiteProfileData } from "./website-profile";
import { discardScreenAction } from "@/lib/actions/products";

type Stage = "review" | "draft";

export interface InboxEntry {
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string | null;
  readonly url: string | null;
  readonly mobile: boolean;
  readonly productId: string | null;
  readonly productName: string;
  readonly capturedBy: string | null;
  readonly capturedAgo: string | null;
  readonly capturedAt: string | null;
  readonly thumbnailUrl: string | null;
  readonly imageUrl: string | null;
  readonly discardable: boolean;
  readonly tags: readonly { readonly assignmentId: string; readonly termId: string }[];
  readonly suggestions: readonly { readonly assignmentId: string; readonly termId: string; readonly name: string }[];
}

/**
 * The Inbox, worked one capture at a time.
 *
 * The list on the left is the queue; the right is the capture being decided,
 * shown large, with its name and tags editable in place. Deciding moves
 * straight on to the next one, and the keys do the same as the buttons —
 * P publish, D keep as draft, ↑ ↓ to move — so a hundred captures is a
 * hundred quick looks, not a hundred page loads.
 */
export function Inbox({
  stage,
  product,
  profile,
  total,
  counts,
  tags,
  permissions,
  items,
}: {
  stage: Stage;
  product: { readonly id: string; readonly name: string; readonly domain: string | null };
  profile: WebsiteProfileData;
  total: number;
  counts: Record<Stage, number>;
  tags: readonly TagOption[];
  permissions: { decide: boolean; publish: boolean; rename: boolean; tag: boolean };
  items: readonly InboxEntry[];
}) {
  const router = useRouter();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => items.filter((item) => !removed.has(item.id)), [items, removed]);
  const [selectedId, setSelectedId] = useState<string | null>(visible[0]?.id ?? null);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [pending, start] = useTransition();
  // The open capture's unsaved edits: saved before a decision, and asked
  // about before moving to another capture.
  const guard = useRef<{ save: () => Promise<boolean>; confirmLeave: () => boolean } | null>(null);
  const select = useCallback((id: string) => {
    if (guard.current && !guard.current.confirmLeave()) return;
    setSelectedId(id);
  }, []);

  // Keep a valid selection as items come and go.
  const selectedIndex = visible.findIndex((item) => item.id === selectedId);
  const selected = selectedIndex >= 0 ? visible[selectedIndex] : visible[0];
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const hrefFor = (next: Stage) => (next === "review" ? `/inbox/${product.id}` : `/inbox/${product.id}?stage=${next}`);

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const index = Math.max(0, Math.min(visible.length - 1, (selectedIndex < 0 ? 0 : selectedIndex) + delta));
      select(visible[index]!.id);
    },
    [visible, selectedIndex, select],
  );

  /** Run a decision, take the capture off the list, and move on. */
  const decide = useCallback(
    (
      entry: InboxEntry,
      run: () => Promise<{
        ok: boolean;
        error: string | null;
        issues?: readonly { message: string }[];
      }>,
      done: string,
      saveFirst = true,
    ) => {
      setNotice(null);
      start(async () => {
        // Publishing what is on screen means publishing the edits too.
        if (saveFirst && guard.current && !(await guard.current.save())) {
          setNotice({ text: "Fix what didn't save, then try again.", tone: "danger" });
          return;
        }
        const result = await run();
        if (!result.ok) {
          setNotice({ text: result.error ?? "That didn't work.", tone: "danger" });
          return;
        }
        const index = visible.findIndex((item) => item.id === entry.id);
        const next = visible[index + 1] ?? visible[index - 1] ?? null;
        setRemoved((previous) => new Set(previous).add(entry.id));
        setSelectedId(next?.id ?? null);
        // "Approved, but not published yet" comes back as ok with the reasons
        // attached; say so plainly rather than claiming it went live.
        const blocker = result.issues?.[0]?.message;
        setNotice(
          blocker
            ? { text: `Kept as a draft — not published: ${blocker}`, tone: "danger" }
            : { text: `${entry.name}: ${done.toLowerCase()}`, tone: "info" },
        );
        router.refresh();
      });
    },
    [visible, router],
  );

  const publish = useCallback(
    (entry: InboxEntry) =>
      decide(
        entry,
        () =>
          stage === "draft"
            ? publishAction(entry.id)
            : decideAction({ contentId: entry.id, decision: "approved", publishImmediately: true }),
        "Published",
      ),
    [decide, stage],
  );

  const keepAsDraft = useCallback(
    (entry: InboxEntry) =>
      decide(entry, () => decideAction({ contentId: entry.id, decision: "approved" }), "Kept as a draft"),
    [decide],
  );

  const discard = useCallback(
    (entry: InboxEntry) => decide(entry, () => discardScreenAction(entry.id), "Discarded", false),
    [decide],
  );

  // Keys, when nobody is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable=true]") || event.metaKey || event.ctrlKey)) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        move(-1);
      } else if (selected && !pending) {
        if (event.key === "p" && permissions.publish) publish(selected);
        if (event.key === "d" && permissions.decide && stage === "review") keepAsDraft(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, selected, pending, permissions, publish, keepAsDraft, stage]);

  const shown = Math.max(0, total - removed.size);

  return (
    <div className="flex min-h-dvh flex-col">
      {/* --- Header ------------------------------------------------------------ */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink-200 px-4 py-4 md:px-6">
        <div className="min-w-0">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink-900"
          >
            <ArrowLeft aria-hidden className="size-3" />
            Inbox
          </Link>
          <h1 className="mt-1 flex items-baseline gap-2 text-lg font-medium tracking-[-0.01em] text-ink-900">
            {product.name}
            {product.domain ? <span className="font-mono text-xs font-normal text-ink-500">{product.domain}</span> : null}
          </h1>
        </div>
        <nav aria-label="Stage" className="flex items-center gap-1 self-end">
          <StageTab href={hrefFor("review")} active={stage === "review"} label="To review" count={counts.review} />
          <StageTab href={hrefFor("draft")} active={stage === "draft"} label="Drafts" count={counts.draft} />
        </nav>
        <Link
          href={`/products/${product.id}`}
          className="ml-auto flex h-8 items-center gap-1.5 self-end rounded-md border border-ink-200 px-3 text-xs text-ink-700 transition-colors hover:border-ink-300 hover:bg-ink-100 hover:text-ink-900"
        >
          Open product
        </Link>
      </header>

      <WebsiteProfile productId={product.id} profile={profile} />

      {visible.length === 0 || !selected ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-ink-100 text-ink-500">
            <InboxIcon aria-hidden className="size-4" />
          </span>
          <p className="text-[13px] text-ink-700">
            {stage === "review" ? `Nothing from ${product.name} to review.` : `No ${product.name} drafts.`}
          </p>
          <p className="max-w-xs text-xs text-ink-500">
            {stage === "review"
              ? "Everything you capture lands here first."
              : "Captures kept as drafts wait here until they are published."}
          </p>
          {notice ? <p className="text-xs text-ink-500">{notice.text}</p> : null}
          <Link href="/inbox" className="mt-2 text-xs text-ink-700 underline hover:text-ink-900">
            Back to the Inbox
          </Link>
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* --- The queue ----------------------------------------------------- */}
          <aside className="border-b border-ink-200 lg:border-b-0 lg:border-r">
            <p className="px-4 pb-2 pt-4 text-xs text-ink-500 md:px-5">
              {shown} {shown === 1 ? "capture" : "captures"}
              {total > items.length ? ` — showing the newest ${items.length}` : ""}
            </p>
            <ul className="flex gap-2 overflow-x-auto px-4 pb-4 md:px-5 lg:max-h-[calc(100dvh-150px)] lg:flex-col lg:overflow-y-auto lg:overflow-x-visible">
              {visible.map((item) => (
                <li key={item.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    onClick={() => select(item.id)}
                    aria-current={item.id === selected.id}
                    className={clsx(
                      "flex w-56 items-center gap-3 rounded-lg border p-2 text-left transition-colors lg:w-full",
                      item.id === selected.id
                        ? "border-ink-400 bg-ink-100"
                        : "border-transparent hover:border-ink-200 hover:bg-ink-100/60",
                    )}
                  >
                    <span className="relative aspect-[16/10] w-20 shrink-0 overflow-hidden rounded-md border border-ink-200 bg-ink-100">
                      {item.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover object-top" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink-900">
                        {item.name}
                        {item.stateLabel ? <span className="text-ink-500"> — {item.stateLabel}</span> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-500">
                        {[item.capturedAgo, item.capturedBy].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* --- The capture being decided ------------------------------------ */}
          <Detail
            key={selected.id}
            entry={selected}
            stage={stage}
            tags={tags}
            permissions={permissions}
            pending={pending}
            notice={notice}
            onPublish={() => publish(selected)}
            onDraft={() => keepAsDraft(selected)}
            onDiscard={() => discard(selected)}
            guard={guard}
          />
        </div>
      )}
    </div>
  );
}

function StageTab({ href, active, label, count }: { href: string; active: boolean; label: string; count: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "flex h-8 items-center gap-2 rounded-md px-3 text-xs transition-colors",
        active ? "bg-ink-200 text-ink-900" : "text-ink-500 hover:bg-ink-100 hover:text-ink-900",
      )}
    >
      {label}
      <span className={clsx("font-mono text-[11px]", active ? "text-ink-700" : "text-ink-400")}>{count}</span>
    </Link>
  );
}

function Detail({
  entry,
  stage,
  tags,
  permissions,
  pending,
  notice,
  onPublish,
  onDraft,
  onDiscard,
  guard,
}: {
  entry: InboxEntry;
  stage: Stage;
  tags: readonly TagOption[];
  permissions: { decide: boolean; publish: boolean; rename: boolean; tag: boolean };
  pending: boolean;
  notice: { text: string; tone: "info" | "danger" } | null;
  onPublish: () => void;
  onDraft: () => void;
  onDiscard: () => void;
  guard: React.RefObject<{ save: () => Promise<boolean>; confirmLeave: () => boolean } | null>;
}) {
  const draft = useScreenDraft(entry);
  const [suggestions, setSuggestions] = useState(entry.suggestions);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Let the queue save these edits before a decision, and ask before
  // moving away from them.
  useEffect(() => {
    guard.current = { save: draft.save, confirmLeave: draft.confirmLeave };
    return () => {
      guard.current = null;
    };
  }, [guard, draft.save, draft.confirmLeave]);

  // Accepting a suggestion adds the tag to the draft; Save confirms the
  // machine's row rather than writing a second one.
  const acceptSuggestion = (suggestion: InboxEntry["suggestions"][number]) => {
    setSuggestions((list) => list.filter((item) => item.assignmentId !== suggestion.assignmentId));
    if (!draft.values.tagIds.includes(suggestion.termId)) draft.set("tagIds", [...draft.values.tagIds, suggestion.termId]);
  };

  const busy = pending || draft.saving;

  return (
    <section aria-label={entry.name} className="flex min-w-0 flex-col gap-5 p-4 md:p-6">
      {/* The queue's thumbnail, already loaded, holds the space while the
          large image arrives — moving to the next capture never flashes blank. */}
      <div
        className="overflow-hidden rounded-xl border border-ink-200 bg-ink-100 bg-cover bg-top"
        style={entry.thumbnailUrl ? { backgroundImage: `url(${entry.thumbnailUrl})` } : undefined}
      >
        {entry.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.imageUrl}
            alt={entry.name}
            className={clsx("mx-auto block w-full", entry.mobile ? "max-w-sm" : "")}
          />
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center text-xs text-ink-500">No image yet</div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            {entry.productId ? (
              <Link href={`/products/${entry.productId}`} className="text-ink-800 hover:underline">
                {entry.productName}
              </Link>
            ) : (
              <span className="text-ink-800">{entry.productName}</span>
            )}
            {entry.url ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 font-mono hover:text-ink-900"
              >
                {shortUrl(entry.url)}
                <ArrowUpRight aria-hidden className="size-3" />
              </a>
            ) : null}
            {entry.mobile ? (
              <span className="flex items-center gap-1">
                <Smartphone aria-hidden className="size-3" /> Mobile
              </span>
            ) : null}
          </div>

          <div className="grid max-w-xl grid-cols-[1fr_10rem] gap-2">
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
            {suggestions.length > 0 && permissions.tag ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="flex items-center gap-1 text-[11px] text-ink-500">
                  <Sparkles aria-hidden className="size-3" /> Suggested
                </span>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.assignmentId}
                    type="button"
                    onClick={() => acceptSuggestion(suggestion)}
                    className="flex h-6 items-center gap-1 rounded-md border border-dashed border-ink-300 px-2 text-[11px] text-ink-600 transition-colors hover:border-ink-500 hover:text-ink-900"
                  >
                    <Check aria-hidden className="size-3" />
                    {suggestion.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {permissions.rename || permissions.tag ? (
            <SaveBar
              dirty={draft.dirty}
              saving={draft.saving}
              error={draft.error}
              onSave={() => void draft.save()}
              onDiscard={draft.discard}
              className="max-w-xl border-t border-ink-200 pt-3"
            />
          ) : null}
        </div>

        {/* --- The decision ------------------------------------------------ */}
        <div className="flex flex-col gap-2 xl:w-64">
          {permissions.publish ? (
            <button
              type="button"
              disabled={busy}
              onClick={onPublish}
              className="flex h-10 items-center justify-between rounded-lg bg-ink-900 px-4 text-[13px] font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-50"
            >
              Publish
              <Key>P</Key>
            </button>
          ) : null}
          {permissions.decide && stage === "review" ? (
            <button
              type="button"
              disabled={busy}
              onClick={onDraft}
              className="flex h-10 items-center justify-between rounded-lg border border-ink-300 px-4 text-[13px] text-ink-800 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
            >
              Keep as draft
              <Key>D</Key>
            </button>
          ) : null}
          {!permissions.publish && !permissions.decide ? (
            <p className="text-xs leading-relaxed text-ink-500">
              A reviewer decides what is published. You can still fix the name and tags, or discard your own captures.
            </p>
          ) : null}

          {entry.discardable ? (
            confirmDiscard ? (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-ink-600">Discard this capture?</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDiscard}
                  className="h-7 rounded-md bg-[var(--color-tone-danger)] px-3 text-xs font-medium text-ink-50 disabled:opacity-60"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  className="h-7 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDiscard(true)}
                className="flex h-9 items-center gap-2 self-start rounded-lg px-2 text-xs text-ink-500 transition-colors hover:text-[var(--color-tone-danger)] disabled:opacity-50"
              >
                <Trash2 aria-hidden className="size-3.5" />
                Discard
              </button>
            )
          ) : null}

          <p
            className={clsx(
              "min-h-4 text-xs",
              notice?.tone === "danger" ? "text-[var(--color-tone-danger)]" : "text-ink-500",
            )}
          >
            {notice?.text ?? (draft.dirty && permissions.publish ? "Publish saves your changes too." : "↑ ↓ to move between captures.")}
          </p>
        </div>
      </div>

      {/* For the record only: when, and by whom. Never shown on the public site. */}
      {entry.capturedAt || entry.capturedBy ? (
        <p className="border-t border-ink-200 pt-3 text-[11px] text-ink-400">
          Captured {entry.capturedAt ? <LocalTime iso={entry.capturedAt} /> : null}
          {entry.capturedBy ? ` by ${entry.capturedBy}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="flex size-5 items-center justify-center rounded border border-current/30 font-mono text-[10px] opacity-60">
      {children}
    </kbd>
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
