"use server";

/**
 * Settings actions (§21, §37).
 *
 * The per-key schema in `@uxd/api` is the authority on what a value may be, so
 * these do no validation of their own — they hand the value over and translate
 * the refusal into something the editor can show next to the field.
 */
import { refresh } from "next/cache";
import { resetSetting, updateSetting } from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContext } from "@/lib/server";

export interface SettingActionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly issues: readonly { path: string; message: string }[];
}

export async function updateSettingAction(
  key: string,
  value: unknown,
): Promise<SettingActionResult> {
  try {
    const context = await getAdminContext();
    await updateSetting(context, key, value);
    refresh();
    return { ok: true, message: "Saved.", error: null, issues: [] };
  } catch (error) {
    return {
      ok: false,
      message: null,
      error: AppError.is(error) ? error.publicMessage : "Could not save that setting.",
      issues: AppError.is(error) ? (error.issues ?? []) : [],
    };
  }
}

export async function resetSettingAction(key: string): Promise<SettingActionResult> {
  try {
    const context = await getAdminContext();
    await resetSetting(context, key);
    refresh();
    return { ok: true, message: "Back to the default.", error: null, issues: [] };
  } catch (error) {
    return {
      ok: false,
      message: null,
      error: AppError.is(error) ? error.publicMessage : "Could not reset that setting.",
      issues: AppError.is(error) ? (error.issues ?? []) : [],
    };
  }
}
