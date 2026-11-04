/**
 * robots.txt evaluation.
 *
 * Two bugs found by a crawl experiment are pinned here, both in the direction
 * that matters most — a wrong robots decision either loses content we were
 * welcome to take, or takes content we were asked to leave.
 *
 *   1. Decisions were made from a 16,000-character *excerpt* of the file,
 *      stored "so an operator can see what we obeyed". For any host with a
 *      larger robots.txt, the file obeyed was not the file fetched. Wikipedia's
 *      is 28 KB: the real file allows `/wiki/Design`, the excerpt appeared to
 *      forbid it.
 *
 *   2. Any 4xx other than 404/410 was treated as "do not crawl". RFC 9309
 *      §2.3.1.3 says a 4xx means robots.txt is *unavailable* and the crawler
 *      may proceed. W3C answers 403 on robots.txt behind its WAF and was
 *      silently excluded.
 *
 * `evaluateRobots` is pure, so everything here runs without a network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RobotsRules, evaluateRobots } from "@uxd/crawler";

const UA = "uxdisrupt-research";

/** A rules object in whatever state a test needs. */
function rules(overrides: Partial<RobotsRules> = {}): RobotsRules {
  const now = new Date();
  return {
    origin: "https://example.com",
    status: "allowed",
    body: null,
    bodyExcerpt: null,
    bodyTruncated: false,
    httpStatus: 200,
    fetchFailed: false,
    crawlDelayMs: null,
    sitemapUrls: [],
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
    ...overrides,
  };
}

const decide = (r: RobotsRules | null, url = "https://example.com/page") =>
  evaluateRobots(r, url, { userAgent: UA, respectRobots: true });

describe("evaluateRobots — the override", () => {
  it("short-circuits when an operator has overridden robots", () => {
    const d = evaluateRobots(rules({ status: "disallowed" }), "https://example.com/x", {
      userAgent: UA,
      respectRobots: false,
    });
    assert.equal(d.allowed, true);
    assert.match(d.reason, /overridden/i);
  });

  it("still reports a Crawl-delay when overridden", () => {
    // Overriding the rules is not licence to ignore the pacing the host asked
    // for; the delay is still surfaced to the limiter.
    const d = evaluateRobots(rules({ crawlDelayMs: 5_000 }), "https://example.com/x", {
      userAgent: UA,
      respectRobots: false,
    });
    assert.equal(d.crawlDelayMs, 5_000);
  });
});

describe("evaluateRobots — failing closed on the unknown", () => {
  it("refuses when robots.txt could not be fetched at all", () => {
    // A status code is an answer; a DNS or TLS failure is the absence of one.
    const d = decide(rules({ status: "unreachable", fetchFailed: true, httpStatus: null }));
    assert.equal(d.allowed, false);
  });

  it("refuses when there are no rules to consult", () => {
    assert.equal(decide(null).allowed, false);
  });

  it("refuses when the file was too large to read in full", () => {
    // The dangerous case. A partial rule set is not a conservative
    // approximation of a complete one — the missing tail may be the part that
    // forbids something — so a truncated fetch is treated as no answer.
    const d = decide(rules({ status: "unreachable", bodyTruncated: true, fetchFailed: true }));
    assert.equal(d.allowed, false);
  });
});

describe("evaluateRobots — an unavailable file permits crawling", () => {
  it("allows when the host publishes no robots.txt", () => {
    const d = decide(rules({ status: "allowed", body: null, httpStatus: 404 }));
    assert.equal(d.allowed, true);
    assert.match(d.reason, /404/);
  });

  it("allows when the host answered 403 for robots.txt", () => {
    // RFC 9309 §2.3.1.3. This is the case that excluded W3C: a 403 on one file
    // is not a statement about a site's crawling policy, and a WAF in front of
    // robots.txt is common.
    const d = decide(rules({ status: "allowed", body: null, httpStatus: 403 }));
    assert.equal(d.allowed, true);
    assert.match(d.reason, /403/);
  });

  it("allows when the host answered 401 for robots.txt", () => {
    assert.equal(decide(rules({ status: "allowed", body: null, httpStatus: 401 })).allowed, true);
  });
});

describe("evaluateRobots — published rules are obeyed", () => {
  const body = [
    "User-agent: *",
    "Disallow: /private",
    "Disallow: /admin",
    "Allow: /private/public-bit",
    "",
    `User-agent: ${UA}`,
    "Disallow: /no-bots",
  ].join("\n");

  it("allows a path no rule matches", () => {
    assert.equal(decide(rules({ body }), "https://example.com/pricing").allowed, true);
  });

  it("refuses a disallowed path", () => {
    const d = decide(rules({ body }), "https://example.com/no-bots/thing");
    assert.equal(d.allowed, false);
    assert.match(d.reason, /disallows/i);
  });

  it("honours a more specific Allow inside a Disallow", () => {
    assert.equal(
      decide(rules({ body }), "https://example.com/private/public-bit").allowed,
      true,
    );
  });

  it("reports the Crawl-delay the host asked for", () => {
    const d = decide(rules({ body, crawlDelayMs: 7_500 }), "https://example.com/pricing");
    assert.equal(d.crawlDelayMs, 7_500);
  });
});

describe("evaluateRobots — decisions read the whole file", () => {
  /**
   * The regression that mattered most. A rule near the end of a large file has
   * to be obeyed, and a path the file permits has to stay permitted no matter
   * how far down the permitting context sits.
   */
  const padding = Array.from(
    { length: 2_000 },
    (_, i) => `Disallow: /generated/path-${i}`,
  ).join("\n");

  const bigBody = ["User-agent: *", padding, "Disallow: /the-very-last-rule"].join("\n");

  it("obeys a rule past the old 16,000-character cut", () => {
    assert.ok(bigBody.length > 40_000, `fixture is ${bigBody.length} bytes; must exceed the old cap`);
    const d = decide(rules({ body: bigBody }), "https://example.com/the-very-last-rule");
    assert.equal(d.allowed, false, "a Disallow past the old cut must still be obeyed");
  });

  it("does not invent a rule for a path the file permits", () => {
    // The visible symptom on Wikipedia: a permitted path reported as blocked,
    // citing a line number that says something else in the real file.
    const d = decide(rules({ body: bigBody }), "https://example.com/design");
    assert.equal(d.allowed, true);
  });

  it("obeys an early rule too, so the fix did not simply reverse the bug", () => {
    const d = decide(rules({ body: bigBody }), "https://example.com/generated/path-0");
    assert.equal(d.allowed, false);
  });
});
