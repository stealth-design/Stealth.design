"use client";

import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { removeProductAction, renameProductAction } from "@/lib/actions/products";

/**
 * Edit, in a small panel under the button: correct the name, or take the
 * product off the list. Removing archives — nothing captured is lost, and
 * adding the address again brings it back — but it still asks first.
 */
export function EditProduct({ sourceId, name }: { sourceId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const close = () => {
    setOpen(false);
    setConfirmRemove(false);
    setError(null);
    setValue(name);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-md border border-ink-200 px-3 text-xs text-ink-700 transition-colors hover:border-ink-300 hover:bg-ink-100 hover:text-ink-900"
      >
        <Pencil aria-hidden className="size-3" />
        Edit
      </button>

      {open ? (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-10 cursor-default" onClick={close} />
          <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-ink-200 bg-surface p-4 shadow-2xl shadow-black/60">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                start(async () => {
                  const result = await renameProductAction(sourceId, value);
                  if (result.ok) setOpen(false);
                  else setError(result.error);
                });
              }}
            >
              <label className="block text-xs text-ink-500" htmlFor="product-name">
                Name
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="product-name"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-md border border-ink-200 bg-ink-50 px-2.5 text-[13px] text-ink-900 outline-none focus:border-ink-400 focus-visible:outline-none"
                />
                <button
                  type="submit"
                  disabled={pending || value.trim() === name || !value.trim()}
                  className="h-8 rounded-md bg-ink-900 px-3 text-xs font-medium text-ink-50 disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </form>

            {error ? <p className="mt-2 text-xs text-[var(--color-tone-danger)]">{error}</p> : null}

            <div className="mt-4 border-t border-ink-200 pt-3">
              {confirmRemove ? (
                <div>
                  <p className="text-xs leading-relaxed text-ink-600">
                    Take {name} off the Products list? Nothing captured is deleted, and adding its address again brings
                    it back.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const result = await removeProductAction(sourceId);
                          if (!result.ok) setError(result.error);
                        })
                      }
                      className="h-7 rounded-md bg-[var(--color-tone-danger)] px-3 text-xs font-medium text-ink-50 disabled:opacity-60"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      className="h-7 rounded-md border border-ink-300 px-3 text-xs text-ink-800 hover:bg-ink-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className="text-xs text-ink-500 hover:text-[var(--color-tone-danger)]"
                >
                  Remove from Products
                </button>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
