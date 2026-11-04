/**
 * Host rate limiter.
 *
 * These exist because a crawl experiment found the limiter was completely
 * ineffective in production while looking correct in isolation. The class was
 * fine; the caller constructed a new one per item, so its per-host map was
 * always empty and `delayFor` always returned zero. One shared host received
 * eight unpaced requests and began throttling us.
 *
 * A rate limit that silently does not limit is worse than having none, because
 * the operator believes the configured rate is being honoured. So what is
 * asserted here is not just the arithmetic but the *statefulness* — the
 * property whose absence caused the bug.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostRateLimiter, intervalForRpm } from "@uxd/crawler";

describe("intervalForRpm", () => {
  it("converts requests per minute to a per-request interval", () => {
    assert.equal(intervalForRpm(60), 1_000);
    assert.equal(intervalForRpm(20), 3_000);
    assert.equal(intervalForRpm(6), 10_000);
    assert.equal(intervalForRpm(1), 60_000);
  });

  it("never divides by zero or returns a negative interval", () => {
    assert.equal(intervalForRpm(0), 60_000);
    assert.equal(intervalForRpm(-5), 60_000);
  });
});

describe("HostRateLimiter", () => {
  it("lets the first request to a host go immediately", () => {
    const limiter = new HostRateLimiter(10_000);
    assert.equal(limiter.delayFor("example.com"), 0);
  });

  it("paces subsequent requests to the same host", () => {
    // The property the production bug destroyed: the limiter has to remember
    // that it already released a slot.
    const limiter = new HostRateLimiter(10_000);
    assert.equal(limiter.delayFor("example.com"), 0);
    const second = limiter.delayFor("example.com");
    const third = limiter.delayFor("example.com");
    assert.ok(second >= 9_000 && second <= 10_000, `second wait was ${second}`);
    assert.ok(third >= 19_000 && third <= 20_000, `third wait was ${third}`);
  });

  it("paces hosts independently", () => {
    const limiter = new HostRateLimiter(10_000);
    limiter.delayFor("a.example.com");
    limiter.delayFor("a.example.com");
    // A different host is unaffected by another's queue.
    assert.equal(limiter.delayFor("b.example.com"), 0);
  });

  it("takes the interval per call, so one limiter serves jobs at different rates", () => {
    // The rate is a property of the job, and one worker serves many jobs. If
    // the interval could only be set in the constructor, a shared limiter
    // would have to pick one job's rate and apply it to all of them.
    const limiter = new HostRateLimiter(60_000);
    assert.equal(limiter.delayFor("example.com", { intervalMs: 1_000 }), 0);
    const second = limiter.delayFor("example.com", { intervalMs: 1_000 });
    assert.ok(second <= 1_000, `expected the per-call interval to win, got ${second}`);
  });

  it("honours a longer Crawl-delay than our own interval", () => {
    const limiter = new HostRateLimiter(1_000);
    limiter.delayFor("slow.example.com", { intervalMs: 1_000, crawlDelayMs: 30_000 });
    const second = limiter.delayFor("slow.example.com", { intervalMs: 1_000 });
    assert.ok(second >= 29_000, `the site asked for 30s; we waited ${second}`);
  });

  it("ignores a Crawl-delay shorter than our own interval", () => {
    // A site saying "1s is fine" does not license us to be faster than the
    // operator configured.
    const limiter = new HostRateLimiter(10_000);
    limiter.delayFor("fast.example.com", { intervalMs: 10_000, crawlDelayMs: 1_000 });
    const second = limiter.delayFor("fast.example.com", { intervalMs: 10_000 });
    assert.ok(second >= 9_000, `expected our 10s floor, got ${second}`);
  });

  it("reserves the slot even when the wait is zero", () => {
    // `delayFor` is an acquire, not a query. If it did not reserve on the
    // zero-wait path, every caller would see zero forever — which is exactly
    // what a per-item limiter did.
    const limiter = new HostRateLimiter(5_000);
    assert.equal(limiter.delayFor("example.com"), 0);
    assert.ok(limiter.delayFor("example.com") > 0);
  });

  it("tracks the hosts it is pacing", () => {
    const limiter = new HostRateLimiter(1_000);
    limiter.delayFor("a.example.com");
    limiter.delayFor("b.example.com");
    assert.deepEqual(limiter.trackedHosts().sort(), ["a.example.com", "b.example.com"]);
  });

  it("prunes only entries whose window has elapsed", () => {
    // A worker-lifetime limiter would otherwise hold an entry per host ever
    // crawled. Pruning an *open* window would let the next request go early,
    // so only expired ones are dropped.
    const limiter = new HostRateLimiter(10_000);
    limiter.delayFor("open.example.com");
    limiter.delayFor("open.example.com"); // window now ~20s out

    const future = Date.now() + 5_000;
    assert.equal(limiter.pruneExpired(future), 0, "an open window must survive");
    assert.deepEqual(limiter.trackedHosts(), ["open.example.com"]);

    const farFuture = Date.now() + 60_000;
    assert.equal(limiter.pruneExpired(farFuture), 1);
    assert.deepEqual(limiter.trackedHosts(), []);
  });

  it("discards state for hosts no longer being crawled", () => {
    const limiter = new HostRateLimiter(1_000);
    limiter.delayFor("keep.example.com");
    limiter.delayFor("drop.example.com");
    limiter.prune(new Set(["keep.example.com"]));
    assert.deepEqual(limiter.trackedHosts(), ["keep.example.com"]);
  });

  it("paces a realistic burst at the configured rate", () => {
    // The scenario that failed: eight items queued against one host at six
    // requests per minute. The eighth must be told to wait about seventy
    // seconds — which is also why the wait has to happen outside the
    // per-item deadline, or a correctly-paced item would time out.
    const limiter = new HostRateLimiter(intervalForRpm(6));
    const waits = Array.from({ length: 8 }, () =>
      limiter.delayFor("httpbin.org", { intervalMs: intervalForRpm(6) }),
    );
    assert.equal(waits[0], 0);
    assert.ok(waits[7]! >= 69_000, `the eighth request waited ${waits[7]}ms`);
    // Strictly increasing, one interval apart.
    for (let i = 1; i < waits.length; i += 1) {
      assert.ok(waits[i]! > waits[i - 1]!, `wait ${i} did not increase`);
    }
  });
});
