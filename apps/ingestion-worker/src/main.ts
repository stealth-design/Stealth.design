/**
 * The capture worker.
 *
 * A long-running process that leases URLs from the control plane, captures
 * them, and reports the results. It is designed to be killed at any moment:
 * every item it holds is under a lease that expires, and the control plane
 * returns abandoned items to the queue (see `reclaimExpiredLeases`). A
 * `kill -9` mid-capture costs one lease interval, not the work.
 *
 * This process is treated as hostile-input infrastructure (§25). It runs
 * arbitrary JavaScript from arbitrary websites inside Chromium, so:
 *
 *   - `loadWorkerEnv` refuses to start if any control-plane secret is present
 *     in the environment. There is nothing here worth stealing.
 *   - Its only privileged channel is the control-plane HTTP API, holding a
 *     token scoped to `capture`.
 *   - The Chromium sandbox is on, and nothing in this repository can turn it
 *     off (see scripts/check-boundaries.mjs).
 *   - Every URL, every redirect hop and every subresource host is validated.
 *
 * Deploy it in its own container, on its own network segment, with egress to
 * the internet and to the control plane only.
 */
import { hostname } from "node:os";
import { BrowserPool, HostRateLimiter, type RobotsRules, verifyBrowser } from "@uxd/crawler";
import { createLogger, mapLimit, sleep } from "@uxd/shared";
import { EnvError, loadEnvFile, loadWorkerEnv } from "@uxd/shared/env";
import { intervalForRpm } from "@uxd/crawler";
import { captureItem } from "./capture-item.js";
import { runtimeConfigFromEnv } from "./config.js";
import { type LeasedItem, createControlPlaneClient } from "./control-plane.js";
import { runSession } from "./session.js";

// `.env.worker` first, so a worker on a shared machine cannot accidentally pick
// up the CMS's `.env` and its secrets.
loadEnvFile(".env.worker");

const env = (() => {
  try {
    return loadWorkerEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }
})();

const logger = createLogger({
  service: "ingestion-worker",
  level: env.UXD_LOG_LEVEL,
  format: env.UXD_LOG_FORMAT,
  bindings: { worker: env.WORKER_NAME },
});

const runtime = runtimeConfigFromEnv(env);
const client = createControlPlaneClient({
  baseUrl: env.CONTROL_PLANE_URL,
  token: env.WORKER_TOKEN,
  workerName: env.WORKER_NAME,
  logger,
});

const pool = new BrowserPool({ logger, headless: true });
const robotsCache = new Map<string, RobotsRules>();

/**
 * Per-host pacing, for the lifetime of this worker.
 *
 * One instance, deliberately. The limiter's entire state is a map of "not
 * before this time" per host, so an instance that lives for one item has
 * nothing to remember and never delays anything — see `delayFor`. The
 * per-request interval comes from each item's job configuration, which is why
 * the constructor default is only a fallback.
 */
const hostLimiter = new HostRateLimiter(intervalForRpm(20));

/** The host of a queue item's URL, without paying for a full guard. */
function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Items currently being captured, so heartbeats cover the right set. */
const inFlight = new Map<string, { item: LeasedItem; startedAt: number }>();
let itemsCompleted = 0;
let itemsFailed = 0;
/** Live studio sessions this worker is holding a browser open for. */
let activeSessions = 0;
let shuttingDown = false;
let instanceId: string | null = null;

async function main(): Promise<void> {
  logger.info("Starting capture worker", {
    controlPlane: env.CONTROL_PLANE_URL,
    concurrency: runtime.concurrency,
    batchSize: runtime.batchSize,
  });

  // Verify Chromium before claiming any work. "The browser will not start" is
  // the failure most likely to strand a job at Queued, and it is far better to
  // fail loudly at startup than to lease 200 URLs and fail every one.
  const browserCheck = await verifyBrowser(pool);
  if (!browserCheck.ok) {
    logger.error("Chromium could not be started; refusing to take work", {
      error: browserCheck.error,
    });
    process.exit(1);
  }
  logger.info("Chromium ready", { version: browserCheck.version });

  try {
    const registration = await client.register({
      name: runtime.name,
      hostname: hostname(),
      version: process.env.npm_package_version ?? "0.1.0",
      capabilities: {
        browser: browserCheck.version,
        concurrency: runtime.concurrency,
        captureLevels: [1, 2, 3],
        node: process.version,
      },
    });
    instanceId = registration.instanceId;
    logger.info("Registered with the control plane", { instanceId });
  } catch (error) {
    logger.error("Could not register with the control plane", { error });
    process.exit(1);
  }

  startInstanceHeartbeat();
  startLeaseHeartbeat();

  // Two independent loops on one process.
  //
  // They are separate because they are paced by different things: the batch
  // loop is bounded by how fast Chromium can render pages, the studio loop by
  // how fast a person can think. Interleaving studio polling into the batch
  // loop would make a researcher's click wait behind a 200-page crawl, which
  // is exactly the wrong trade — a crawl that finishes a minute later costs
  // nothing, and a studio that lags by a minute is unusable.
  await Promise.all([runLoop(), studioLoop()]);
}

/**
 * The main loop.
 *
 * Leases a batch, captures it with bounded concurrency, reports each result,
 * and sleeps when there is nothing to do. Backs off on control-plane errors so
 * a restarting CMS does not produce a tight retry loop.
 */
async function runLoop(): Promise<void> {
  let consecutiveErrors = 0;

  while (!shuttingDown) {
    try {
      const capacity = runtime.concurrency - inFlight.size;
      if (capacity <= 0) {
        await sleep(250);
        continue;
      }

      const items = await client.lease({
        workerName: runtime.name,
        limit: Math.min(runtime.batchSize, capacity),
        leaseSeconds: runtime.leaseSeconds,
      });
      consecutiveErrors = 0;

      if (items.length === 0) {
        // Idle. Drop cached robots rules, and drop pacing entries whose window
        // has already elapsed — a worker-lifetime limiter would otherwise keep
        // an entry for every host it has ever crawled. `pruneExpired` rather
        // than `prune` because dropping a host whose window is still open
        // would let the next request to it go out early.
        robotsCache.clear();
        hostLimiter.pruneExpired();
        await sleep(runtime.pollIntervalMs);
        continue;
      }

      logger.info("Leased work", { count: items.length });

      await mapLimit(items, runtime.concurrency, async (item) => {
        await processItem(item);
      });
    } catch (error) {
      consecutiveErrors += 1;
      const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveErrors, 5));
      logger.error("Worker loop error; backing off", { consecutiveErrors, delayMs, error });
      await sleep(delayMs);
    }
  }
}

/**
 * How many live studio sessions one worker will hold at once.
 *
 * A session holds a browser context open for as long as a person is using it —
 * minutes, against a batch capture's seconds — so this is a memory ceiling, not
 * a throughput knob. Two, because one is a surprising limit in practice: a
 * researcher who opens a second tab, or a second researcher on the same local
 * worker, would otherwise sit at "waiting for a worker" with no explanation
 * and nothing visibly wrong. Beyond two, run more workers.
 */
const MAX_STUDIO_SESSIONS = 2;

/**
 * The studio loop.
 *
 * Claims sessions up to the ceiling and runs each to completion without
 * blocking the next claim. Deliberately not `mapLimit` over a batch like the
 * capture loop: sessions arrive one at a time as people open them, and their
 * lifetimes have nothing to do with each other.
 */
async function studioLoop(): Promise<void> {
  let consecutiveErrors = 0;

  while (!shuttingDown) {
    try {
      if (activeSessions >= MAX_STUDIO_SESSIONS) {
        await sleep(500);
        continue;
      }

      const session = await client.claimSession();
      consecutiveErrors = 0;

      if (!session) {
        await sleep(runtime.pollIntervalMs);
        continue;
      }

      logger.info("Opening a capture session", { sessionId: session.id, url: session.targetUrl });
      activeSessions += 1;

      // Intentionally not awaited: the loop goes straight back to claiming, so
      // a second researcher does not wait behind the first one's thinking time.
      // Failures are handled inside `runSession`, which reports rather than
      // throws — the `catch` here is the belt to that braces.
      void runSession({ client, pool, runtime, logger }, session)
        .catch((error: unknown) => {
          logger.error("A capture session ended badly", { sessionId: session.id, error });
        })
        .finally(() => {
          activeSessions -= 1;
        });
    } catch (error) {
      consecutiveErrors += 1;
      const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveErrors, 5));
      logger.error("Studio loop error; backing off", { consecutiveErrors, delayMs, error });
      await sleep(delayMs);
    }
  }
}

async function processItem(item: LeasedItem): Promise<void> {
  inFlight.set(item.id, { item, startedAt: Date.now() });
  const itemLogger = logger.child({ itemId: item.id, jobRef: item.jobReference, url: item.url });

  try {
    const accepted = await client.markStarted(item.id, item.leaseToken);
    if (!accepted) {
      // The lease was reclaimed between the lease call and now. Someone else
      // owns this item; do not spend a browser on it.
      itemLogger.warn("Lease was already reassigned; skipping");
      return;
    }

    // Cancellation check. An operator who cancels a 5,000-URL job should not
    // wait for every in-flight item to finish before the job stops growing.
    //
    // The item is *reported*, not simply dropped. Returning early here left it
    // `leased` with a live lease and no terminal state — so it sat outstanding
    // until the lease expired, and (before the reclaim was wired into the lease
    // call) forever after that, holding the job open at 97% with no way to
    // recover but manual SQL. An item this worker has stopped working on must
    // always end up somewhere.
    if (!(await client.isJobActive(item.jobId).catch(() => true))) {
      itemLogger.info("Job is no longer active; releasing this item");
      await client
        .report({
          itemId: item.id,
          leaseToken: item.leaseToken,
          outcome: "blocked",
          retryable: false,
          requestedUrl: item.url,
          finalUrl: item.url,
          captureStatus: "failed",
          method: "http_fetch",
          // The schema's floor is 1; nothing was captured at any level, and
          // the error code is what carries that.
          captureLevel: 1,
          errorCode: "JOB_NOT_ACTIVE",
          errorMessage: "The job was paused or cancelled before this URL was captured.",
          depth: item.depth,
          contentKind: "page",
          media: [],
          signals: {},
          discoveredUrls: [],
          warnings: [],
        })
        .catch((error) => {
          // If the report itself fails the item keeps its lease and the
          // reclaim on the next lease call will requeue it — which is the
          // right outcome, and why that reclaim had to exist.
          itemLogger.warn("Could not release the item; it will be reclaimed", { error });
        });
      return;
    }

    // --- Politeness, before the clock starts --------------------------
    //
    // The rate-limit slot is reserved here rather than inside `captureItem`
    // for two reasons, both found by measurement.
    //
    // The limiter is worker-scoped (`hostLimiter`), because all of its state is
    // a per-host map: one constructed per item has nothing to remember and
    // returns a zero wait every time, which is a rate limit that does not
    // limit. That is worse than having none, since the operator believes the
    // configured rate is being honoured.
    //
    // And the wait happens *before* the per-item deadline race below. At six
    // requests per minute the interval is ten seconds, so the eighth item
    // queued against one host waits seventy — comfortably past a
    // forty-five-second item deadline. Charging deliberate pacing against a
    // timeout that exists to catch stuck pages would fail items for being
    // polite.
    const host = hostOfUrl(item.url);
    if (host) {
      const waitMs = hostLimiter.delayFor(host, {
        intervalMs: intervalForRpm(item.config.requestsPerMinutePerDomain),
      });
      if (waitMs > 0) {
        itemLogger.debug("Pacing", { host, waitMs });
        await sleep(waitMs);
      }
    }

    // Per-item deadline, independent of any single operation's timeout: a page
    // that keeps a socket trickling could otherwise hold a worker slot for far
    // longer than any one timeout allows.
    const deadlineMs = Math.min(item.config.itemTimeoutMs, runtime.itemTimeoutMs);
    const outcome = await Promise.race([
      captureItem(
        { client, pool, limiter: hostLimiter, runtime, logger: itemLogger, robotsCache },
        item,
      ),
      sleep(deadlineMs).then(() => "timeout" as const),
    ]);

    if (outcome === "timeout") {
      itemLogger.warn("Item exceeded its deadline", { deadlineMs });
      itemsFailed += 1;
      await client.report({
        itemId: item.id,
        leaseToken: item.leaseToken,
        outcome: "failed",
        retryable: true,
        requestedUrl: item.url,
        finalUrl: item.url,
        captureStatus: "failed",
        method: "browser_render",
        captureLevel: 2,
        errorCode: "CAPTURE_TIMEOUT",
        errorMessage: `The capture did not finish within ${Math.round(deadlineMs / 1000)} seconds.`,
        depth: item.depth,
        contentKind: "page",
        media: [],
        signals: {},
        discoveredUrls: [],
        warnings: [],
        browserErrors: [],
        headings: [],
        redirectChain: [],
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    const response = await client.report(outcome.report);

    if (!response.accepted) {
      itemLogger.warn("Report rejected", { reason: response.reason });
      return;
    }

    if (outcome.outcome === "succeeded") {
      itemsCompleted += 1;
      itemLogger.info("Captured", {
        contentItemId: response.contentItemId,
        version: response.version,
        changed: response.changed,
        discovered: response.discoveredQueued,
      });
    } else {
      itemsFailed += 1;
      itemLogger.warn("Capture did not succeed", {
        outcome: outcome.outcome,
        willRetry: response.willRetry,
      });
    }
  } catch (error) {
    itemsFailed += 1;
    itemLogger.error("Unhandled error while capturing", { error });
    // Report the failure so the item settles rather than waiting for its lease
    // to expire — a reported failure retries sooner and reads better in the log.
    await client
      .report({
        itemId: item.id,
        leaseToken: item.leaseToken,
        outcome: "failed",
        retryable: true,
        requestedUrl: item.url,
        finalUrl: item.url,
        captureStatus: "failed",
        method: "browser_render",
        captureLevel: 2,
        errorCode: "CAPTURE_FAILED",
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "The worker hit an unexpected error.",
        depth: item.depth,
        contentKind: "page",
        media: [],
        signals: {},
        discoveredUrls: [],
        warnings: [],
        browserErrors: [],
        headings: [],
        redirectChain: [],
        finishedAt: new Date().toISOString(),
      })
      .catch(() => {});
  } finally {
    inFlight.delete(item.id);
  }
}

/**
 * Extend the leases of everything in flight.
 *
 * Runs at a third of the lease interval, so two consecutive missed heartbeats
 * still leave time before expiry. When the control plane reports an item as
 * `lost`, this worker no longer owns it and stops working on it — continuing
 * would produce a result that `completeItem` refuses anyway.
 */
function startLeaseHeartbeat(): void {
  const intervalMs = Math.max(5_000, (runtime.leaseSeconds * 1_000) / 3);
  const timer = setInterval(() => {
    void (async () => {
      if (inFlight.size === 0) return;
      // Items are grouped by lease token, since a batch shares one token.
      const byToken = new Map<string, string[]>();
      for (const [id, entry] of inFlight) {
        const ids = byToken.get(entry.item.leaseToken) ?? [];
        ids.push(id);
        byToken.set(entry.item.leaseToken, ids);
      }

      for (const [token, ids] of byToken) {
        try {
          const result = await client.heartbeatItems(ids, token, runtime.leaseSeconds);
          for (const lostId of result.lost) {
            logger.warn("Lost a lease while capturing; abandoning the item", { itemId: lostId });
            inFlight.delete(lostId);
          }
        } catch (error) {
          logger.warn("Lease heartbeat failed", { error });
        }
      }
    })();
  }, intervalMs);
  timer.unref();
}

/** Tell the CMS this worker is alive, so "no workers running" is visible. */
function startInstanceHeartbeat(): void {
  const timer = setInterval(() => {
    void (async () => {
      if (!instanceId) return;
      await client.heartbeatInstance(instanceId, {
        itemsInFlight: inFlight.size + activeSessions,
        itemsCompleted,
        itemsFailed,
      });
    })();
  }, 30_000);
  timer.unref();
}

/**
 * Graceful shutdown.
 *
 * Stops taking new work and gives in-flight captures a bounded window to
 * finish. Anything still running when the window closes is abandoned, and its
 * lease expiry returns it to the queue — which is why an abrupt stop is safe
 * rather than merely tolerable.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down", { signal, inFlight: inFlight.size, sessions: activeSessions });

  const deadline = Date.now() + 30_000;
  while ((inFlight.size > 0 || activeSessions > 0) && Date.now() < deadline) {
    await sleep(500);
  }
  if (activeSessions > 0) {
    // A studio session has a person on the other end. Its lease lapsing is how
    // they find out the browser is gone, which is why the reaper reports
    // `expired` with a sentence rather than leaving the tab spinning.
    logger.warn("Abandoning live capture sessions; they will be reported as expired", {
      count: activeSessions,
    });
  }
  if (inFlight.size > 0) {
    logger.warn("Abandoning in-flight items; their leases will expire and they will be requeued", {
      count: inFlight.size,
    });
  }

  await pool.close();
  logger.info("Stopped", { itemsCompleted, itemsFailed });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// An unhandled rejection in a worker that runs hostile page code should stop
// the process rather than continue in an unknown state — the orchestrator
// restarts it and its leases are reclaimed.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection; exiting", { reason });
  void shutdown("unhandledRejection");
});

await main();
