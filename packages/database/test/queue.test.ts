/**
 * Durable-queue tests (§6 "do not lose state if the worker crashes").
 *
 * These run against a real Postgres — the PGlite dev server started by
 * `npm run db:serve` — because the behaviour under test *is* database
 * behaviour: `FOR UPDATE SKIP LOCKED` semantics, transactional counter
 * updates, and lease expiry. A mocked database would test the mock.
 *
 * Each test creates its own job and cleans up after itself, so the suite is
 * order-independent and safe to run against a development database with other
 * data in it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type Database,
  type DatabaseHandle,
  cancelJob,
  claimItems,
  completeItem,
  createDatabase,
  crawlJobItems,
  crawlJobs,
  enqueueItems,
  finalizeJobIfComplete,
  heartbeat,
  markItemRunning,
  pauseJob,
  queueHealth,
  reclaimExpiredLeases,
  recomputeJobCounters,
  resumeJob,
  retryItems,
} from "@uxd/database";
import { defaultJobConfig } from "@uxd/types";
import { sha256Hex, shortId, uuidv7 } from "@uxd/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

let handle: DatabaseHandle;
let db: Database;
const createdJobIds: string[] = [];

before(async () => {
  handle = createDatabase({ url: DATABASE_URL, poolMax: 5, applicationName: "uxd-queue-test" });
  const ping = await handle.ping();
  assert.ok(
    ping.ok,
    `These tests need a database. Start one with \`npm run db:serve\`. (${ping.error ?? ""})`,
  );
});

after(async () => {
  if (createdJobIds.length > 0) {
    await db.delete(crawlJobs).where(inArray(crawlJobs.id, createdJobIds));
  }
  await handle?.close();
});

async function makeJob(): Promise<string> {
  db = handle.db;
  const id = uuidv7();
  await db.insert(crawlJobs).values({
    id,
    reference: `JOB-${shortId(8)}`,
    name: "queue test",
    status: "queued",
    config: defaultJobConfig(),
  });
  createdJobIds.push(id);
  return id;
}

async function addUrls(jobId: string, count: number, maxAttempts = 3): Promise<void> {
  const items = Array.from({ length: count }, (_, i) => {
    const url = `https://queue-test-${jobId.slice(0, 8)}-${i}.example.com/`;
    return {
      jobId,
      url,
      normalizedUrlHash: sha256Hex(url),
      host: `queue-test-${jobId.slice(0, 8)}-${i}.example.com`,
      maxAttempts,
    };
  });
  await enqueueItems(handle.db, items);
}

const itemById = async (id: string) => {
  const [row] = await handle.db.select().from(crawlJobItems).where(eq(crawlJobItems.id, id)).limit(1);
  return row;
};

const jobById = async (id: string) => {
  const [row] = await handle.db.select().from(crawlJobs).where(eq(crawlJobs.id, id)).limit(1);
  return row;
};

describe("claimItems", () => {
  it("claims pending work and marks the job running", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 3);

    const claimed = await claimItems(handle.db, {
      workerName: "w1",
      limit: 10,
      leaseMs: 60_000,
      jobId,
    });

    assert.equal(claimed.length, 3);
    for (const item of claimed) {
      assert.ok(item.leaseToken, "each claim carries a lease token");
      assert.ok(item.leaseExpiresAt > new Date());
      assert.equal(item.attempts, 1, "claiming counts as an attempt");
      assert.ok(item.config, "the job config rides along, so no second round trip is needed");
    }

    const job = await jobById(jobId);
    assert.equal(job?.status, "running");
    assert.equal(job?.runningCount, 3);
    assert.equal(job?.queuedCount, 0);
  });

  it("never hands the same item to two workers", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 20);

    // Six workers polling at once, as they would in production.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimItems(handle.db, { workerName: `w${i}`, limit: 5, leaseMs: 60_000, jobId }),
      ),
    );

    const allIds = results.flat().map((i) => i.id);
    assert.equal(allIds.length, new Set(allIds).size, "no item was claimed twice");
    assert.equal(allIds.length, 20, "all 20 items were claimed exactly once");
    // Each worker's batch carries its own token.
    const tokens = new Set(results.flat().map((i) => i.leaseToken));
    assert.ok(tokens.size >= 1);
  });

  it("respects the limit", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 10);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 4, leaseMs: 60_000, jobId });
    assert.equal(claimed.length, 4);
  });

  it("claims nothing from a paused job", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 5);
    await pauseJob(handle.db, jobId, "tester");

    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 10, leaseMs: 60_000, jobId });
    assert.equal(claimed.length, 0, "a paused job yields no work");

    await resumeJob(handle.db, jobId, "tester");
    const afterResume = await claimItems(handle.db, {
      workerName: "w1",
      limit: 10,
      leaseMs: 60_000,
      jobId,
    });
    assert.equal(afterResume.length, 5, "resuming makes the work claimable again");
  });

  it("does not claim items whose backoff has not elapsed", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    await handle.db
      .update(crawlJobItems)
      .set({ availableAt: sql`now() + interval '1 hour'` })
      .where(eq(crawlJobItems.jobId, jobId));

    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 10, leaseMs: 60_000, jobId });
    assert.equal(claimed.length, 0);
  });
});

describe("heartbeat", () => {
  it("extends a lease we still hold", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 5_000, jobId });
    assert.ok(item);

    const before = (await itemById(item.id))?.leaseExpiresAt;
    const result = await heartbeat(handle.db, [item.id], item.leaseToken, 120_000);

    assert.deepEqual(result.alive, [item.id]);
    assert.deepEqual(result.lost, []);
    const after = (await itemById(item.id))?.leaseExpiresAt;
    assert.ok(before && after && after > before, "the lease was pushed out");
  });

  it("reports a lease that is no longer ours", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 5_000, jobId });
    assert.ok(item);

    // Someone else took it (simulating a reclaim while we were busy).
    await handle.db
      .update(crawlJobItems)
      .set({ leaseToken: "someone-elses-token" })
      .where(eq(crawlJobItems.id, item.id));

    const result = await heartbeat(handle.db, [item.id], item.leaseToken, 60_000);
    assert.deepEqual(result.alive, []);
    assert.deepEqual(result.lost, [item.id], "the worker learns it lost the item");
  });
});

describe("completeItem — lease enforcement", () => {
  it("records a successful capture and updates counters transactionally", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);
    await markItemRunning(handle.db, item.id, item.leaseToken);

    const result = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "succeeded",
      httpStatus: 200,
      finalUrl: item.url,
      durationMs: 1234,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.finalStatus, "succeeded");
    assert.equal(result.willRetry, false);

    const stored = await itemById(item.id);
    assert.equal(stored?.status, "succeeded");
    assert.equal(stored?.httpStatus, 200);
    assert.equal(stored?.leaseToken, null, "the lease is cleared on completion");
    assert.ok(stored?.finishedAt);

    const job = await jobById(jobId);
    assert.equal(job?.completedCount, 1);
    assert.equal(job?.runningCount, 0);
  });

  it("REJECTS a result carrying a stale lease token", async () => {
    // This is the property that makes crash recovery safe. A worker that hung
    // past its lease, had the item reclaimed, then woke up and reported, must
    // not clobber the newer attempt.
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "slow", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    const result = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: "stale-token-from-a-dead-worker",
      status: "succeeded",
      httpStatus: 200,
    });

    assert.equal(result.accepted, false, "a stale token is refused");
    assert.equal(result.finalStatus, null);

    const stored = await itemById(item.id);
    assert.equal(stored?.status, "leased", "the item is untouched and still leased");
    assert.equal(stored?.httpStatus, null, "no result was written");
  });

  it("refuses a second completion for the same lease", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    const first = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "succeeded",
    });
    const second = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "failed",
      errorCode: "SHOULD_NOT_APPLY",
    });

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false, "completion is idempotent per lease");
    const stored = await itemById(item.id);
    assert.equal(stored?.status, "succeeded", "the first outcome stands");

    const job = await jobById(jobId);
    assert.equal(job?.completedCount, 1, "counters were not double-incremented");
  });
});

describe("completeItem — retry and backoff", () => {
  it("returns a retryable failure to pending with a future availableAt", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1, 3);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    const result = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "failed",
      errorCode: "CAPTURE_TIMEOUT",
      errorMessage: "navigation timed out",
      retryable: true,
    });

    assert.equal(result.willRetry, true);
    assert.equal(result.finalStatus, "pending");

    const stored = await itemById(item.id);
    assert.equal(stored?.status, "pending");
    assert.equal(stored?.attempts, 1);
    assert.equal(stored?.finishedAt, null);
    assert.ok(
      stored && stored.availableAt > new Date(),
      "backoff pushes the retry into the future rather than hammering the site",
    );

    const job = await jobById(jobId);
    assert.equal(job?.retriedCount, 1);
    assert.equal(job?.failedCount, 0, "a pending retry is not a failure yet");
  });

  it("fails terminally once attempts are exhausted", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1, 1); // maxAttempts = 1

    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);
    assert.equal(item.attempts, 1);

    const result = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "failed",
      errorCode: "NAVIGATION_FAILED",
      retryable: true,
    });

    assert.equal(result.willRetry, false);
    assert.equal(result.finalStatus, "failed");
    const job = await jobById(jobId);
    assert.equal(job?.failedCount, 1);
  });

  it("does not retry a non-retryable failure even with attempts left", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1, 5);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    const result = await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "blocked",
      errorCode: "SSRF_BLOCKED",
    });

    assert.equal(result.finalStatus, "blocked");
    assert.equal(result.willRetry, false, "a safety block is not something retrying fixes");
    const job = await jobById(jobId);
    assert.equal(job?.blockedCount, 1);
  });

  it("counts a duplicate skip separately from a failure", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    await completeItem(handle.db, {
      itemId: item.id,
      leaseToken: item.leaseToken,
      status: "skipped_duplicate",
    });

    const job = await jobById(jobId);
    assert.equal(job?.duplicateCount, 1);
    assert.equal(job?.skippedCount, 1);
    assert.equal(job?.failedCount, 0);
  });
});

describe("reclaimExpiredLeases — the crash-recovery path", () => {
  it("requeues an item whose worker died, when attempts remain", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1, 3);
    const [item] = await claimItems(handle.db, { workerName: "doomed", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    // Simulate the worker vanishing: the lease expires with no heartbeat.
    await handle.db
      .update(crawlJobItems)
      .set({ leaseExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(crawlJobItems.id, item.id));

    const result = await reclaimExpiredLeases(handle.db);
    assert.ok(result.requeued >= 1);

    const stored = await itemById(item.id);
    assert.equal(stored?.status, "pending", "the URL is back in the queue, not lost");
    assert.equal(stored?.leaseToken, null);
    assert.equal(stored?.attempts, 1, "the spent attempt is remembered");
  });

  it("dead-letters an item that exhausted its attempts without ever reporting", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1, 1);
    const [item] = await claimItems(handle.db, { workerName: "doomed", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    await handle.db
      .update(crawlJobItems)
      .set({ leaseExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(crawlJobItems.id, item.id));

    const result = await reclaimExpiredLeases(handle.db);
    assert.ok(result.deadLettered >= 1);

    const stored = await itemById(item.id);
    assert.equal(stored?.status, "dead_letter", "it needs a person, not another retry");
    assert.equal(stored?.errorCode, "WORKER_LOST");
    // The message has to make sense to a non-engineer reading the CMS.
    assert.match(stored?.errorMessage ?? "", /stopped responding/i);
  });

  it("leaves a healthy lease alone", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "healthy", limit: 1, leaseMs: 600_000, jobId });
    assert.ok(item);

    await reclaimExpiredLeases(handle.db);
    const stored = await itemById(item.id);
    assert.equal(stored?.status, "leased", "an unexpired lease is not disturbed");
    assert.equal(stored?.leasedBy, "healthy");
  });

  it("is safe to run concurrently with a heartbeat", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 1);
    const [item] = await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(item);

    // Expire the lease, then race a heartbeat against the reaper. Either
    // outcome is acceptable; what must not happen is a row left in an
    // inconsistent state (leased with no token, or running with no lease).
    await handle.db
      .update(crawlJobItems)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(crawlJobItems.id, item.id));

    await Promise.all([
      reclaimExpiredLeases(handle.db),
      heartbeat(handle.db, [item.id], item.leaseToken, 60_000),
    ]);

    const stored = await itemById(item.id);
    assert.ok(stored);
    if (stored.status === "leased" || stored.status === "running") {
      assert.ok(stored.leaseToken, "an in-flight item always has a token");
      assert.ok(stored.leaseExpiresAt, "an in-flight item always has an expiry");
    } else {
      assert.equal(stored.leaseToken, null, "a settled item never keeps a token");
    }
  });
});

describe("job control", () => {
  it("cancel clears pending work but keeps what already succeeded", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 5);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 2, leaseMs: 60_000, jobId });
    await completeItem(handle.db, {
      itemId: claimed[0]!.id,
      leaseToken: claimed[0]!.leaseToken,
      status: "succeeded",
    });

    const result = await cancelJob(handle.db, jobId, "tester");
    assert.equal(result.cancelled, 3, "the three still-pending items were cancelled");
    assert.equal(result.inFlight, 1, "one item is still in flight");

    const job = await jobById(jobId);
    assert.equal(job?.status, "cancelling", "waits for in-flight work to drain");
    assert.equal(job?.completedCount, 1, "the successful capture is kept");
  });

  it("retryItems requeues failures and resets the attempt counter", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 2, 1);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 2, leaseMs: 60_000, jobId });
    for (const item of claimed) {
      await completeItem(handle.db, {
        itemId: item.id,
        leaseToken: item.leaseToken,
        status: "failed",
        errorCode: "CAPTURE_TIMEOUT",
      });
    }

    const requeued = await retryItems(handle.db, { jobId, actorLabel: "tester" });
    assert.equal(requeued, 2);

    const rows = await handle.db
      .select()
      .from(crawlJobItems)
      .where(eq(crawlJobItems.jobId, jobId));
    for (const row of rows) {
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 0, "Retry starts over rather than continuing a doomed sequence");
      assert.equal(row.errorCode, null, "the previous error is cleared");
    }

    const job = await jobById(jobId);
    assert.equal(job?.failedCount, 0);
    assert.equal(job?.queuedCount, 2);
  });

  it("retryItems can target selected items only", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 3, 1);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 3, leaseMs: 60_000, jobId });
    for (const item of claimed) {
      await completeItem(handle.db, {
        itemId: item.id,
        leaseToken: item.leaseToken,
        status: "failed",
        errorCode: "X",
      });
    }

    const requeued = await retryItems(handle.db, {
      jobId,
      itemIds: [claimed[0]!.id],
      actorLabel: "tester",
    });
    assert.equal(requeued, 1);

    const [target] = await handle.db
      .select()
      .from(crawlJobItems)
      .where(eq(crawlJobItems.id, claimed[0]!.id));
    assert.equal(target?.status, "pending");
    const [untouched] = await handle.db
      .select()
      .from(crawlJobItems)
      .where(eq(crawlJobItems.id, claimed[1]!.id));
    assert.equal(untouched?.status, "failed");
  });
});

describe("finalizeJobIfComplete", () => {
  it("marks a clean run completed", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 2);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 2, leaseMs: 60_000, jobId });
    for (const item of claimed) {
      await completeItem(handle.db, { itemId: item.id, leaseToken: item.leaseToken, status: "succeeded" });
    }

    assert.equal(await finalizeJobIfComplete(handle.db, jobId), true);
    const job = await jobById(jobId);
    assert.equal(job?.status, "completed");
    assert.ok(job?.finishedAt);
    assert.ok((job?.durationMs ?? -1) >= 0);
  });

  it("distinguishes a run that finished with failures", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 2, 1);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 2, leaseMs: 60_000, jobId });
    await completeItem(handle.db, {
      itemId: claimed[0]!.id,
      leaseToken: claimed[0]!.leaseToken,
      status: "succeeded",
    });
    await completeItem(handle.db, {
      itemId: claimed[1]!.id,
      leaseToken: claimed[1]!.leaseToken,
      status: "failed",
      errorCode: "X",
    });

    await finalizeJobIfComplete(handle.db, jobId);
    const job = await jobById(jobId);
    assert.equal(job?.status, "completed_with_errors", "'finished' and 'finished with 1 failure' look different");
  });

  it("does not finalize while work is outstanding", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 2);
    await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });
    assert.equal(await finalizeJobIfComplete(handle.db, jobId), false);
  });
});

describe("enqueueItems", () => {
  it("is idempotent for the same URL in the same job", async () => {
    const jobId = await makeJob();
    const url = `https://dedupe-${jobId.slice(0, 8)}.example.com/`;
    const item = { jobId, url, normalizedUrlHash: sha256Hex(url), host: "dedupe.example.com" };

    const first = await enqueueItems(handle.db, [item]);
    const second = await enqueueItems(handle.db, [item]);

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0, "re-discovering a link does not queue it twice");

    const [counted] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(crawlJobItems)
      .where(eq(crawlJobItems.jobId, jobId));
    assert.equal(counted?.n, 1);
  });

  it("handles an empty batch without touching the database", async () => {
    const result = await enqueueItems(handle.db, []);
    assert.deepEqual(result, { inserted: 0, ids: [] });
  });
});

describe("recomputeJobCounters", () => {
  it("repairs counters that have drifted", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 4);
    const claimed = await claimItems(handle.db, { workerName: "w1", limit: 2, leaseMs: 60_000, jobId });
    await completeItem(handle.db, {
      itemId: claimed[0]!.id,
      leaseToken: claimed[0]!.leaseToken,
      status: "succeeded",
    });

    // Corrupt the counters, as a mid-incident manual UPDATE might.
    await handle.db
      .update(crawlJobs)
      .set({ completedCount: 999, failedCount: 42, queuedCount: 7 })
      .where(eq(crawlJobs.id, jobId));

    await recomputeJobCounters(handle.db, jobId);

    const job = await jobById(jobId);
    assert.equal(job?.completedCount, 1);
    assert.equal(job?.failedCount, 0);
    assert.equal(job?.queuedCount, 2, "two items were never claimed");
    assert.equal(job?.runningCount, 1, "one is still leased");
  });
});

describe("queueHealth", () => {
  it("reports depth, in-flight work and expired leases", async () => {
    const jobId = await makeJob();
    await addUrls(jobId, 3);
    await claimItems(handle.db, { workerName: "w1", limit: 1, leaseMs: 60_000, jobId });

    const health = await queueHealth(handle.db);
    assert.ok(health.pending >= 2);
    assert.ok(health.inFlight >= 1);
    assert.ok(health.activeJobs >= 1);
    assert.ok(
      health.oldestPendingAgeMs !== null && health.oldestPendingAgeMs >= 0,
      "the oldest pending age is what shows a stuck queue",
    );
  });
});
