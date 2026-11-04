"use client";

import { useState, useTransition } from "react";
import { ArrowRight, Monitor, Plus, Smartphone } from "lucide-react";
import clsx from "clsx";
import type { StudioProfile } from "@uxd/types";
import { captureScreenAction } from "@/lib/actions/discovery";
import type { TagOption } from "@/components/tag-picker";
import { CaptureStart, type CaptureChoice } from "./capture-start";

/**
 * Open the studio with what the researcher chose in "What are you capturing?".
 * Redirects on success, so a result only ever means failure.
 */
function useStartCapture(sourceId: string) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const begin = (url: string, profile: StudioProfile, choice: CaptureChoice) => {
    setError(null);
    start(async () => {
      const result = await captureScreenAction({
        url,
        profile,
        sourceId,
        termIds: choice.termIds,
        ...(choice.mode === "flow" && choice.flowName ? { flowName: choice.flowName } : {}),
      });
      if (!result.ok) setError(result.error);
    });
  };
  return { pending, error, begin, clearError: () => setError(null) };
}

/**
 * The main action on a product's page: open the live browser on one of its
 * addresses. The product's own origin is fixed, so a researcher types only the
 * part that changes — or pastes a whole address, which is taken as it is.
 */
export function CaptureBox({
  sourceId,
  origin,
  host,
  tags,
}: {
  sourceId: string;
  origin: string;
  host: string;
  tags: readonly TagOption[];
}) {
  const [path, setPath] = useState("");
  const [profile, setProfile] = useState<StudioProfile>("desktop_1440");
  const [asking, setAsking] = useState<string | null>(null);
  const { pending, error, begin, clearError } = useStartCapture(sourceId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    clearError();
    const raw = path.trim();
    setAsking(/^https?:\/\//i.test(raw) ? raw : `${origin}/${raw.replace(/^\/+/, "")}`);
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-ink-200 bg-surface p-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 items-center rounded-lg pl-3 focus-within:bg-ink-100">
          <span className="shrink-0 font-mono text-[13px] text-ink-500">{host}/</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="home page, or a path like upload"
            aria-label={`Address on ${host} to capture`}
            autoComplete="off"
            spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-transparent pl-0.5 font-mono text-[13px] text-ink-900 outline-none placeholder:font-sans placeholder:text-ink-400 focus-visible:outline-none"
          />
        </label>

        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Device" className="flex h-10 items-center rounded-lg border border-ink-200 p-0.5">
            <DeviceOption active={profile === "desktop_1440"} onClick={() => setProfile("desktop_1440")} label="Desktop">
              <Monitor aria-hidden className="size-3.5" />
            </DeviceOption>
            <DeviceOption active={profile === "mobile_390"} onClick={() => setProfile("mobile_390")} label="Mobile">
              <Smartphone aria-hidden className="size-3.5" />
            </DeviceOption>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-ink-900 px-4 text-[13px] font-medium whitespace-nowrap text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-60 sm:flex-none"
          >
            {pending ? "Opening browser…" : "Capture screens"}
            <ArrowRight aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
      <p className="px-3 pb-1 pt-2 text-xs text-ink-500">
        Opens the page in our browser. Scroll or click to the state you want, then press Capture — once for each
        state.
      </p>
      {asking ? (
        <CaptureStart
          address={asking}
          tags={tags}
          pending={pending}
          error={error}
          onStart={(choice) => begin(asking, profile, choice)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </form>
  );
}

function DeviceOption({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={clsx(
        "flex h-full items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
        active ? "bg-ink-200 text-ink-900" : "text-ink-500 hover:text-ink-800",
      )}
    >
      {children}
      {label}
    </button>
  );
}

/** Capture another state of a page that already has some — straight to its address. */
export function CaptureAgain({
  sourceId,
  url,
  profile,
  tags,
}: {
  sourceId: string;
  url: string;
  profile: StudioProfile;
  tags: readonly TagOption[];
}) {
  const [asking, setAsking] = useState(false);
  const { pending, error, begin } = useStartCapture(sourceId);

  return (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-ink-200 px-2.5 text-xs text-ink-700 transition-colors hover:border-ink-300 hover:bg-ink-100 hover:text-ink-900"
      >
        <Plus aria-hidden className="size-3" />
        Capture a state
      </button>
      {asking ? (
        <CaptureStart
          address={url}
          tags={tags}
          pending={pending}
          error={error}
          onStart={(choice) => begin(url, profile, choice)}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}
