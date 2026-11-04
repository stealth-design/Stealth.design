"use client";

import { useActionState } from "react";
import { Button, Note } from "@/components/ui/primitives";
import { type ChangePasswordFormState, changePasswordAction } from "@/lib/actions/auth";

const INITIAL: ChangePasswordFormState = { ok: false, message: null, error: null, field: null };

const FIELDS = [
  { name: "currentPassword", label: "Current password", autoComplete: "current-password" },
  { name: "newPassword", label: "New password", autoComplete: "new-password" },
  { name: "confirmPassword", label: "Confirm new password", autoComplete: "new-password" },
] as const;

export function PasswordForm({ rules }: { rules: { minLength: number; maxLength: number; description: string } }) {
  const [state, formAction, pending] = useActionState(changePasswordAction, INITIAL);

  return (
    // Keyed on the outcome so a successful change clears the fields; a failed
    // one keeps them, and the browser keeps what was typed.
    <form key={state.ok ? state.message : "form"} action={formAction} className="space-y-3 p-3">
      {FIELDS.map((field) => (
        <div key={field.name}>
          <label
            htmlFor={field.name}
            className="block text-2xs font-medium uppercase tracking-wide text-ink-500"
          >
            {field.label}
          </label>
          <input
            id={field.name}
            name={field.name}
            type="password"
            autoComplete={field.autoComplete}
            required
            minLength={field.name === "currentPassword" ? undefined : rules.minLength}
            maxLength={rules.maxLength}
            aria-invalid={state.field === field.name || undefined}
            className="mt-1 h-8 w-full rounded-[4px] border border-ink-300 px-2 text-sm outline-none focus:border-[var(--color-accent)] aria-invalid:border-[var(--color-tone-danger)]"
          />
          {field.name === "newPassword" ? (
            <p className="mt-1 text-2xs text-ink-500">{rules.description}</p>
          ) : null}
        </div>
      ))}

      {state.error ? (
        <p
          role="alert"
          className="rounded-[4px] bg-[var(--color-tone-danger-bg)] px-2 py-1.5 text-xs text-[var(--color-tone-danger)]"
        >
          {state.error}
        </p>
      ) : null}
      {state.ok && state.message ? <Note tone="success">{state.message}</Note> : null}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
