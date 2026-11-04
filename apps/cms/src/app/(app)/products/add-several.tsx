"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { BulkLine } from "@uxd/api";
import { addProductsAction, previewProductsAction } from "@/lib/actions/products";

type Step = { kind: "paste" } | { kind: "review"; lines: BulkLine[] } | { kind: "done"; summary: string; failed: { url: string; error: string | null }[] };

const STATUS: Record<BulkLine["status"], { label: string; tone: string; addable: boolean; ticked: boolean }> = {
  new: { label: "New", tone: "text-[var(--color-tone-success)]", addable: true, ticked: true },
  archived: { label: "Removed earlier — adding brings it back", tone: "text-ink-600", addable: true, ticked: true },
  exists: { label: "Already here", tone: "text-ink-500", addable: false, ticked: false },
  repeat: { label: "Twice in this list", tone: "text-ink-500", addable: false, ticked: false },
  invalid: { label: "Not an address", tone: "text-[var(--color-tone-danger)]", addable: false, ticked: false },
};

/**
 * Add many products at once: paste a list, see what each line is, untick
 * anything you don't want, add the rest.
 *
 * Nothing is added until the second step, and every line says what will
 * happen to it — new, already here, twice in the list, not an address — so a
 * list of a hundred can be checked at a glance instead of after the fact.
 */
export function AddSeveral({ initialText = "", onDone }: { initialText?: string; onDone: () => void }) {
  const [raw, setRaw] = useState(initialText);
  const [step, setStep] = useState<Step>({ kind: "paste" });
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Arriving with a pasted list: check it straight away — that is what the
  // person was about to do.
  useEffect(() => {
    if (initialText.trim()) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = () => {
    setError(null);
    start(async () => {
      const result = await previewProductsAction(raw);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStep({ kind: "review", lines: result.lines });
      setTicked(new Set(result.lines.flatMap((line, index) => (STATUS[line.status].ticked ? [index] : []))));
    });
  };

  const counts = useMemo(() => {
    if (step.kind !== "review") return null;
    const by = (status: BulkLine["status"]) => step.lines.filter((line) => line.status === status).length;
    return { new: by("new"), archived: by("archived"), exists: by("exists"), skipped: by("repeat") + by("invalid") };
  }, [step]);

  const add = () => {
    if (step.kind !== "review") return;
    const urls = step.lines.flatMap((line, index) => (ticked.has(index) && line.url ? [line.url] : []));
    start(async () => {
      const result = await addProductsAction(urls);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const parts = [
        result.added ? `Added ${result.added}` : null,
        result.restored ? `brought back ${result.restored}` : null,
      ].filter(Boolean);
      setStep({
        kind: "done",
        summary: parts.length ? `${parts.join(", ")}.` : "Nothing was added.",
        failed: result.failed,
      });
    });
  };

  return (
    <div className="rounded-xl border border-ink-200 bg-surface p-4">
      <p className="text-xs text-ink-500">
        {step.kind === "paste"
          ? "One address per line. Spreadsheet rows work too — the address is found on each line."
          : step.kind === "review"
            ? "Untick anything you don't want, then add the rest."
            : "Done."}
      </p>

      {step.kind === "paste" ? (
        <>
          <textarea
            autoFocus
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={"linear.app\nhttps://www.notion.com\nlovable.dev"}
            aria-label="Website addresses, one per line"
            className="mt-3 w-full resize-y rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs leading-relaxed text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none"
          />
          {error ? <p className="mt-2 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={pending || !raw.trim()}
              onClick={check}
              className="h-8 rounded-md bg-ink-900 px-4 text-xs font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-40"
            >
              {pending ? "Checking…" : "Check the list"}
            </button>
          </div>
        </>
      ) : null}

      {step.kind === "review" && counts ? (
        <>
          <p className="mt-3 text-xs text-ink-600">
            {counts.new} new
            {counts.archived ? ` · ${counts.archived} removed earlier` : ""}
            {counts.exists ? ` · ${counts.exists} already here` : ""}
            {counts.skipped ? ` · ${counts.skipped} skipped` : ""}
          </p>
          <ul className="mt-2 max-h-80 divide-y divide-ink-200 overflow-y-auto rounded-lg border border-ink-200">
            {step.lines.map((line, index) => {
              const meta = STATUS[line.status];
              return (
                <li key={`${index}-${line.input}`}>
                  <label
                    className={clsx(
                      "flex items-center gap-3 px-3 py-2",
                      meta.addable ? "cursor-pointer hover:bg-ink-100" : "opacity-70",
                    )}
                  >
                    <input
                      type="checkbox"
                      disabled={!meta.addable}
                      checked={ticked.has(index)}
                      onChange={(event) =>
                        setTicked((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(index);
                          else next.delete(index);
                          return next;
                        })
                      }
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-900">{line.site ?? line.input}</span>
                    <span className={clsx("shrink-0 text-[11px]", meta.tone)}>
                      {line.status === "exists" && line.existing ? (
                        <Link href={`/products/${line.existing.id}`} className="underline hover:text-ink-900">
                          Already here as {line.existing.name}
                        </Link>
                      ) : (
                        (line.reason && line.status === "invalid" ? line.reason : meta.label)
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {error ? <p className="mt-2 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep({ kind: "paste" })}
              className="h-8 rounded-md px-3 text-xs text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            >
              Edit the list
            </button>
            <button
              type="button"
              disabled={pending || ticked.size === 0}
              onClick={add}
              className="h-8 rounded-md bg-ink-900 px-4 text-xs font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-40"
            >
              {pending ? "Adding…" : `Add ${ticked.size} ${ticked.size === 1 ? "product" : "products"}`}
            </button>
          </div>
        </>
      ) : null}

      {step.kind === "done" ? (
        <div className="mt-3">
          <p className="text-[13px] text-ink-900">{step.summary}</p>
          {step.failed.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-[var(--color-tone-danger)]">
              {step.failed.map((failure) => (
                <li key={failure.url}>
                  <span className="font-mono">{failure.url}</span> — {failure.error}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setRaw("");
                setStep({ kind: "paste" });
              }}
              className="h-8 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
            >
              Add more
            </button>
            <button
              type="button"
              onClick={onDone}
              className="h-8 rounded-md bg-ink-900 px-4 text-xs font-medium text-ink-50 hover:bg-ink-950"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
