"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ImageOff, Search, Upload, X } from "lucide-react";
import { SaveBar } from "@/components/save-bar";
import { findLogoAction, saveLogoAction, setWebsiteIndustryAction, uploadLogoAction } from "@/lib/actions/products";

type Logo = { readonly mediaId: string; readonly url: string | null; readonly origin?: string | null } | null;

export interface WebsiteProfileData {
  readonly industryId: string | null;
  readonly industries: readonly { readonly id: string; readonly name: string; readonly depth: number }[];
  readonly canEdit: boolean;
  readonly logo: Logo;
  readonly canEditLogo: boolean;
}

const ORIGIN_LABEL: Record<string, string> = {
  icon: "Found automatically — the website's app icon",
  header: "Found automatically — from the page header",
  manual: "Chosen by hand",
};

/**
 * What describes the website itself, not any one screen of it: its logo and
 * its industry. Set once, used everywhere the website appears. Saved with a
 * button, like every other edit — finding or uploading a logo only proposes
 * it until Save.
 */
export function WebsiteProfile({ productId, profile }: { productId: string; profile: WebsiteProfileData }) {
  const [savedIndustry, setSavedIndustry] = useState(profile.industryId ?? "");
  const [industry, setIndustry] = useState(profile.industryId ?? "");
  const [savedLogo, setSavedLogo] = useState<Logo>(profile.logo);
  const [logo, setLogo] = useState<Logo>(profile.logo);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [working, startWorking] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const logoChanged = (logo?.mediaId ?? null) !== (savedLogo?.mediaId ?? null);
  const dirty = industry !== savedIndustry || logoChanged;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const propose = (result: { ok: boolean; error: string | null; mediaId?: string; url?: string | null }, how: string) => {
    if (result.ok && result.mediaId) {
      setLogo({ mediaId: result.mediaId, url: result.url ?? null, origin: "manual" });
      setError(null);
      setNote(how);
    } else {
      setError(result.error);
    }
  };

  const save = () =>
    startSaving(async () => {
      const failures: string[] = [];
      if (industry !== savedIndustry) {
        const result = await setWebsiteIndustryAction(productId, industry || null);
        if (result.ok) setSavedIndustry(industry);
        else failures.push(result.error ?? "The industry didn't save.");
      }
      if (logoChanged) {
        const result = await saveLogoAction(productId, logo?.mediaId ?? null);
        if (result.ok) setSavedLogo(logo);
        else failures.push(result.error ?? "The logo didn't save.");
      }
      setError(failures[0] ?? null);
      if (failures.length === 0) setNote(null);
    });

  const shownOrigin = logoChanged ? (note ?? "Not saved yet") : logo?.origin ? ORIGIN_LABEL[logo.origin] : null;

  return (
    <section
      aria-label="Website profile"
      className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-ink-200 px-4 py-4 md:px-6"
    >
      {/* --- Logo ---------------------------------------------------------- */}
      <div className="flex items-end gap-3">
        <div>
          <span className="text-xs text-ink-600">Logo</span>
          <div className="mt-1.5 flex size-16 items-center justify-center overflow-hidden rounded-lg border border-ink-200 bg-[repeating-conic-gradient(var(--color-ink-100)_0%_25%,transparent_0%_50%)] bg-[length:12px_12px]">
            {logo?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo.url} alt="" className="max-h-full max-w-full object-contain p-1" />
            ) : (
              <ImageOff aria-hidden className="size-4 text-ink-400" />
            )}
          </div>
        </div>
        {profile.canEditLogo ? (
          <div className="flex flex-col gap-1 pb-0.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={working || saving}
                onClick={() =>
                  startWorking(async () => propose(await findLogoAction(productId), "Found on the website — not saved yet"))
                }
                className="flex h-7 items-center gap-1.5 rounded-md border border-ink-200 px-2.5 text-[11px] text-ink-700 hover:border-ink-300 hover:text-ink-900 disabled:opacity-50"
              >
                <Search aria-hidden className="size-3" />
                {working ? "Looking…" : "Find on website"}
              </button>
              <button
                type="button"
                disabled={working || saving}
                onClick={() => fileRef.current?.click()}
                className="flex h-7 items-center gap-1.5 rounded-md border border-ink-200 px-2.5 text-[11px] text-ink-700 hover:border-ink-300 hover:text-ink-900 disabled:opacity-50"
              >
                <Upload aria-hidden className="size-3" />
                Upload
              </button>
              {logo ? (
                <button
                  type="button"
                  disabled={working || saving}
                  onClick={() => {
                    setLogo(null);
                    setNote("Removed — not saved yet");
                  }}
                  aria-label="Remove the logo"
                  className="flex size-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  const form = new FormData();
                  form.set("file", file);
                  startWorking(async () => propose(await uploadLogoAction(form), "Uploaded — not saved yet"));
                }}
              />
            </div>
            <p className="text-[11px] text-ink-500">{shownOrigin ?? (logo ? null : "No logo yet")}</p>
          </div>
        ) : null}
      </div>

      {/* --- Industry ------------------------------------------------------ */}
      <label className="block">
        <span className="text-xs text-ink-600">Industry</span>
        <select
          value={industry}
          disabled={!profile.canEdit || saving}
          onChange={(event) => setIndustry(event.target.value)}
          className="mt-1.5 block h-9 w-56 rounded-lg border border-ink-200 bg-ink-50 px-2.5 text-[13px] text-ink-900 outline-none focus:border-ink-400 disabled:opacity-60"
        >
          <option value="">Not set</option>
          {profile.industries.map((option) => (
            <option key={option.id} value={option.id}>
              {" ".repeat(option.depth)}
              {option.name}
            </option>
          ))}
        </select>
      </label>

      <p className="max-w-xs pb-2 text-xs text-ink-500">For the whole website — every screen from it shows these.</p>

      {profile.canEdit || profile.canEditLogo ? (
        <SaveBar
          dirty={dirty}
          saving={saving}
          error={error}
          onDiscard={() => {
            setIndustry(savedIndustry);
            setLogo(savedLogo);
            setError(null);
            setNote(null);
          }}
          onSave={save}
          className="ml-auto min-w-64 pb-0.5"
        />
      ) : null}
    </section>
  );
}
