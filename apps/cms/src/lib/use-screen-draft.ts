"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { addAssignmentAction, removeAssignmentAction } from "@/lib/actions/classification";
import { updateScreenAction } from "@/lib/actions/discovery";
import { setFeaturedAction } from "@/lib/actions/review";

export interface ScreenDraftSource {
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string | null;
  readonly tags: readonly { readonly assignmentId: string; readonly termId: string }[];
  /** Only where featuring is offered (the Library). */
  readonly featured?: boolean;
}

interface Values {
  name: string;
  stateLabel: string;
  tagIds: string[];
  featured: boolean;
}

/**
 * Edits to a screen, held until Save.
 *
 * Every editing surface in the CMS works the same way: changes are a draft
 * until the person presses Save, can be thrown away with Discard, and the
 * page warns before leaving with any unsaved. This is that behaviour, once —
 * the Inbox, the Library and the Studio all use it.
 */
export function useScreenDraft(source: ScreenDraftSource) {
  const initial = useMemo<Values>(
    () => ({
      name: source.name,
      stateLabel: source.stateLabel ?? "",
      tagIds: source.tags.map((tag) => tag.termId),
      featured: source.featured ?? false,
    }),
    [source],
  );
  const [saved, setSaved] = useState<Values>(initial);
  const [values, setValues] = useState<Values>(initial);
  // Assignment ids for removing tags: the server's, plus any made by a save.
  const [assignments, setAssignments] = useState(source.tags);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    values.name.trim() !== saved.name.trim() ||
    values.stateLabel.trim() !== saved.stateLabel.trim() ||
    values.featured !== saved.featured ||
    values.tagIds.length !== saved.tagIds.length ||
    values.tagIds.some((id) => !saved.tagIds.includes(id));

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    if (!values.name.trim()) {
      setError("A screen needs a name.");
      return false;
    }
    setSaving(true);
    setError(null);
    const failures: string[] = [];

    if (values.name.trim() !== saved.name.trim() || values.stateLabel.trim() !== saved.stateLabel.trim()) {
      const result = await updateScreenAction(source.id, {
        screenName: values.name.trim(),
        stateLabel: values.stateLabel.trim(),
      });
      if (!result.ok) failures.push(result.error ?? "The name didn't save.");
    }

    const added = values.tagIds.filter((id) => !saved.tagIds.includes(id));
    const removed = assignments.filter((tag) => saved.tagIds.includes(tag.termId) && !values.tagIds.includes(tag.termId));
    const tagResults = await Promise.all([
      ...added.map((termId) => addAssignmentAction(source.id, termId)),
      ...removed.map((tag) => removeAssignmentAction(tag.assignmentId)),
    ]);
    const tagFailure = tagResults.find((result) => !result.ok);
    if (tagFailure) failures.push(tagFailure.error ?? "A tag didn't save.");

    if (source.featured !== undefined && values.featured !== saved.featured) {
      const result = await setFeaturedAction(source.id, values.featured);
      if (!result.ok) failures.push(result.error ?? "Featured didn't save.");
    }

    setSaving(false);
    if (failures.length > 0) {
      setError(failures[0]!);
      return false;
    }
    setSaved(values);
    setAssignments((list) => list.filter((tag) => values.tagIds.includes(tag.termId)));
    return true;
  }, [dirty, values, saved, assignments, source.id, source.featured]);

  const discard = useCallback(() => {
    setValues(saved);
    setError(null);
  }, [saved]);

  /** Ask before throwing unsaved changes away. True means "go ahead". */
  const confirmLeave = useCallback(
    () => !dirty || window.confirm("You have unsaved changes. Leave without saving them?"),
    [dirty],
  );

  return {
    values,
    set: <K extends keyof Values>(key: K, value: Values[K]) => setValues((current) => ({ ...current, [key]: value })),
    dirty,
    saving,
    error,
    save,
    discard,
    confirmLeave,
  };
}
