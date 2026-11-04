/**
 * The lease endpoint's recovery behaviour.
 *
 * This file exists because of a specific class of bug that a unit test cannot
 * catch. `reclaimExpiredLeases` was implemented, documented, and covered by
 * four passing tests — and no production code path called it. Three items sat
 * `running` with expired leases, the job hung at 97 percent, and the tests
 * stayed green the whole time, because they invoked the function directly.
 * They proved the function worked; nothing proved anything used it.
 *
 * So these tests go through the HTTP handler. They assert the *wiring*: that
 * asking the real endpoint for work is what returns abandoned work to the
 * queue. A future refactor that moves the reclaim to a scheduler, or drops the
 * call while keeping the function, fails here.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type Database,
  type DatabaseHandle,
  claimItems,
  createDatabase,
  crawlJobItems,
  crawlJobs,
  enqueueItems,
} from "@uxd/database";
import { createErrorHandler, createInternalApi } from "@uxd/api";
import { createStorage } from "@uxd/media";
import { defaultJobConfig } from "@uxd/types";
import { type Logger, sha256Hex, shortId, uuidv7 } from "@uxd/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const SECRET = "test-worker-secret-not-a-real-credential";

let handle: DatabaseHandle;
let db: Database;
const createdJobIds: string[] = [];

/** Silent, so a passing run is quiet; the assertions do the reporting. */
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
  async time(_message, fn) {
    return fn();
  },
};

const storage = createStorage({
  driver: "local",
  localRoot: join(tmpdir(), `uxd-internal-lease-${process.pid}`),
  localPublicBaseUrl: "/media",
});

/**
 * The router only needs `baseContext`. Everything it reaches for on the lease
 * path is the database; storage and the classifier are present because the
 * type requires them, not because this test uses them.
 */
function buildApp() {
  const app = createInternalApi({
    baseContext: (requestId, ip, userAgent) => ({
      db,
      storage,
      classifier: { name: "test", classify: async () => ({ suggestions: [] }) } as never,
      logger,
      env: { WORKER_SHARED_SECRET: SECRET } as never,
      requestId,
      ip,
      userAgent,
    }),
  });
  // The host route registers this too. Without it an `AppError` escapes as a
  // 500 and the auth assertions below would pass for the wrong reason.
  app.onError(createErrorHandler({ logger }));
  return app;
}

/** POST to the lease endpoint the way the worker does. */
async function lease(workerName = "test-worker", limit = 5) {
  return buildApp().request("/jobs/lease", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRET}`,
      "x-worker-name": workerName,
    },
    body: JSON.stringify({ workerName, limit, leaseSeconds: 300 }),
  });
}

async function makeJob(): Promise<string> {
  const id = uuidv7();
  await db.insert(crawlJobs).values({
    id,
    reference: `LEASE-${shortId(8)}`,
    name: "lease endpoint test",
    // `running` because the bug under test is about a job that cannot leave
    // this status once its last item is lost.
    status: "running",
    config: defaultJobConfig(),
    startedAt: new Date(),
  });
  createdJobIds.push(id);
  return id;
}

async function addUrl(jobId: string, n: number, maxAttempts: number) {
  const url = `https://lease.test/page-${n}-${shortId(6)}`;
  await enqueueItems(db, [
    { jobId, url, normalizedUrlHash: sha256Hex(url), host: "lease.test", maxAttempts },
  ]);
}

/** Expire an item's lease with no heartbeat: the worker vanished. */
async function killWorkerHolding(itemId: string) {
  await db
    .update(crawlJobItems)
    .set({ leaseExpiresAt: sql`now() - interval '2 minutes'` })
    .where(eq(crawlJobItems.id, itemId));
}

const itemById = async (id: string) =>
  (await db.select().from(crawlJobItems).where(eq(crawlJobItems.id, id)).limit(1))[0];
const jobById = async (id: string) =>
  (await db.select().from(crawlJobs).where(eq(crawlJobs.id, id)).limit(1))[0];

before(async () => {
  handle = createDatabase({ url: DATABASE_URL, poolMax: 1, applicationName: "uxd-lease-test" });
  const ping = await handle.ping();
  assert.ok(ping.ok, `These tests need a database. Start one with \`npm run db:serve\`. (${ping.error ?? ""})`);
  db = handle.db;
});

after(async () => {
  if (createdJobIds.length > 0) {
    await db.delete(crawlJobs).where(inArray(crawlJobs.id, createdJobIds));
  }
  await handle?.close();
});

describe("POST /jobs/lease — asking for work recovers abandoned work", () => {
  it("requeues an item abandoned by a dead worker", async () => {
    // The exact production scenario: one worker takes an item and dies, then
    // another worker asks for work. The item must be back in the queue.
    const jobId = await makeJob();
    await addUrl(jobId, 1, 3);

    const [taken] = await claimItems(db, { workerName: "doomed", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(taken, "the fixture item was not claimable");
    await killWorkerHolding(taken.id);

    const response = await lease("rescuer");
    assert.equal(response.status, 200);

    const stored = await itemById(taken.id);
    assert.equal(stored?.status, "pending", "the URL is back in the queue, not lost");
    assert.equal(stored?.leaseToken, null, "a queued item must not hold a lease");
    assert.equal(stored?.leasedBy, null);
    assert.equal(stored?.attempts, 1, "the spent attempt is remembered, so retries stay bounded");
  });

  it("holds a reclaimed item back for a retry delay rather than serving it instantly", async () => {
    // Deliberate, and worth pinning: a reclaimed item is not handed straight
    // back out. Whatever killed the worker — a page that hangs the browser, a
    // host that stops answering — is likely still true a millisecond later, so
    // an immediate re-lease would spin a URL through workers as fast as they
    // can die on it. The backoff makes recovery visibly slower and stops that.
    const jobId = await makeJob();
    await addUrl(jobId, 5, 3);

    const [taken] = await claimItems(db, { workerName: "doomed", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(taken);
    await killWorkerHolding(taken.id);

    const body = (await (await lease("rescuer")).json()) as { items: { id: string }[] };
    assert.ok(
      !body.items.some((i) => i.id === taken.id),
      "a just-reclaimed item was served in the same call, with no retry delay",
    );

    const stored = await itemById(taken.id);
    assert.ok(stored?.availableAt, "a requeued item needs an availability time");
    assert.ok(
      stored.availableAt.getTime() > Date.now(),
      `the retry delay is in the past (${stored.availableAt.toISOString()})`,
    );

    // Once the delay has passed, the item really is claimable again — the
    // backoff defers the retry, it does not cancel it.
    await db
      .update(crawlJobItems)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(crawlJobItems.id, taken.id));

    const second = (await (await lease("rescuer")).json()) as { items: { id: string }[] };
    assert.ok(
      second.items.some((i) => i.id === taken.id),
      "the item never came back after its retry delay elapsed",
    );
    assert.equal((await itemById(taken.id))?.leasedBy, "rescuer");
  });

  it("dead-letters an item that has no attempts left", async () => {
    const jobId = await makeJob();
    await addUrl(jobId, 2, 1);

    const [taken] = await claimItems(db, { workerName: "doomed", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(taken);
    await killWorkerHolding(taken.id);

    assert.equal((await lease("rescuer")).status, 200);

    const stored = await itemById(taken.id);
    assert.equal(stored?.status, "dead_letter", "an item out of attempts needs a person");
    assert.equal(stored?.errorCode, "WORKER_LOST");
  });

  it("finalises a job whose last outstanding item was lost", async () => {
    // The second half of the same bug. Reclaiming the item is not enough: if
    // it was the job's last one, the job has to stop being `running`, or the
    // CMS shows a crawl in progress that nothing will ever advance.
    const jobId = await makeJob();
    await addUrl(jobId, 3, 1);

    const [taken] = await claimItems(db, { workerName: "doomed", limit: 1, leaseMs: 60_000, jobId });
    assert.ok(taken);
    await killWorkerHolding(taken.id);

    assert.equal((await lease("rescuer")).status, 200);

    const job = await jobById(jobId);
    assert.ok(job);
    assert.notEqual(job.status, "running", `the job is still ${job.status} with nothing outstanding`);
    assert.ok(job.finishedAt, "a finished job needs a finished_at for the CMS to sort by");
    assert.equal(job.failedCount, 1, "the lost item is counted as a failure, not silently dropped");
  });

  it("leaves a healthy lease with its owner", async () => {
    // The reclaim must not be a stampede: a worker asking for work cannot
    // steal an item another worker is actively processing.
    const jobId = await makeJob();
    await addUrl(jobId, 4, 3);

    const [taken] = await claimItems(db, { workerName: "healthy", limit: 1, leaseMs: 600_000, jobId });
    assert.ok(taken);

    assert.equal((await lease("interloper")).status, 200);

    const stored = await itemById(taken.id);
    assert.equal(stored?.leasedBy, "healthy", "an in-flight item was taken from its owner");
    assert.equal(stored?.attempts, 1, "an untouched item must not burn an attempt");
  });

  it("rejects an unauthenticated lease request", async () => {
    const response = await buildApp().request("/jobs/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerName: "anon", limit: 1, leaseSeconds: 300 }),
    });
    assert.equal(response.status, 401);
  });
});
