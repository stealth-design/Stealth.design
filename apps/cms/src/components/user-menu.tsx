"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import { signOutAction } from "@/lib/actions/auth";

/** The account, at the foot of the sidebar. The menu opens upwards. */
export function UserMenu({
  name,
  email,
  roleLabel,
  roleSummary,
}: {
  name: string;
  email: string;
  roleLabel: string;
  roleSummary: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-ink-100"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-200 text-[11px] font-medium text-ink-800">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink-900">{name}</span>
          {/* The role is always visible, because what an operator can do
              differs by role and "why is that button missing" is otherwise a
              confusing question to answer. */}
          <span className="block truncate text-[11px] text-ink-500">{roleLabel}</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-ink-400" />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute bottom-full left-0 right-0 z-20 mb-1 rounded-lg border border-ink-200 bg-surface p-1 shadow-2xl shadow-black/50"
          >
            <div className="px-2 pb-2 pt-1.5">
              <p className="truncate font-mono text-[11px] text-ink-500">{email}</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
                <span className="text-ink-700">{roleLabel}</span> — {roleSummary}
              </p>
            </div>
            <div className="h-px bg-ink-200" />
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-ink-700 hover:bg-ink-100 hover:text-ink-900"
            >
              <UserRound aria-hidden className="size-3.5 text-ink-500" />
              Account and password
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-ink-700 hover:bg-ink-100 hover:text-ink-900"
              >
                <LogOut aria-hidden className="size-3.5 text-ink-500" />
                Sign out
              </button>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
}
