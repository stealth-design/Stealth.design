/**
 * Changing your own password.
 *
 * Against a real Postgres, because the behaviour worth protecting is about
 * which writes survive which failures: a wrong current password must still
 * count toward lockout even though the change itself is refused, and a
 * successful change must sign out every *other* session but not the one that
 * made it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type Database,
  type DatabaseHandle,
  auditEvents,
  createDatabase,
  sessions,
  users,
} from "@uxd/database";
import { hashPassword, verifyPassword } from "@uxd/auth";
import { changeOwnPassword } from "@uxd/api";
import { AppError, addMs, createLogger, hours, sha256Hex, shortId, uuidv7 } from "@uxd/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const ORIGINAL = "original-password-for-tests";

let handle: DatabaseHandle;
let db: Database;
const createdUserIds: string[] = [];

before(async () => {
  handle = createDatabase({ url: DATABASE_URL, poolMax: 5, applicationName: "uxd-account-test" });
  const ping = await handle.ping();
  assert.ok(
    ping.ok,
    `These tests need a database. Start one with \`npm run db:serve\`. (${ping.error ?? ""})`,
  );
  db = handle.db;
});

after(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(auditEvents).where(inArray(auditEvents.entityId, createdUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await handle.close();
});

/** A user with two live sessions: "this browser" and "another browser". */
async function fixture() {
  const id = uuidv7();
  const email = `account-test-${shortId()}@localhost`;
  await db.insert(users).values({
    id,
    email,
    name: "Account Test",
    role: "viewer",
    status: "active",
    passwordHash: await hashPassword(ORIGINAL),
    passwordChangedAt: new Date(),
  });
  createdUserIds.push(id);

  const thisSession = sha256Hex(`this-${id}`);
  const otherSession = sha256Hex(`other-${id}`);
  const expiresAt = addMs(new Date(), hours(1));
  await db.insert(sessions).values([
    { id: thisSession, userId: id, expiresAt },
    { id: otherSession, userId: id, expiresAt },
  ]);

  const context = {
    db,
    logger: createLogger({ service: "account-test", level: "error", format: "json" }),
    requestId: uuidv7(),
    ip: null,
    userAgent: null,
    actor: { id, email, name: "Account Test", role: "viewer" as const },
  } as never;

  return { id, context, thisSession, otherSession };
}

async function row(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user!;
}

async function liveSessionIds(userId: string) {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  return rows.map((r) => r.id);
}

describe("changeOwnPassword", () => {
  it("changes the password, keeps this session and signs out the others", async () => {
    const { id, context, thisSession } = await fixture();

    const result = await changeOwnPassword(context, {
      currentPassword: ORIGINAL,
      newPassword: "a-brand-new-passphrase",
      currentSessionId: thisSession,
    });

    assert.equal(result.revokedSessions, 1);
    const user = await row(id);
    assert.ok(await verifyPassword("a-brand-new-passphrase", user.passwordHash));
    assert.equal(await verifyPassword(ORIGINAL, user.passwordHash), false);
    assert.deepEqual(await liveSessionIds(id), [thisSession]);

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, id));
    assert.deepEqual(
      audit.map((a) => a.action),
      ["user.password_changed"],
    );
  });

  it("refuses a wrong current password, and counts it toward lockout", async () => {
    const { id, context, thisSession } = await fixture();

    await assert.rejects(
      changeOwnPassword(context, {
        currentPassword: "not-the-password",
        newPassword: "a-brand-new-passphrase",
        currentSessionId: thisSession,
      }),
      (error: unknown) => AppError.is(error) && error.issues?.[0]?.path === "currentPassword",
    );

    const user = await row(id);
    assert.equal(user.failedLoginCount, 1, "the attempt is recorded despite the refusal");
    assert.ok(await verifyPassword(ORIGINAL, user.passwordHash), "the password is unchanged");
    assert.equal((await liveSessionIds(id)).length, 2, "no session is revoked");
  });

  it("refuses while the account is locked, even with the right password", async () => {
    const { id, context } = await fixture();
    await db
      .update(users)
      .set({ lockedUntil: addMs(new Date(), hours(1)) })
      .where(eq(users.id, id));

    await assert.rejects(
      changeOwnPassword(context, { currentPassword: ORIGINAL, newPassword: "a-brand-new-passphrase" }),
      (error: unknown) => AppError.is(error) && error.code === "RATE_LIMITED",
    );
  });

  it("refuses a weak or unchanged new password", async () => {
    const { context } = await fixture();

    for (const newPassword of ["short", ORIGINAL]) {
      await assert.rejects(
        changeOwnPassword(context, { currentPassword: ORIGINAL, newPassword }),
        (error: unknown) => AppError.is(error) && error.issues?.[0]?.path === "newPassword",
      );
    }
  });
});
