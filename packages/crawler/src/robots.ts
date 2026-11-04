/**
 * robots.txt fetching and evaluation.
 *
 * Respected by default. Overriding it requires an explicit per-job flag *and* a
 * written reason, which is recorded in the audit log (see
 * `crawlJobConfigSchema.robotsOverrideReason` and the `crawl.robots_overridden`
 * audit action).
 *
 * The fetch goes through the same URL guard as any other request, because
 * `https://<attacker-host>/robots.txt` is as much an SSRF vector as the page
 * itself.
 *
 * `unreachable` is treated as "do not crawl" under `respectRobots`, not as
 * "no rules". A host that is failing to serve robots.txt has not given us
 * permission; assuming permission from an error is how a crawler ends up
 * hammering a site that was trying to tell it to stop.
 */
import robotsParserModule from "robots-parser";
import { type Logger, minutes, sanitizeText } from "@uxd/shared";
import type { RobotsStatus } from "@uxd/types";
import { fetchGuarded } from "./http-client.js";

/**
 * robots-parser is CommonJS (`module.exports = fn`) but ships a `.d.ts` that
 * declares an ESM default export, so the two disagree under nodenext
 * resolution. Normalising both shapes at the boundary — and declaring the
 * surface we use — is more robust than depending on which interop the bundler
 * happens to apply.
 */
interface RobotsRuleSet {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
  getMatchingLineNumber(url: string, userAgent?: string): number;
  getCrawlDelay(userAgent?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
}
type RobotsParserFn = (url: string, robotsTxt: string) => RobotsRuleSet;

const robotsParser: RobotsParserFn =
  typeof robotsParserModule === "function"
    ? (robotsParserModule as unknown as RobotsParserFn)
    : ((robotsParserModule as unknown as { default: RobotsParserFn }).default);

export interface RobotsRules {
  readonly origin: string;
  readonly status: RobotsStatus;
  /**
   * The rules, in full, exactly as served.
   *
   * **Decisions are made from this and only this.** It used to hold a
   * 16,000-character excerpt kept "so an operator can see what we obeyed",
   * and `evaluateRobots` then re-parsed that excerpt — so for any host whose
   * robots.txt is larger, the file we obeyed was not the file we fetched.
   *
   * A crawl experiment caught it on Wikipedia, whose robots.txt is 28 KB: the
   * real file allows `/wiki/Design`, the truncated copy appeared to disallow
   * it, and the crawl reported a matching rule at a line number that says
   * something else entirely in the real file. Over-blocking was the visible
   * symptom; the dangerous direction is the other one — a `Disallow` falling
   * after the cut would have been silently ignored.
   */
  readonly body: string | null;
  /** Short, sanitised copy for display in the CMS. Never parsed. */
  readonly bodyExcerpt: string | null;
  /**
   * True when the *fetch* hit `MAX_ROBOTS_BYTES`.
   *
   * A partial file is not a weaker version of a complete one — the missing tail
   * may be the part that forbids something — so this forces `unreachable`
   * rather than allowing a partial parse.
   */
  readonly bodyTruncated: boolean;
  readonly httpStatus: number | null;
  readonly fetchFailed: boolean;
  readonly crawlDelayMs: number | null;
  readonly sitemapUrls: readonly string[];
  readonly fetchedAt: Date;
  readonly expiresAt: Date;
}

export interface RobotsDecision {
  readonly allowed: boolean;
  /** Sentence for the crawl log. */
  readonly reason: string;
  /** Crawl-delay the host asked for, if any. */
  readonly crawlDelayMs: number | null;
}

/** How long a fetched robots.txt is trusted. */
export const ROBOTS_TTL_MS = minutes(60);
/** Cap on the body we will read; a robots.txt larger than this is not a
 * robots.txt, and Google itself stops at 500KiB. */
const MAX_ROBOTS_BYTES = 512 * 1024;

export interface FetchRobotsOptions {
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/** `scheme://host[:port]` — the scope a robots.txt applies to. */
export function robotsOriginFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export async function fetchRobots(
  origin: string,
  options: FetchRobotsOptions,
): Promise<RobotsRules> {
  const now = new Date();
  const base: Omit<
    RobotsRules,
    | "status"
    | "body"
    | "bodyExcerpt"
    | "bodyTruncated"
    | "httpStatus"
    | "fetchFailed"
    | "crawlDelayMs"
    | "sitemapUrls"
  > = {
    origin,
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + ROBOTS_TTL_MS),
  };

  const result = await fetchGuarded(`${origin}/robots.txt`, {
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: MAX_ROBOTS_BYTES,
    accept: "text/plain,*/*;q=0.8",
    logger: options.logger,
  });

  if (!result.ok) {
    options.logger?.debug("robots.txt could not be fetched", { origin, reason: result.error.message });
    return {
      ...base,
      status: "unreachable",
      body: null,
      bodyExcerpt: null,
      bodyTruncated: false,
      httpStatus: null,
      fetchFailed: true,
      crawlDelayMs: null,
      sitemapUrls: [],
    };
  }

  const { httpStatus, bodyText } = result.value;

  // --- Status handling, per RFC 9309 §2.3.1 -----------------------------
  //
  // 429 and 5xx first, because they are the "try again later" cases and the
  // RFC is explicit that a server error means assume complete disallow
  // (§2.3.1.4). A rate-limit response is treated the same way: it is a
  // request to back off, not a licence to proceed without rules.
  if (httpStatus >= 500 || httpStatus === 429) {
    return {
      ...base,
      status: "unreachable",
      body: null,
      bodyExcerpt: null,
      bodyTruncated: false,
      httpStatus,
      fetchFailed: true,
      crawlDelayMs: null,
      sitemapUrls: [],
    };
  }

  // Any other 4xx means the file is *unavailable*, and §2.3.1.3 says the
  // crawler may then access any resource. That includes 401 and 403.
  //
  // This used to single out 404 and 410 as "no rules published" and treat
  // 401/403 as a deliberate gate meaning "do not crawl". Defensible, but not
  // what the standard says, and a crawl experiment showed what it costs: W3C
  // and w3.org both answer 403 on robots.txt — almost certainly a WAF in front
  // of the file rather than a crawling policy — and both were silently
  // excluded with the message "the host refused access to robots.txt, which we
  // treat as a request not to crawl". A 403 on one file is not a statement
  // about a site's crawling policy, and site operators reasonably expect
  // standard behaviour.
  //
  // Note the asymmetry that remains, and is deliberate: an unavailable
  // robots.txt permits crawling, but a robots.txt we could not fetch *at all*
  // (DNS failure, TLS failure, timeout — the `!result.ok` branch above) does
  // not. A status code is an answer; a network failure is the absence of one,
  // and failing closed on the unknown is the right default.
  if (httpStatus >= 400) {
    return {
      ...base,
      status: "allowed",
      body: null,
      bodyExcerpt: null,
      bodyTruncated: false,
      httpStatus,
      fetchFailed: false,
      crawlDelayMs: null,
      sitemapUrls: [],
    };
  }

  const body = bodyText ?? "";

  // A robots.txt larger than the cap was cut mid-file, and the missing tail
  // may be exactly the part that forbids something. Obeying a partial set of
  // rules is not a conservative approximation of obeying all of them, so this
  // is treated as not having read the file at all — which under
  // `respectRobots` means do not crawl.
  if (result.value.truncated) {
    options.logger?.warn("robots.txt exceeded the size cap and was not parsed", {
      origin,
      maxBytes: MAX_ROBOTS_BYTES,
    });
    return {
      ...base,
      status: "unreachable",
      body: null,
      bodyExcerpt: null,
      bodyTruncated: true,
      httpStatus,
      fetchFailed: true,
      crawlDelayMs: null,
      sitemapUrls: [],
    };
  }

  const parser = robotsParser(`${origin}/robots.txt`, body);
  const crawlDelaySeconds = parser.getCrawlDelay(options.userAgent);

  return {
    ...base,
    status: "allowed",
    // The full file, because this is what decisions are parsed from.
    body,
    // A separate short copy for the CMS to display. Sanitised, because it is
    // attacker-controlled text that ends up on a page; never parsed.
    bodyExcerpt: sanitizeText(body.slice(0, 16_000), { maxLength: 16_000, singleLine: false }),
    bodyTruncated: false,
    httpStatus,
    fetchFailed: false,
    crawlDelayMs:
      typeof crawlDelaySeconds === "number" && Number.isFinite(crawlDelaySeconds)
        ? Math.min(Math.round(crawlDelaySeconds * 1000), 60_000)
        : null,
    sitemapUrls: (parser.getSitemaps() ?? []).slice(0, 50),
  };
}

/**
 * Decide whether a specific URL may be fetched.
 *
 * `respectRobots: false` short-circuits to allowed, and the caller is
 * responsible for having recorded the operator's reason.
 */
export function evaluateRobots(
  rules: RobotsRules | null,
  url: string,
  options: { userAgent: string; respectRobots: boolean },
): RobotsDecision {
  if (!options.respectRobots) {
    return {
      allowed: true,
      reason: "robots.txt was deliberately overridden for this job.",
      crawlDelayMs: rules?.crawlDelayMs ?? null,
    };
  }

  if (!rules) {
    return {
      allowed: false,
      reason: "robots.txt has not been checked for this host yet.",
      crawlDelayMs: null,
    };
  }

  if (rules.fetchFailed) {
    return {
      allowed: false,
      // The conservative reading: an error is not permission.
      reason:
        "robots.txt could not be fetched, so we are not assuming permission. Retry later, or override for this job.",
      crawlDelayMs: null,
    };
  }

  if (rules.status === "disallowed") {
    // Only reachable now when something other than a status code decided it.
    // Since 4xx became `allowed` (RFC 9309 §2.3.1.3), a status code no longer
    // produces this state, so the message no longer claims a 403.
    return {
      allowed: false,
      reason: "This host's robots.txt disallows crawling.",
      crawlDelayMs: null,
    };
  }

  // No body means no rules apply to us — either nothing was published (404) or
  // the file was unavailable (4xx). Both permit crawling.
  if (!rules.body) {
    return {
      allowed: true,
      reason:
        rules.httpStatus !== null && rules.httpStatus >= 400
          ? `This host answered ${rules.httpStatus} for robots.txt, so no rules apply.`
          : "This host publishes no robots.txt.",
      crawlDelayMs: null,
    };
  }

  const parser = robotsParser(`${rules.origin}/robots.txt`, rules.body);
  const allowed = parser.isAllowed(url, options.userAgent);

  // `isAllowed` returns undefined when it cannot decide (a malformed file).
  // Treat that as permitted: the file exists and did not name this path.
  if (allowed === undefined) {
    return {
      allowed: true,
      reason: "robots.txt does not have a rule covering this path.",
      crawlDelayMs: rules.crawlDelayMs,
    };
  }

  return {
    allowed,
    reason: allowed
      ? "robots.txt permits this path for our user agent."
      : `robots.txt disallows this path for our user agent (${matchedRule(parser, url, options.userAgent)}).`,
    crawlDelayMs: rules.crawlDelayMs,
  };
}

function matchedRule(parser: RobotsRuleSet, url: string, userAgent: string): string {
  try {
    const rule = parser.getMatchingLineNumber(url, userAgent);
    return typeof rule === "number" && rule > 0 ? `robots.txt line ${rule}` : "matched a Disallow rule";
  } catch {
    return "matched a Disallow rule";
  }
}

export function robotsExpired(rules: RobotsRules | { expiresAt: Date }): boolean {
  return rules.expiresAt.getTime() <= Date.now();
}

/**
 * Per-host request pacing.
 *
 * Enforces the stricter of the job's configured rate and the host's declared
 * Crawl-delay, in-process per worker. This is not a distributed rate limiter:
 * with several workers, each paces itself, so the aggregate rate scales with
 * worker count. That is documented as a known limitation — the correct fix is a
 * shared token bucket, which is only worth building once there are enough
 * workers for it to matter.
 */
export class HostRateLimiter {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly defaultIntervalMs: number;

  constructor(defaultIntervalMs: number) {
    this.defaultIntervalMs = defaultIntervalMs;
  }

  /**
   * Milliseconds to wait before the next request to this host, reserving the
   * slot as a side effect.
   *
   * **This instance must outlive a single request.** All of its state is the
   * `nextAllowedAt` map, so a limiter constructed per item has nothing to
   * remember and returns 0 every time — a rate limit that silently does not
   * limit, which is worse than none because the operator believes they are
   * being polite. A crawl experiment found exactly that: one shared host was
   * sent eight requests with no pacing and started throttling us.
   *
   * `intervalMs` is per call because the rate is a property of the *job*, and
   * one worker serves jobs with different rates. Passing it here lets a single
   * worker-lifetime limiter pace all of them correctly.
   */
  delayFor(
    host: string,
    options: { readonly intervalMs?: number; readonly crawlDelayMs?: number | null } = {},
  ): number {
    const interval = Math.max(options.intervalMs ?? this.defaultIntervalMs, options.crawlDelayMs ?? 0);
    const now = Date.now();
    const earliest = this.nextAllowedAt.get(host) ?? 0;
    const waitMs = Math.max(0, earliest - now);
    this.nextAllowedAt.set(host, Math.max(now, earliest) + interval);
    return waitMs;
  }

  /** Hosts currently being paced. For pruning and for diagnostics. */
  trackedHosts(): string[] {
    return [...this.nextAllowedAt.keys()];
  }

  /** Discard pacing state for hosts we are no longer crawling. */
  prune(activeHosts: ReadonlySet<string>): void {
    for (const host of this.nextAllowedAt.keys()) {
      if (!activeHosts.has(host)) this.nextAllowedAt.delete(host);
    }
  }

  /**
   * Discard entries whose interval has already elapsed.
   *
   * Safe to call at any time, which `prune` is not: dropping a host whose
   * window is still open would let the next request to it go out early. This
   * keeps a worker-lifetime limiter from accumulating an entry per host ever
   * crawled, without ever shortening a wait somebody is owed.
   */
  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [host, earliest] of this.nextAllowedAt) {
      if (earliest <= now) {
        this.nextAllowedAt.delete(host);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Requests-per-minute to a per-request interval. */
export function intervalForRpm(requestsPerMinute: number): number {
  return Math.ceil(60_000 / Math.max(1, requestsPerMinute));
}
