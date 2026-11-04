"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  CONTENT_KIND_META,
  LIFECYCLE_STATUS_META,
  TAXONOMY_KIND_META,
  type ContentKind,
  type LifecycleStatus,
  type TaxonomyKind,
} from "@uxd/types";
import { Badge, Button, Kbd, Note, Panel } from "@/components/ui/primitives";
import {
  type ClassificationActionResult,
  bulkAcceptSuggestionsAction,
  bulkRejectSuggestionsAction,
  reviewSuggestionAction,
} from "@/lib/actions/classification";

export interface SuggestionRow {
  assignmentId: string;
  termId: string;
  termName: string;
  termKind: string;
  termPath: string;
  confidence: number | null;
  model: string | null;
  contentId: string;
  contentTitle: string | null;
  contentKind: string;
  contentStatus: string;
}

export interface TermOption {
  id: string;
  name: string;
  kind: string;
  path: string;
}

/**
 * The suggestion queue, built for the keyboard.
 *
 * §14 wants review to be fast enough that a person actually does it, so the
 * interaction is one row at a time with `A`/`R`/`M` rather than a grid of
 * dropdowns. Selection exists for the bulk path, but bulk is deliberately
 * limited to rows the reviewer has on screen — "accept everything above 0.9"
 * across unseen rows is auto-classification with an extra click.
 *
 * Confidence is shown as a number and a bar. The bar's fill is the number, but
 * the *floor* marker is what carries the meaning: it says where the auto-apply
 * threshold sits, so a reviewer can see that a suggestion the system would not
 * have trusted is one they are being asked to judge.
 */
export function SuggestionQueue({
  suggestions,
  terms,
  autoApplyFloor,
}: {
  suggestions: readonly SuggestionRow[];
  terms: readonly TermOption[];
  autoApplyFloor: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ClassificationActionResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(
    () => suggestions.filter((row) => !done.has(row.assignmentId)),
    [suggestions, done],
  );

  const termsByKind = useMemo(() => {
    const map = new Map<string, TermOption[]>();
    for (const term of terms) {
      map.set(term.kind, [...(map.get(term.kind) ?? []), term]);
    }
    return map;
  }, [terms]);

  const run = (ids: readonly string[], action: () => Promise<ClassificationActionResult>) => {
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) {
        // Removed locally so the queue does not jump under the reviewer while
        // the server revalidates. The next navigation reflects the server.
        setDone((current) => new Set([...current, ...ids]));
        setSelected(new Set());
        setCorrecting(null);
      }
    });
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {result ? (
        <Note tone={result.ok ? "success" : "danger"}>
          <p>{result.message ?? result.error}</p>
          {result.issues.length > 0 ? (
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
              {result.issues.map((issue) => (
                <li key={`${issue.path}-${issue.message}`} className="text-2xs">
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Note>
      ) : null}

      {/* --- Bulk bar, only for what is on screen ------------------ */}
      {selected.size > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-ink-300 bg-ink-900 px-3 py-2 text-ink-50 shadow-lg">
          <span className="text-xs font-medium">{selected.size} selected</span>
          <Button
            variant="primary"
            disabled={isPending}
            onClick={() => run([...selected], () => bulkAcceptSuggestionsAction([...selected]))}
          >
            Confirm all
          </Button>
          <Button
            variant="danger"
            disabled={isPending}
            onClick={() => {
              const reason = window.prompt("Why are these being rejected?");
              if (reason?.trim()) {
                run([...selected], () => bulkRejectSuggestionsAction([...selected], reason.trim()));
              }
            }}
          >
            Reject all
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <span className="ml-auto text-2xs text-ink-300">
            Applies only to the rows on this page.
          </span>
        </div>
      ) : null}

      <Panel>
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={selected.size > 0 && selected.size === visible.length}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? new Set(visible.map((row) => row.assignmentId))
                        : new Set(),
                    )
                  }
                />
              </th>
              <th>Suggested term</th>
              <th className="w-40">Confidence</th>
              <th>Record</th>
              <th className="w-56 text-right">Decision</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const kindMeta = TAXONOMY_KIND_META[row.termKind as TaxonomyKind];
              const statusMeta = LIFECYCLE_STATUS_META[row.contentStatus as LifecycleStatus];
              const confidence = row.confidence ?? 0;
              const belowFloor = confidence < autoApplyFloor;

              return (
                <tr
                  key={row.assignmentId}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (isPending || event.metaKey || event.ctrlKey) return;
                    const key = event.key.toLowerCase();
                    if (key === "a") {
                      event.preventDefault();
                      run([row.assignmentId], () =>
                        reviewSuggestionAction({
                          assignmentId: row.assignmentId,
                          decision: "accept",
                        }),
                      );
                    } else if (key === "r") {
                      event.preventDefault();
                      const reason = window.prompt("Why is this wrong? (optional)");
                      run([row.assignmentId], () =>
                        reviewSuggestionAction({
                          assignmentId: row.assignmentId,
                          decision: "reject",
                          note: reason?.trim() || null,
                        }),
                      );
                    } else if (key === "m") {
                      event.preventDefault();
                      setCorrecting(row.assignmentId);
                    }
                  }}
                  className="focus:outline focus:outline-2 focus:outline-[var(--color-accent)]"
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.termName}`}
                      checked={selected.has(row.assignmentId)}
                      onChange={() => toggle(row.assignmentId)}
                    />
                  </td>

                  <td className="truncate-cell">
                    <span className="font-medium text-ink-900">{row.termName}</span>
                    <p className="truncate text-2xs text-ink-500">
                      {kindMeta?.label ?? row.termKind}
                      {row.termPath ? ` · ${row.termPath}` : ""}
                      {row.model ? ` · ${row.model}` : ""}
                    </p>
                  </td>

                  <td>
                    <div className="flex items-center gap-1.5">
                      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-ink-200">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full"
                          style={{
                            width: `${Math.round(confidence * 100)}%`,
                            background: belowFloor
                              ? "var(--color-tone-warning)"
                              : "var(--color-tone-success)",
                          }}
                        />
                        {/* Where the auto-apply threshold sits. */}
                        <div
                          className="absolute inset-y-0 w-px bg-ink-700"
                          style={{ left: `${Math.round(autoApplyFloor * 100)}%` }}
                          title={`Auto-apply floor: ${autoApplyFloor}`}
                        />
                      </div>
                      <span className="tabular-nums text-2xs text-ink-600">
                        {row.confidence === null ? "—" : confidence.toFixed(2)}
                      </span>
                    </div>
                    {belowFloor ? (
                      <p className="mt-0.5 text-2xs text-[var(--color-tone-warning)]">
                        below the auto-apply floor
                      </p>
                    ) : null}
                  </td>

                  <td className="truncate-cell">
                    <Link
                      href={`/content/${row.contentId}`}
                      className="hover:underline"
                      target="_blank"
                    >
                      {row.contentTitle ?? "Untitled"}
                    </Link>
                    <p className="flex items-center gap-1 text-2xs text-ink-500">
                      {CONTENT_KIND_META[row.contentKind as ContentKind]?.label ?? row.contentKind}
                      <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                    </p>
                  </td>

                  <td>
                    {correcting === row.assignmentId ? (
                      <form
                        className="flex items-center justify-end gap-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          const termId = String(form.get("termId") ?? "");
                          if (!termId) return;
                          run([row.assignmentId], () =>
                            reviewSuggestionAction({
                              assignmentId: row.assignmentId,
                              decision: "modify",
                              termId,
                            }),
                          );
                        }}
                      >
                        <select
                          name="termId"
                          defaultValue=""
                          className="h-6 max-w-40 rounded-[4px] border border-ink-300 bg-surface px-1 text-2xs"
                        >
                          <option value="">Choose a term…</option>
                          {/* Same kind first: a correction is usually a sibling. */}
                          <optgroup label={kindMeta?.plural ?? row.termKind}>
                            {(termsByKind.get(row.termKind) ?? []).map((term) => (
                              <option key={term.id} value={term.id}>
                                {term.path || term.name}
                              </option>
                            ))}
                          </optgroup>
                          {[...termsByKind.entries()]
                            .filter(([kind]) => kind !== row.termKind)
                            .map(([kind, options]) => (
                              <optgroup
                                key={kind}
                                label={TAXONOMY_KIND_META[kind as TaxonomyKind]?.plural ?? kind}
                              >
                                {options.map((term) => (
                                  <option key={term.id} value={term.id}>
                                    {term.path || term.name}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                        </select>
                        <Button type="submit" variant="primary" disabled={isPending}>
                          Save
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setCorrecting(null)}>
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="primary"
                          disabled={isPending}
                          onClick={() =>
                            run([row.assignmentId], () =>
                              reviewSuggestionAction({
                                assignmentId: row.assignmentId,
                                decision: "accept",
                              }),
                            )
                          }
                        >
                          Confirm
                        </Button>
                        <Button disabled={isPending} onClick={() => setCorrecting(row.assignmentId)}>
                          Correct
                        </Button>
                        <Button
                          variant="danger"
                          disabled={isPending}
                          onClick={() => {
                            const reason = window.prompt("Why is this wrong? (optional)");
                            run([row.assignmentId], () =>
                              reviewSuggestionAction({
                                assignmentId: row.assignmentId,
                                decision: "reject",
                                note: reason?.trim() || null,
                              }),
                            );
                          }}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-500">
        <span>
          Focus a row, then <Kbd>A</Kbd> confirm · <Kbd>R</Kbd> reject · <Kbd>M</Kbd> correct
        </span>
        {visible.length !== suggestions.length ? (
          <span>{suggestions.length - visible.length} decided on this page.</span>
        ) : null}
      </p>
    </div>
  );
}
