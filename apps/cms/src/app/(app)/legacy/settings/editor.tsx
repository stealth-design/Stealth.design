"use client";

import { useState, useTransition } from "react";
import { Button, Note } from "@/components/ui/primitives";
import {
  type SettingActionResult,
  resetSettingAction,
  updateSettingAction,
} from "@/lib/actions/settings";

/**
 * One setting's editor.
 *
 * The input shape is chosen from the current value's type rather than from a
 * declared widget, which keeps the registry in `settings.ts` the single place a
 * setting is described: adding a key there makes it editable here with no
 * change to this file.
 *
 * Lists are edited as one-per-line text. A comma-separated field looks tidier
 * and is worse — the values here (query parameters, domains) are exactly the
 * kind of string where a stray comma or space is invisible, and one per line
 * makes each entry its own visible unit.
 *
 * Validation is the server's. The schema that refuses a bad value is the same
 * one a worker reads it through, so a client-side check could only ever
 * disagree with the authority.
 */
export function SettingEditor({
  settingKey,
  label,
  description,
  value,
  defaultValue,
  isDefault,
  updatedAt,
}: {
  settingKey: string;
  label: string;
  description: string;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  updatedAt: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<SettingActionResult | null>(null);
  const [draft, setDraft] = useState(() => toInput(value));
  const [dirty, setDirty] = useState(false);

  const kind = kindOf(defaultValue);

  const save = (next: unknown) => {
    startTransition(async () => {
      const outcome = await updateSettingAction(settingKey, next);
      setResult(outcome);
      if (outcome.ok) setDirty(false);
    });
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-ink-800">{label}</span>
            <span className="mono text-2xs text-ink-400">{settingKey}</span>
            {!isDefault ? (
              <span className="text-2xs text-[var(--color-accent)]" title={updatedAt ?? undefined}>
                changed
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 max-w-2xl text-2xs leading-relaxed text-ink-500">{description}</p>
        </div>

        <div className="flex shrink-0 items-start gap-1.5">
          {kind === "boolean" ? (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={value === true}
                disabled={isPending}
                onChange={(event) => save(event.target.checked)}
              />
              <span className="text-ink-600">{value === true ? "on" : "off"}</span>
            </label>
          ) : kind === "list" ? (
            <div className="flex flex-col items-end gap-1">
              <textarea
                rows={Math.min(8, Math.max(3, draft.split("\n").length))}
                value={draft}
                spellCheck={false}
                disabled={isPending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setDirty(true);
                }}
                className="mono w-72 resize-y rounded-[4px] border border-ink-300 p-1.5 text-2xs outline-none focus:border-[var(--color-accent)]"
                placeholder="One per line"
              />
              <div className="flex items-center gap-1.5">
                <span className="text-2xs text-ink-400">
                  {draft.split("\n").filter((line) => line.trim().length > 0).length} entries
                </span>
                <Button
                  variant="primary"
                  disabled={isPending || !dirty}
                  onClick={() =>
                    save(
                      draft
                        .split("\n")
                        .map((line) => line.trim())
                        .filter((line) => line.length > 0),
                    )
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type={kind === "number" ? "number" : "text"}
                step={kind === "number" && !Number.isInteger(defaultValue) ? "0.01" : "1"}
                value={draft}
                disabled={isPending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setDirty(true);
                }}
                className="mono h-7 w-40 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <Button
                variant="primary"
                disabled={isPending || !dirty}
                onClick={() => save(kind === "number" ? Number(draft) : draft)}
              >
                Save
              </Button>
            </div>
          )}

          {!isDefault ? (
            <Button
              variant="ghost"
              disabled={isPending}
              title={`Back to the default: ${describe(defaultValue)}`}
              onClick={() => {
                startTransition(async () => {
                  const outcome = await resetSettingAction(settingKey);
                  setResult(outcome);
                  if (outcome.ok) {
                    setDraft(toInput(defaultValue));
                    setDirty(false);
                  }
                });
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      {result ? (
        <div className="mt-1.5 max-w-lg">
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
        </div>
      ) : null}
    </div>
  );
}

type SettingKind = "boolean" | "number" | "list" | "text";

function kindOf(value: unknown): SettingKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  return "text";
}

function toInput(value: unknown): string {
  if (Array.isArray(value)) return value.join("\n");
  if (value === null || value === undefined) return "";
  return String(value);
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "an empty list" : `${value.length} entries`;
  }
  return String(value);
}
