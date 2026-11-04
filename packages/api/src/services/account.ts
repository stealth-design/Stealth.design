/**
 * The signed-in user's own account.
 *
 * Only self-service lives here: changing your own password. Managing other
 * people's accounts is `users.manage` and a different screen — this needs no
 * permission beyond being signed in, because every role has a password.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_LOGINS,
  hashPassword,
  revokeAllSessions,
  validatePasswordStrength,
  verifyPassword,
} from "@uxd/auth";
import { users } from "@uxd/database";
import { AppError, ErrorCode, addMs, unauthenticated } from "@uxd/shared";
import { recordAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
  /** The session making the request, which stays signed in. */
  readonly currentSessionId?: string;
}

export interface ChangePasswordResult {
  /** How many other browsers were signed out. */
  readonly revokedSessions: number;
}

/**
 * Change the actor's own password.
 *
 * Asks for the current password even though the caller is signed in: a
 * session cookie on an unattended machine should not be enough to take the
 * account over permanently.
 *
 * A wrong current password counts toward the same lockout as sign-in.
 * Otherwise this form would be an unthrottled guessing oracle for anyone
 * holding a stolen cookie. The counter is written *outside* the transaction
 * below, so the failure that rolls back the change does not also roll back
 * the record of the attempt.
 */
export async function changeOwnPassword(
  context: AdminContext,
  input: ChangePasswordInput,
): Promise<ChangePasswordResult> {
  const { db, actor } = context;

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(and(eq(users.id, actor.id), isNull(users.deletedAt)))
    .limit(1);
  if (!user) throw unauthenticated();

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(ErrorCode.RATE_LIMITED, "Too many failed attempts. Try again in a few minutes.");
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    const failedLoginCount = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount,
        lockedUntil:
          failedLoginCount >= MAX_FAILED_LOGINS ? addMs(new Date(), LOCKOUT_DURATION_MS) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    context.logger.warn("Password change refused: wrong current password", {
      userId: user.id,
      failedLoginCount,
    });
    throw fieldError("currentPassword", "Your current password is not correct.");
  }

  const strength = validatePasswordStrength(input.newPassword);
  if (!strength.ok) throw fieldError("newPassword", strength.message ?? "Choose a stronger password.");
  if (input.newPassword === input.currentPassword) {
    throw fieldError("newPassword", "Choose a password different from your current one.");
  }

  const passwordHash = await hashPassword(input.newPassword);

  return inTransaction(context, async (tx) => {
    await tx.db
      .update(users)
      .set({
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const revokedSessions = await revokeAllSessions(tx.db, user.id, {
      exceptSessionId: input.currentSessionId,
    });

    await recordAudit(tx.db, tx, {
      action: "user.password_changed",
      entityId: user.id,
      entityLabel: user.email,
      context: { revokedSessions },
    });

    return { revokedSessions };
  });
}

function fieldError(path: string, message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, message, { issues: [{ path, message }] });
}
