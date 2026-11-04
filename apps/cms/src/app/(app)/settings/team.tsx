"use client";

import { useState, useTransition } from "react";
import { Check, Copy, UserPlus, X } from "lucide-react";
import clsx from "clsx";
import { TEAM_ROLES, TEAM_ROLE_META, type TeamRole } from "@uxd/types";
import {
  addTeamMemberAction,
  changeTeamRoleAction,
  resetTeamPasswordAction,
  setTeamMemberActiveAction,
} from "@/lib/actions/team";

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly status: "invited" | "active" | "suspended";
  readonly lastSeen: string | null;
}

/**
 * The team: who can sign in, and as what. Adding someone hands the admin a
 * one-time password to pass on — there is no email yet — shown once, here.
 */
export function Team({
  currentUserId,
  canManage,
  members,
}: {
  currentUserId: string;
  canManage: boolean;
  members: readonly Member[];
}) {
  const [adding, setAdding] = useState(false);
  const [handover, setHandover] = useState<{ name: string; email: string; password: string; reset: boolean } | null>(null);

  return (
    <section aria-labelledby="team-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="team-heading" className="text-[15px] font-medium text-ink-900">
            Team
          </h2>
          <p className="mt-1 text-[13px] text-ink-500">
            Admins can do everything. Researchers capture and tag, but can&apos;t publish.
          </p>
        </div>
        {canManage && !adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setHandover(null);
            }}
            className="flex h-8 items-center gap-1.5 rounded-md bg-ink-900 px-3 text-xs font-medium text-ink-50 transition-colors hover:bg-ink-950"
          >
            <UserPlus aria-hidden className="size-3.5" />
            Add person
          </button>
        ) : null}
      </div>

      {handover ? <Handover {...handover} onDone={() => setHandover(null)} /> : null}

      {adding ? (
        <AddPerson
          onCancel={() => setAdding(false)}
          onAdded={(person) => {
            setAdding(false);
            setHandover({ ...person, reset: false });
          }}
        />
      ) : null}

      <ul className="mt-5 divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200">
        {members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            isYou={member.id === currentUserId}
            canManage={canManage}
            onReset={(password) => setHandover({ name: member.name, email: member.email, password, reset: true })}
          />
        ))}
      </ul>
    </section>
  );
}

function AddPerson({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (person: { name: string; email: string; password: string }) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("researcher");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          const result = await addTeamMemberAction({ name, email, role });
          if (result.ok && result.temporaryPassword) onAdded({ name, email, password: result.temporaryPassword });
          else setError(result.error);
        });
      }}
      className="mt-5 rounded-xl border border-ink-200 bg-surface p-5"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-ink-600">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink-600">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none"
          />
        </label>
      </div>

      <div role="radiogroup" aria-label="Role" className="mt-4 grid gap-2 sm:grid-cols-2">
        {TEAM_ROLES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={role === value}
            onClick={() => setRole(value)}
            className={clsx(
              "rounded-lg border p-3 text-left transition-colors",
              role === value ? "border-ink-500 bg-ink-100" : "border-ink-200 hover:border-ink-300",
            )}
          >
            <span className="block text-[13px] font-medium text-ink-900">{TEAM_ROLE_META[value].label}</span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-500">{TEAM_ROLE_META[value].description}</span>
          </button>
        ))}
      </div>

      {error ? <p className="mt-3 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-md px-3 text-xs text-ink-600 hover:bg-ink-100 hover:text-ink-900"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !name.trim() || !email.trim()}
          className="h-8 rounded-md bg-ink-900 px-4 text-xs font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-40"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}

/** The one-time password, shown once, with what to tell the person. */
function Handover({
  name,
  email,
  password,
  reset,
  onDone,
}: {
  name: string;
  email: string;
  password: string;
  reset: boolean;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const loginUrl = typeof window === "undefined" ? "/login" : `${window.location.origin}/login`;
  const message = `Sign in at ${loginUrl}\nEmail: ${email}\nPassword: ${password}\nChange the password from your account page once you're in.`;

  return (
    <div className="mt-5 rounded-xl border border-ink-300 bg-[var(--color-tone-success-bg)] p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink-900">
            {reset ? `New password for ${name}.` : `${name} is on the team.`} Send them this — it&apos;s shown only once.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-ink-50 p-3 font-mono text-xs leading-relaxed text-ink-800">
            {message}
          </pre>
        </div>
        <button
          type="button"
          onClick={onDone}
          aria-label="Done"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            .writeText(message)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        className="mt-3 flex h-8 items-center gap-1.5 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
      >
        {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
        {copied ? "Copied" : "Copy message"}
      </button>
    </div>
  );
}

function MemberRow({
  member,
  isYou,
  canManage,
  onReset,
}: {
  member: Member;
  isYou: boolean;
  canManage: boolean;
  onReset: (password: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"suspend" | "reset" | null>(null);
  const [pending, start] = useTransition();
  const suspended = member.status === "suspended";
  const isTeamRole = (TEAM_ROLES as readonly string[]).includes(member.role);
  const editable = canManage && !isYou;
  // A role change is picked, then saved — never applied by the dropdown alone.
  const [role, setRole] = useState(isTeamRole ? member.role : "");
  const roleChanged = role !== "" && role !== member.role;

  const run = (task: () => Promise<{ ok: boolean; error: string | null; temporaryPassword?: string }>) =>
    start(async () => {
      const result = await task();
      setConfirm(null);
      if (!result.ok) setError(result.error);
      else {
        setError(null);
        if (result.temporaryPassword) onReset(result.temporaryPassword);
      }
    });

  return (
    <li className={clsx("flex flex-wrap items-center gap-x-4 gap-y-2 p-4", suspended && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink-900">
          {member.name}
          {isYou ? <span className="text-ink-500"> (you)</span> : null}
          {suspended ? <span className="ml-2 text-[11px] text-[var(--color-tone-warning)]">Suspended</span> : null}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-500">
          {member.email}
          {member.lastSeen ? ` · last signed in ${member.lastSeen}` : " · never signed in"}
        </p>
        {error ? <p className="mt-1 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}
      </div>

      {editable ? (
        <span className="flex items-center gap-2">
        <select
          value={role}
          disabled={pending}
          onChange={(event) => setRole(event.target.value)}
          aria-label={`Role for ${member.name}`}
          className="h-8 rounded-md border border-ink-200 bg-surface px-2 text-xs text-ink-900 outline-none focus:border-ink-400"
        >
          {!isTeamRole ? (
            <option value="" disabled>
              {member.role} (old role)
            </option>
          ) : null}
          {TEAM_ROLES.map((value) => (
            <option key={value} value={value}>
              {TEAM_ROLE_META[value].label}
            </option>
          ))}
        </select>
        {roleChanged ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => changeTeamRoleAction(member.id, role))}
              className="h-8 rounded-md bg-ink-900 px-3 text-xs font-medium text-ink-50 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setRole(isTeamRole ? member.role : "")}
              className="h-8 rounded-md px-2.5 text-xs text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            >
              Cancel
            </button>
          </>
        ) : null}
        </span>
      ) : (
        <span className="text-xs text-ink-700">
          {isTeamRole ? TEAM_ROLE_META[member.role as TeamRole].label : member.role}
        </span>
      )}

      {editable ? (
        confirm ? (
          <span className="flex items-center gap-2">
            <span className="text-xs text-ink-600">
              {confirm === "reset" ? "Sign them out and make a new password?" : "Suspend and sign them out?"}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  confirm === "reset" ? resetTeamPasswordAction(member.id) : setTeamMemberActiveAction(member.id, false),
                )
              }
              className="h-7 rounded-md bg-[var(--color-tone-danger)] px-2.5 text-xs font-medium text-ink-50 disabled:opacity-60"
            >
              {confirm === "reset" ? "Reset" : "Suspend"}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="h-7 rounded-md border border-ink-300 px-2.5 text-xs text-ink-800 hover:bg-ink-100"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            {!suspended ? (
              <button
                type="button"
                onClick={() => setConfirm("reset")}
                className="h-7 rounded-md px-2.5 text-xs text-ink-600 hover:bg-ink-100 hover:text-ink-900"
              >
                Reset password
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => (suspended ? run(() => setTeamMemberActiveAction(member.id, true)) : setConfirm("suspend"))}
              className="h-7 rounded-md px-2.5 text-xs text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            >
              {suspended ? "Let back in" : "Suspend"}
            </button>
          </span>
        )
      ) : null}
    </li>
  );
}
