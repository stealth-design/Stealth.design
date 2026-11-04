/**
 * Capture-session lease tests.
 *
 * Against a real Postgres, for the same reason as the queue tests: the
 * behaviour under test *is* database behaviour — `FOR UPDATE SKIP LOCKED`
 * claiming, lease expiry, and how the driver types a column coming back from
 * raw SQL.
 *
 * That last one is why this file exists at all. `claimSession` returned
 * `expires_at` straight from `db.execute`, typed as a `Date` because the column
 * is a timestamp. It compiles, and it is wrong: raw SQL bypasses Drizzle's
 * column mappers, so the value arrives as a string and `toISOString()` throws
 * at the first real claim. Four passing type-level assumptions and no test
 * between them and production.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  type Database,
  type DatabaseHandle,
  captureSessionCommands,
  captureSessions,
  claimSession,
  createDatabase,
  expireStaleSessions,
  pendingCommands,
  touchSession,
} from "@uxd/database";
import { addMs, uuidv7 } from "@uxd/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

let handle: DatabaseHandle;
let db: Database;
const createdSessionIds: string[] = [];

before(async () => {
  handle = createDatabase({ url: DATABASE_URL, poolMax: 5, applicationName: "uxd-session-test" });
  const ping = await handle.ping();
  assert.ok(
    ping.ok,
    `These tests need a database. Start one with \`npm run db:serve\`. (${ping.error ?? ""})`,
  );
  db = handle.db;
});

after(async () => {
  if (createdSessionIds.length > 0) {
    await db.delete(captureSessions).where(inArray(captureSessions.id, createdSessionIds));
  }
  await handle?.close();
});

async function makeSession(
  overrides: Partial<typeof captureSessions.$inferInsert> = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(captureSessions).values({
    id,
    status: "pending",
    // Unique per session, so a test's session cannot be claimed by another
    // test's poll — these run against a shared development database.
    targetUrl: `https://session-test-${id.slice(0, 8)}.example.com/`,
    deviceProfile: "desktop_1440",
    deviceClass: "desktop",
    viewportWidth: 1440,
    viewportHeight: 900,
    deviceScaleFactor: 2,
    expiresAt: addMs(new Date(), 60 * 60_000),
    ...overrides,
  });
  createdSessionIds.push(id);
  return id;
}

/**
 * Claim, retrying past sessions that belong to other tests.
 *
 * These run against a shared development database that a real worker may be
 * polling, and a worker that wins the race takes the fixture out from under the
 * test. Losing it is not a defect — it is the lease protocol working — so the
 * helper makes a fresh session and tries again rather than failing. Without
 * this the suite passes or fails depending on whether someone left
 * `npm run dev:worker` running, which is the kind of flake people learn to
 * ignore.
 *
 * Returns null only when the session is genuinely unclaimable (the expiry
 * case), which is a real outcome one test asserts.
 */
async function claimOurs(
  sessionId: string,
  overrides: Partial<typeof captureSessions.$inferInsert> = {},
): Promise<{ claimed: Awaited<ReturnType<typeof claimSession>>; sessionId: string }> {
  let target = sessionId;

  for (let round = 0; round < 4; round += 1) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const claimed = await claimSession(db, { workerName: "test-worker" });
      if (!claimed) break;
      if (claimed.id === target) return { claimed, sessionId: target };
    }

    // Either nothing was claimable or a worker took ours. If the fixture is
    // gone, make another; if it is simply not claimable, say so.
    const [row] = await db.select().from(captureSessions).where(eq(captureSessions.id, target));
    if (row?.status === "pending") return { claimed: null, sessionId: target };
    if (row?.workerName === "test-worker") return { claimed: null, sessionId: target };
    target = await makeSession(overrides);
  }

  return { claimed: null, sessionId: target };
}

describe("claimSession — a worker takes a waiting session", () => {
  it("returns expiresAt as a real Date, not the driver's string", async () => {
    const { claimed } = await claimOurs(await makeSession());

    assert.ok(claimed, "the session should have been claimable");
    assert.ok(
      claimed.expiresAt instanceof Date,
      "expiresAt must be a Date — the control plane calls toISOString() on it",
    );
    assert.ok(
      Number.isFinite(claimed.expiresAt.getTime()),
      "expiresAt must be a valid Date, not Invalid Date from a failed parse",
    );
    // The whole point: this is what the control plane actually does with it.
    assert.doesNotThrow(() => claimed.expiresAt.toISOString());
  });

  it("moves the session to starting and records the worker", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    const [row] = await db.select().from(captureSessions).where(eq(captureSessions.id, id));
    assert.equal(row?.status, "starting");
    assert.equal(row?.workerName, "test-worker");
    assert.equal(row?.leaseToken, claimed.leaseToken);
    assert.ok(row?.startedAt, "startedAt should be stamped at claim time");
  });

  it("hands the profile through unchanged, so the worker builds the right context", async () => {
    const mobile = {
      deviceProfile: "mobile_390",
      deviceClass: "mobile" as const,
      viewportWidth: 390,
      viewportHeight: 844,
      deviceScaleFactor: 3,
    };
    const { claimed } = await claimOurs(await makeSession(mobile), mobile);
    assert.ok(claimed);

    assert.equal(claimed.deviceProfile, "mobile_390");
    assert.equal(claimed.viewportWidth, 390);
    assert.equal(claimed.deviceScaleFactor, 3);
  });

  it("never hands the same session to two workers", async () => {
    const made = await makeSession();
    const { claimed: first, sessionId: id } = await claimOurs(made);
    assert.ok(first);

    // A second claim must not return this session again: it is no longer
    // `pending`, which is what the partial index and the status filter enforce.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const second = await claimSession(db, { workerName: "other-worker" });
      if (!second) break;
      assert.notEqual(second.id, id, "a claimed session must not be claimable again");
    }
  });

  it("skips a session whose hard expiry has already passed", async () => {
    const { claimed } = await claimOurs(
      await makeSession({ expiresAt: addMs(new Date(), -1_000) }),
      { expiresAt: addMs(new Date(), -1_000) },
    );
    assert.equal(claimed, null, "an expired session should never be handed to a worker");
  });
});

describe("touchSession — proving the worker still owns it", () => {
  it("accepts the right token and pushes the lease out", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    const before = (await db.select().from(captureSessions).where(eq(captureSessions.id, id)))[0];
    const accepted = await touchSession(db, id, claimed.leaseToken);
    const after = (await db.select().from(captureSessions).where(eq(captureSessions.id, id)))[0];

    assert.equal(accepted, true);
    assert.ok(
      (after?.leaseExpiresAt?.getTime() ?? 0) >= (before?.leaseExpiresAt?.getTime() ?? 0),
      "the lease should not move backwards",
    );
  });

  it("refuses a stale token, which is how a worker learns its session ended", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    const accepted = await touchSession(db, id, "not-the-right-token");
    assert.equal(accepted, false);
  });

  it("refuses once the session is closed, however valid the token", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    await db
      .update(captureSessions)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(captureSessions.id, id));

    assert.equal(await touchSession(db, id, claimed.leaseToken), false);
  });
});

describe("expireStaleSessions — nobody is driving these any more", () => {
  it("expires a claimed session whose worker stopped heartbeating", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    await db
      .update(captureSessions)
      .set({ leaseExpiresAt: addMs(new Date(), -1_000) })
      .where(eq(captureSessions.id, id));

    await expireStaleSessions(db);
    const [row] = await db.select().from(captureSessions).where(eq(captureSessions.id, id));

    assert.equal(row?.status, "expired");
    assert.ok(row?.closedAt, "an ended session must record when it ended");
    assert.equal(row?.leaseToken, null, "the lease is released");
  });

  it("drops the frame, which is the largest thing the row holds", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    await db
      .update(captureSessions)
      .set({
        frame: Buffer.from("not a real jpeg"),
        frameBytes: 15,
        leaseExpiresAt: addMs(new Date(), -1_000),
      })
      .where(eq(captureSessions.id, id));

    await expireStaleSessions(db);
    const [row] = await db.select().from(captureSessions).where(eq(captureSessions.id, id));

    assert.equal(row?.frame, null, "a frame outlives its browser by no time at all");
    assert.equal(row?.frameBytes, null);
  });

  it("fails the commands a dead session will never run", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    await db.insert(captureSessionCommands).values({
      id: uuidv7(),
      sessionId: id,
      seq: 1,
      type: "click",
      payload: { type: "click", x: 10, y: 10 },
    });

    await db
      .update(captureSessions)
      .set({ leaseExpiresAt: addMs(new Date(), -1_000) })
      .where(eq(captureSessions.id, id));
    await expireStaleSessions(db);

    const [command] = await db
      .select()
      .from(captureSessionCommands)
      .where(eq(captureSessionCommands.sessionId, id));

    // Left pending, the studio would show a spinner until somebody noticed.
    assert.equal(command?.status, "failed");
    assert.ok(command?.errorMessage);
    assert.ok(command?.finishedAt);
  });

  it("leaves a session alone while its lease is good", async () => {
    const made = await makeSession();
    const { claimed, sessionId: id } = await claimOurs(made);
    assert.ok(claimed);

    await db
      .update(captureSessions)
      .set({ status: "live", viewerSeenAt: new Date(), heartbeatAt: new Date() })
      .where(eq(captureSessions.id, id));

    await expireStaleSessions(db);
    const [row] = await db.select().from(captureSessions).where(eq(captureSessions.id, id));

    assert.equal(row?.status, "live", "an actively watched session must survive the reaper");
  });
});

describe("pendingCommands — what the worker long-polls for", () => {
  it("returns only unrun commands, in sequence order", async () => {
    const id = await makeSession();

    await db.insert(captureSessionCommands).values([
      { id: uuidv7(), sessionId: id, seq: 1, type: "click", payload: {}, status: "done" },
      { id: uuidv7(), sessionId: id, seq: 3, type: "scroll", payload: {} },
      { id: uuidv7(), sessionId: id, seq: 2, type: "move", payload: {} },
    ]);

    const commands = await pendingCommands(db, id);
    assert.deepEqual(
      commands.map((c) => c.seq),
      [2, 3],
      "a completed command must not be handed out again, and order is the sequence",
    );
  });
});
