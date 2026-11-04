"use server";

/**
 * Team actions. Every rule — admin only, no self-demotion, never zero
 * admins — lives in the services; these translate their errors into a line
 * the Team page can show.
 */
import { refresh } from "next/cache";
import { addTeamMember, changeTeamRole, resetTeamMemberPassword, setTeamMemberActive } from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContext } from "@/lib/server";

export interface TeamActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  /** Shown once, for the admin to pass on. Never stored in plain text. */
  readonly temporaryPassword?: string;
}

const failed = (error: unknown, fallback: string): TeamActionResult => ({
  ok: false,
  error: AppError.is(error) ? error.publicMessage : fallback,
});

export async function addTeamMemberAction(input: {
  name: string;
  email: string;
  role: string;
}): Promise<TeamActionResult> {
  try {
    const { temporaryPassword } = await addTeamMember(await getAdminContext(), input);
    refresh();
    return { ok: true, error: null, temporaryPassword };
  } catch (error) {
    return failed(error, "That person couldn't be added.");
  }
}

export async function changeTeamRoleAction(userId: string, role: string): Promise<TeamActionResult> {
  try {
    await changeTeamRole(await getAdminContext(), userId, role);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "That role couldn't be changed.");
  }
}

export async function setTeamMemberActiveAction(userId: string, active: boolean): Promise<TeamActionResult> {
  try {
    await setTeamMemberActive(await getAdminContext(), userId, active);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, active ? "They couldn't be let back in." : "They couldn't be suspended.");
  }
}

export async function resetTeamPasswordAction(userId: string): Promise<TeamActionResult> {
  try {
    const { temporaryPassword } = await resetTeamMemberPassword(await getAdminContext(), userId);
    refresh();
    return { ok: true, error: null, temporaryPassword };
  } catch (error) {
    return failed(error, "That password couldn't be reset.");
  }
}
