/**
 * The team: who can sign in, and as what.
 *
 * Admin only. Adding someone, changing their role, suspending them and
 * resetting their password all require `users.manage`, which only the admin
 * role holds — the people who capture cannot hand themselves more access.
 *
 * There is no email service yet, so adding someone (or resetting their
 * password) returns a one-time password for the admin to pass on. It is shown
 * once and stored only as a hash; the person changes it from their account
 * page after signing in.
 *
 * Two rules keep the team from locking itself out: nobody can change their
 * own role or suspend themselves, and the last active admin cannot be demoted
 * or suspended by anyone.
 */
import { randomInt } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { hashPassword, requirePermission, revokeAllSessions } from "@uxd/auth";
import { users } from "@uxd/database";
import { AppError, ErrorCode, notFound, sanitizeText, uuidv7 } from "@uxd/shared";
import { TEAM_ROLES, type Role, type TeamRole } from "@uxd/types";
import { recordAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";

export interface TeamMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly status: "invited" | "active" | "suspended";
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export async function listTeam(context: AdminContext): Promise<TeamMember[]> {
  requirePermission(context.actor, "users.read");
  return context.db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(sql`${users.status} = 'suspended'`, asc(users.name));
}

/** Add someone. Returns the one-time password to give them. */
export async function addTeamMember(
  context: AdminContext,
  input: { name: string; email: string; role: string },
): Promise<{ userId: string; temporaryPassword: string }> {
  requirePermission(context.actor, "users.manage");

  const name = sanitizeText(input.name, { maxLength: 120, singleLine: true });
  if (!name) throw fieldError("name", "Give them a name.");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw fieldError("email", "That doesn't look like an email address.");
  }
  const role = teamRole(input.role);

  const [taken] = await context.db
    .select({ id: users.id, deletedAt: users.deletedAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (taken) {
    throw fieldError(
      "email",
      taken.deletedAt ? "That email belonged to someone removed earlier. Use a different one." : "Someone with that email is already on the team.",
    );
  }

  const temporaryPassword = generatePassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const userId = uuidv7();

  await inTransaction(context, async (tx) => {
    await tx.db.insert(users).values({
      id: userId,
      name,
      email,
      role,
      status: "active",
      passwordHash,
      passwordChangedAt: new Date(),
    });
    await recordAudit(tx.db, tx, {
      action: "user.created",
      entityType: "user",
      entityId: userId,
      entityLabel: email,
      after: { name, email, role },
    });
  });

  return { userId, temporaryPassword };
}

export async function changeTeamRole(context: AdminContext, userId: string, nextRole: string): Promise<void> {
  requirePermission(context.actor, "users.manage");
  const role = teamRole(nextRole);
  if (userId === context.actor.id) {
    throw new AppError(ErrorCode.CONFLICT, "You can't change your own role. Ask another admin.");
  }

  await inTransaction(context, async (tx) => {
    const member = await loadMember(tx, userId);
    if (member.role === role) return;
    if (member.role === "admin" && member.status === "active") await assertAnotherAdmin(tx, userId);

    await tx.db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
    await recordAudit(tx.db, tx, {
      action: "user.role_changed",
      entityType: "user",
      entityId: userId,
      entityLabel: member.email,
      before: { role: member.role },
      after: { role },
    });
  });
}

/** Suspend (signs them out everywhere) or let them back in. */
export async function setTeamMemberActive(context: AdminContext, userId: string, active: boolean): Promise<void> {
  requirePermission(context.actor, "users.manage");
  if (userId === context.actor.id) {
    throw new AppError(ErrorCode.CONFLICT, "You can't suspend yourself.");
  }

  await inTransaction(context, async (tx) => {
    const member = await loadMember(tx, userId);
    const status = active ? "active" : "suspended";
    if (member.status === status) return;
    if (!active && member.role === "admin") await assertAnotherAdmin(tx, userId);

    await tx.db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
    const revokedSessions = active ? 0 : await revokeAllSessions(tx.db, userId);
    await recordAudit(tx.db, tx, {
      action: active ? "user.updated" : "user.suspended",
      entityType: "user",
      entityId: userId,
      entityLabel: member.email,
      before: { status: member.status },
      after: { status },
      context: active ? { reactivated: true } : { revokedSessions },
    });
  });
}

/** A new one-time password. Signs them out everywhere and clears any lockout. */
export async function resetTeamMemberPassword(
  context: AdminContext,
  userId: string,
): Promise<{ temporaryPassword: string }> {
  requirePermission(context.actor, "users.manage");
  if (userId === context.actor.id) {
    throw new AppError(ErrorCode.CONFLICT, "Change your own password from your account page.");
  }

  const temporaryPassword = generatePassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await inTransaction(context, async (tx) => {
    const member = await loadMember(tx, userId);
    await tx.db
      .update(users)
      .set({ passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
    const revokedSessions = await revokeAllSessions(tx.db, userId);
    await recordAudit(tx.db, tx, {
      action: "user.password_changed",
      entityType: "user",
      entityId: userId,
      entityLabel: member.email,
      context: { resetByAdmin: true, revokedSessions },
    });
  });

  return { temporaryPassword };
}

// --- Helpers --------------------------------------------------------------

function teamRole(value: string): TeamRole {
  if ((TEAM_ROLES as readonly string[]).includes(value)) return value as TeamRole;
  throw fieldError("role", "Choose Admin or Researcher.");
}

async function loadMember(context: AdminContext, userId: string) {
  const [member] = await context.db
    .select({ id: users.id, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!member) throw notFound("Team member");
  return member;
}

/** Refuse to leave the team without an active admin. */
async function assertAnotherAdmin(context: AdminContext, exceptUserId: string): Promise<void> {
  const [row] = await context.db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        eq(users.status, "active"),
        isNull(users.deletedAt),
        ne(users.id, exceptUserId),
      ),
    );
  if ((row?.n ?? 0) === 0) {
    throw new AppError(ErrorCode.CONFLICT, "This is the only active admin. Make someone else an admin first.");
  }
}

/**
 * Sixteen characters in four groups, from an alphabet without look-alikes
 * (no 0/O, 1/l/I), so it can be read out or retyped without mistakes.
 */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(""),
  );
  return groups.join("-");
}

function fieldError(path: string, message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, message, { issues: [{ path, message }] });
}
