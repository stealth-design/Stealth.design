"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/primitives";
import { type AuthFormState, signInAction } from "@/lib/actions/auth";

const INITIAL: AuthFormState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signInAction, INITIAL);

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-md border border-ink-200 bg-surface p-4 shadow-sm"
    >
      <input type="hidden" name="next" value={next} />

      <div>
        <label htmlFor="email" className="block text-2xs font-medium uppercase tracking-wide text-ink-500">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="mt-1 h-8 w-full rounded-[4px] border border-ink-300 px-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="block text-2xs font-medium uppercase tracking-wide text-ink-500"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 h-8 w-full rounded-[4px] border border-ink-300 px-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      {state.error ? (
        <p
          role="alert"
          className="rounded-[4px] bg-[var(--color-tone-danger-bg)] px-2 py-1.5 text-xs text-[var(--color-tone-danger)]"
        >
          {state.error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={pending} className="h-8 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
