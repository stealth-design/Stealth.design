"use server";

/**
 * Sign-in, sign-out, and changing your own password.
 *
 * Sign-in and sign-out are the only server actions that run without an
 * authenticated actor. Both write an audit event — including failures, because
 * a run of failed sign-ins is exactly the thing an operator should be able to
 * see afterwards. Lockout after repeated failures is handled inside `signIn`,
 * on the user row, so it survives a process restart.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, sessionCookieOptions, signIn, signOut } from "@uxd/auth";
import { changeOwnPassword, recordAudit } from "@uxd/api";
import { AppError, hours, sha256Hex } from "@uxd/shared";
import { getAdminContext, getBaseContext, getDb, getEnv, getLogger } from "@/lib/server";

export interface AuthFormState {
  readonly error: string | null;
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (email.length === 0 || password.length === 0) {
    return { error: "Enter your email address and password." };
  }

  const env = await getEnv();
  const db = await getDb();
  const logger = await getLogger();
  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerList.get("user-agent");

  try {
    const result = await signIn(
      db,
      { ttlMs: hours(env.SESSION_TTL_HOURS), cookieSecure: env.SESSION_COOKIE_SECURE, logger },
      { email, password, ip, userAgent },
    );

    const options = sessionCookieOptions({
      ttlMs: hours(env.SESSION_TTL_HOURS),
      cookieSecure: env.SESSION_COOKIE_SECURE,
    });
    const cookieStore = await cookies();
    cookieStore.set(options.name, result.token, {
      httpOnly: options.httpOnly,
      sameSite: options.sameSite,
      secure: options.secure,
      path: options.path,
      maxAge: options.maxAge,
    });

    const context = await getBaseContext();
    await recordAudit(
      db,
      { ...context, actor: result.actor },
      {
        action: "auth.login",
        entityType: "session",
        entityId: result.actor.id,
        entityLabel: result.actor.email,
      },
    );
  } catch (error) {
    const base = await getBaseContext();
    await recordAudit(db, base, {
      action: "auth.login_failed",
      entityType: "session",
      entityId: null,
      entityLabel: email,
      context: { reason: AppError.is(error) ? error.code : "unknown" },
    }).catch(() => {});

    return {
      error: AppError.is(error)
        ? error.publicMessage
        : "Could not sign you in. Try again in a moment.",
    };
  }

  // Only relative paths, so a crafted `next` cannot bounce a signed-in
  // operator to an external site.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export interface ChangePasswordFormState {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
  /** Which field the error belongs to, so the form can mark it. */
  readonly field: string | null;
}

export async function changePasswordAction(
  _previous: ChangePasswordFormState,
  formData: FormData,
): Promise<ChangePasswordFormState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword !== confirmPassword) {
    return { ok: false, message: null, error: "The new passwords do not match.", field: "confirmPassword" };
  }

  try {
    const context = await getAdminContext();
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    const { revokedSessions } = await changeOwnPassword(context, {
      currentPassword,
      newPassword,
      currentSessionId: token ? sha256Hex(token) : undefined,
    });
    return {
      ok: true,
      message:
        revokedSessions > 0
          ? `Password changed. Signed out ${revokedSessions} other ${revokedSessions === 1 ? "session" : "sessions"}.`
          : "Password changed.",
      error: null,
      field: null,
    };
  } catch (error) {
    return {
      ok: false,
      message: null,
      error: AppError.is(error) ? error.publicMessage : "Could not change your password.",
      field: AppError.is(error) ? (error.issues?.[0]?.path ?? null) : null,
    };
  }
}

export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const db = await getDb();

  if (token) {
    const context = await getBaseContext();
    await recordAudit(db, context, {
      action: "auth.logout",
      entityType: "session",
      entityId: null,
    }).catch(() => {});
    await signOut(db, token);
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect("/login");
}
