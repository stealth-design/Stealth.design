"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ArrowRight, Globe, List } from "lucide-react";
import clsx from "clsx";
import { addProductAction, type AddProductState } from "@/lib/actions/products";
import { AddSeveral } from "./add-several";

const INITIAL: AddProductState = { ok: false, message: null, error: null };

type Mode = "one" | "several";

/**
 * The first thing on the Products page: add a website, or many.
 *
 * Two modes behind one switch, because they are the same job at different
 * sizes. One: paste an address, press Enter. Several: paste a list, check it,
 * add what you keep. Pasting a list into the single box switches over by
 * itself and carries the list across — nobody has to find the other mode.
 */
export function AddProduct() {
  const [state, action, pending] = useActionState(addProductAction, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<Mode>("one");
  const [pasted, setPasted] = useState("");

  // A success clears the field, ready for the next one.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <div>
      <div role="tablist" aria-label="How many to add" className="mb-2 inline-flex rounded-lg border border-ink-200 p-0.5">
        <ModeTab active={mode === "one"} onClick={() => setMode("one")} icon={<Globe aria-hidden className="size-3.5" />}>
          One website
        </ModeTab>
        <ModeTab
          active={mode === "several"}
          onClick={() => setMode("several")}
          icon={<List aria-hidden className="size-3.5" />}
        >
          Several at once
        </ModeTab>
      </div>

      {mode === "one" ? (
        <form ref={formRef} action={action}>
          <div className="flex items-center gap-3 rounded-xl border border-ink-200 bg-surface p-2 pl-4 transition-colors focus-within:border-ink-400">
            <Globe aria-hidden className="size-4 shrink-0 text-ink-500" />
            <input
              name="url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a website address"
              aria-label="Website address"
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (text.trim().includes("\n")) {
                  event.preventDefault();
                  setPasted(text);
                  setMode("several");
                }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-[15px] text-ink-900 outline-none placeholder:text-ink-400 focus-visible:outline-none"
            />
            <button
              type="submit"
              disabled={pending}
              className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-ink-900 px-4 text-[13px] font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-60"
            >
              {pending ? "Adding…" : "Add product"}
              <ArrowRight aria-hidden className="size-3.5" />
            </button>
          </div>
          <p
            role="status"
            className={clsx("mt-2 px-1 text-xs", state.error ? "text-[var(--color-tone-danger)]" : "text-ink-500")}
          >
            {state.error ?? state.message ?? "We find the name and set everything else up for you. Pasting a list switches to Several."}
          </p>
        </form>
      ) : (
        <AddSeveral
          key={pasted}
          initialText={pasted}
          onDone={() => {
            setPasted("");
            setMode("one");
          }}
        />
      )}
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        "flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors",
        active ? "bg-ink-200 text-ink-900" : "text-ink-500 hover:text-ink-900",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
