"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  CLASSIFICATION_ORIGIN_META,
  LIFECYCLE_STATUS_META,
  TAXONOMY_KIND_META,
  type ClassificationOrigin,
  type LifecycleStatus,
  type TaxonomyKind,
} from "@uxd/types";
import { Badge, Button, Kbd, Note } from "@/components/ui/primitives";
import {
  addAssignmentAction,
  removeAssignmentAction,
  reviewSuggestionAction,
} from "@/lib/actions/classification";
import { decideAction } from "@/lib/actions/review";
import { updateScreenAction } from "@/lib/actions/discovery";

export interface SuggestionRow {
  readonly assignmentId: string;
  readonly termId: string;
  readonly termName: string;
  readonly termKind: TaxonomyKind;
  readonly termPath: string;
  readonly confidence: number | null;
  readonly origin: ClassificationOrigin;
  readonly reviewStatus: string;
  readonly model: string | null;
  readonly suggestedAt: string | null;
  readonly reviewerName: string | null;
  readonly replacedTermName: string | null;
}

export interface TermOption {
  readonly id: string;
  readonly name: string;
  readonly kind: TaxonomyKind;
  readonly path: string;
}

/**
 * Screen review (§6, §7, §8).
 *
 * The screen where the product's central promise is kept: the machine has
 * proposed, and a person decides. Three things it has to get right.
 *
 * **Every suggestion is visibly a suggestion.** Confidence is shown as a
 * number, the model is named, and the origin badge says whether a human has
 * touched it. A suggestion that looked like a fact would be a suggestion that
 * gets rubber-stamped.
 *
 * **Correcting is as cheap as accepting.** Accept, reject and change are all
 * one click from the same row. When a reviewer changes a term, the original is
 * kept on the assignment (`replacedTermId`) — which is what makes "how often
 * is the model wrong, and wrong in which direction?" answerable later. That
 * question is the reason this screen exists in this shape.
 *
 * **The keyboard is the interface.** Review is the pipeline's real cost: at
 * roughly six decisions a screen, a thousand screens is days of someone's
 * attention. A/R keys on the focused suggestion, and approve without leaving
 * the page.
 */
export function ScreenReview({
  contentItemId,
  status,
  screenName,
  stateLabel,
  description,
  notes,
  suggestions,
  terms,
}: {
  contentItemId: string;
  status: LifecycleStatus;
  screenName: string;
  stateLabel: string | null;
  description: string | null;
  notes: string | null;
  suggestions: readonly SuggestionRow[];
  terms: readonly TermOption[];
}) {
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(screenName);
  const [stateDraft, setStateDraft] = useState(stateLabel ?? "");
  const [descriptionDraft, setDescriptionDraft] = useState(description ?? "");
  const [notesDraft, setNotesDraft] = useState(notes ?? "");
  const [addKind, setAddKind] = useState<TaxonomyKind | "">("");
  const [addTermId, setAddTermId] = useState("");

  const run = (action: () => Promise<{ error: string | null; message: string | null }>) => {
    startTransition(async () => {
      const result = await action();
      setMessage(
        result.error
          ? { text: result.error, tone: "danger" }
          : result.message
            ? { text: result.message, tone: "info" }
            : null,
      );
    });
  };

  const pendingSuggestions = suggestions.filter((s) => s.reviewStatus === "pending");
  const settled = suggestions.filter((s) => s.reviewStatus !== "pending");

  return (
    <div className="flex flex-col gap-3">
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}

      {/* --- Identity --------------------------------------------------- */}
      <section className="rounded-md border border-ink-200 bg-surface p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold text-ink-800">Screen</h2>
          <button
            type="button"
            className="text-2xs text-ink-500 underline hover:text-ink-800"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>

        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <label className="text-2xs font-medium text-ink-600">
              Name
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs"
              />
            </label>
            <label className="text-2xs font-medium text-ink-600">
              State
              <input
                value={stateDraft}
                placeholder="Navigation open"
                onChange={(event) => setStateDraft(event.target.value)}
                className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs"
              />
            </label>
            <label className="text-2xs font-medium text-ink-600">
              Description
              <textarea
                value={descriptionDraft}
                rows={3}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                className="mt-1 w-full rounded-[4px] border border-ink-300 px-2 py-1 text-xs"
              />
            </label>
            <label className="text-2xs font-medium text-ink-600">
              Notes <span className="font-normal text-ink-400">internal</span>
              <textarea
                value={notesDraft}
                rows={2}
                onChange={(event) => setNotesDraft(event.target.value)}
                className="mt-1 w-full rounded-[4px] border border-ink-300 px-2 py-1 text-xs"
              />
            </label>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await updateScreenAction(contentItemId, {
                    screenName: nameDraft,
                    stateLabel: stateDraft,
                    description: descriptionDraft,
                    notes: notesDraft,
                  });
                  if (!result.error) setEditing(false);
                  return result;
                })
              }
            >
              Save
            </Button>
          </div>
        ) : (
          <dl className="mt-1.5 flex flex-col gap-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-ink-500">Name</dt>
              <dd className="text-ink-900">{screenName}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-ink-500">State</dt>
              <dd className="text-ink-900">{stateLabel ?? <span className="text-ink-400">default</span>}</dd>
            </div>
            {description ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-ink-500">Description</dt>
                <dd className="text-ink-700">{description}</dd>
              </div>
            ) : null}
          </dl>
        )}
      </section>

      {/* --- Suggestions ------------------------------------------------- */}
      <section className="rounded-md border border-ink-200 bg-surface">
        <div className="flex items-baseline justify-between border-b border-ink-200 bg-ink-50 px-3 py-2">
          <h2 className="text-xs font-semibold text-ink-800">Suggested tags</h2>
          <span className="text-2xs text-ink-500">
            {pendingSuggestions.length} awaiting a decision
          </span>
        </div>

        {pendingSuggestions.length === 0 && settled.length === 0 ? (
          <p className="px-3 py-4 text-2xs text-ink-500">
            Nothing suggested. Add tags by hand below, or request classification from the content
            page.
          </p>
        ) : null}

        <ul className="divide-y divide-ink-100">
          {pendingSuggestions.map((suggestion) => (
            <SuggestionItem
              key={suggestion.assignmentId}
              suggestion={suggestion}
              terms={terms}
              pending={pending}
              onRun={run}
            />
          ))}
        </ul>

        {settled.length > 0 ? (
          <details className="border-t border-ink-200">
            <summary className="cursor-pointer px-3 py-2 text-2xs text-ink-500">
              {settled.length} already decided
            </summary>
            <ul className="divide-y divide-ink-100">
              {settled.map((assignment) => {
                const origin = CLASSIFICATION_ORIGIN_META[assignment.origin];
                return (
                  <li
                    key={assignment.assignmentId}
                    className="flex items-center gap-2 px-3 py-1.5 text-2xs"
                  >
                    <span className="text-ink-400">
                      {TAXONOMY_KIND_META[assignment.termKind]?.label ?? assignment.termKind}
                    </span>
                    <span className="font-medium text-ink-800">{assignment.termName}</span>
                    <Badge tone={origin.tone} title={origin.description}>
                      {origin.shortLabel}
                    </Badge>
                    {assignment.replacedTermName ? (
                      <span className="text-ink-400">
                        was &ldquo;{assignment.replacedTermName}&rdquo;
                      </span>
                    ) : null}
                    {assignment.reviewStatus !== "rejected" ? (
                      <button
                        type="button"
                        disabled={pending}
                        className="ml-auto text-ink-400 underline hover:text-[var(--color-tone-danger)]"
                        onClick={() =>
                          run(() => removeAssignmentAction(assignment.assignmentId))
                        }
                      >
                        remove
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}

        {/* Add a tag the machine never proposed. */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-200 px-3 py-2">
          <select
            value={addKind}
            onChange={(event) => {
              setAddKind(event.target.value as TaxonomyKind);
              setAddTermId("");
            }}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-2xs"
            aria-label="Vocabulary"
          >
            <option value="">Add a tag…</option>
            {[...new Set(terms.map((term) => term.kind))].map((kind) => (
              <option key={kind} value={kind}>
                {TAXONOMY_KIND_META[kind]?.label ?? kind}
              </option>
            ))}
          </select>
          {addKind ? (
            <select
              value={addTermId}
              onChange={(event) => setAddTermId(event.target.value)}
              className="h-7 min-w-48 rounded-[4px] border border-ink-300 bg-surface px-2 text-2xs"
              aria-label="Term"
            >
              <option value="">Choose a term</option>
              {terms
                .filter((term) => term.kind === addKind)
                .map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name}
                  </option>
                ))}
            </select>
          ) : null}
          {addTermId ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await addAssignmentAction(contentItemId, addTermId);
                  if (!result.error) {
                    setAddTermId("");
                    setAddKind("");
                  }
                  return result;
                })
              }
            >
              Add
            </Button>
          ) : null}
        </div>
      </section>

      {/* --- Decision ----------------------------------------------------- */}
      <section className="rounded-md border border-ink-200 bg-surface p-3">
        <h2 className="text-xs font-semibold text-ink-800">Decision</h2>
        <p className="mt-0.5 text-2xs leading-relaxed text-ink-500">
          {status === "needs_review"
            ? "Approving moves this screen out of the queue. Publishing is a separate, deliberate step."
            : `Currently ${LIFECYCLE_STATUS_META[status].label.toLowerCase()}.`}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button
            variant="primary"
            disabled={pending || status === "approved" || status === "published"}
            onClick={() => run(() => decideAction({ contentId: contentItemId, decision: "approved" }))}
          >
            Approve
          </Button>
          <Button
            variant="primary"
            disabled={pending || status === "published"}
            onClick={() =>
              run(() =>
                decideAction({
                  contentId: contentItemId,
                  decision: "approved",
                  publishImmediately: true,
                }),
              )
            }
          >
            Approve and publish
          </Button>
          <Button
            variant="danger"
            disabled={pending || status === "rejected"}
            onClick={() => run(() => decideAction({ contentId: contentItemId, decision: "rejected" }))}
          >
            Reject
          </Button>
          <Link
            href={`/content/${contentItemId}`}
            className="ml-auto text-2xs text-ink-500 underline hover:text-ink-800"
          >
            Full record
          </Link>
        </div>

        {pendingSuggestions.length > 0 ? (
          <Note tone="warning">
            {pendingSuggestions.length} suggestion
            {pendingSuggestions.length === 1 ? "" : "s"} still undecided. Approving leaves them
            pending, and a published screen with no accepted tags appears under no filter.
          </Note>
        ) : null}
      </section>
    </div>
  );
}

/**
 * One suggestion row.
 *
 * Confidence is rendered as a bar and a number. The bar is what a reviewer
 * reads at speed; the number is what makes a claim like "the model is reliable
 * above 90" checkable rather than a feeling.
 */
function SuggestionItem({
  suggestion,
  terms,
  pending,
  onRun,
}: {
  suggestion: SuggestionRow;
  terms: readonly TermOption[];
  pending: boolean;
  onRun: (action: () => Promise<{ error: string | null; message: string | null }>) => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [replacementId, setReplacementId] = useState("");
  const confidence = suggestion.confidence ?? 0;
  const kindLabel = TAXONOMY_KIND_META[suggestion.termKind]?.label ?? suggestion.termKind;

  return (
    <li
      className="px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "a") {
          onRun(() =>
            reviewSuggestionAction({ assignmentId: suggestion.assignmentId, decision: "accept" }),
          );
        }
        if (event.key === "r") {
          onRun(() =>
            reviewSuggestionAction({ assignmentId: suggestion.assignmentId, decision: "reject" }),
          );
        }
      }}
      tabIndex={0}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs uppercase tracking-wide text-ink-400">{kindLabel}</div>
          <div className="text-xs font-medium text-ink-900">{suggestion.termName}</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 w-24 overflow-hidden rounded-full bg-ink-100">
              <div
                className="h-full rounded-full bg-[var(--color-accent)]"
                style={{ width: `${Math.round(confidence * 100)}%` }}
              />
            </div>
            <span className="font-mono text-2xs text-ink-500">
              {suggestion.confidence === null
                ? "no score"
                : `${Math.round(confidence * 100)}% confident`}
            </span>
            {suggestion.model ? (
              <span className="text-2xs text-ink-400" title="Which model proposed this">
                {suggestion.model}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              onRun(() =>
                reviewSuggestionAction({
                  assignmentId: suggestion.assignmentId,
                  decision: "accept",
                }),
              )
            }
          >
            Accept
          </Button>
          <Button size="sm" disabled={pending} onClick={() => setCorrecting((value) => !value)}>
            Change
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() =>
              onRun(() =>
                reviewSuggestionAction({
                  assignmentId: suggestion.assignmentId,
                  decision: "reject",
                }),
              )
            }
          >
            Reject
          </Button>
        </div>
      </div>

      {correcting ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={replacementId}
            onChange={(event) => setReplacementId(event.target.value)}
            className="h-7 min-w-56 rounded-[4px] border border-ink-300 bg-surface px-2 text-2xs"
            aria-label={`Replacement for ${suggestion.termName}`}
          >
            <option value="">What it should be…</option>
            {terms
              .filter((term) => term.kind === suggestion.termKind && term.id !== suggestion.termId)
              .map((term) => (
                <option key={term.id} value={term.id}>
                  {term.name}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || !replacementId}
            onClick={() =>
              onRun(async () => {
                const result = await reviewSuggestionAction({
                  assignmentId: suggestion.assignmentId,
                  decision: "modify",
                  termId: replacementId,
                });
                if (!result.error) setCorrecting(false);
                return result;
              })
            }
          >
            Save correction
          </Button>
          <span className="text-2xs text-ink-400">
            The model&rsquo;s original is kept, so its accuracy stays measurable.
          </span>
        </div>
      ) : null}

      <div className="mt-1 text-2xs text-ink-400">
        <Kbd>A</Kbd> accept · <Kbd>R</Kbd> reject when this row has focus
      </div>
    </li>
  );
}
