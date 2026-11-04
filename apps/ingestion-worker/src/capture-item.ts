/**
 * Capturing one URL.
 *
 * Implements §26's layered strategy. The level a job permits is a ceiling, not
 * a target: this always starts at level 1 (a plain HTTP fetch, milliseconds,
 * almost no memory) and escalates to a browser only when the cheap path cannot
 * answer. Deciding that is `needsBrowser()` below.
 *
 * Every fetch — the page, robots.txt, discovered links — goes through the URL
 * guard. Nothing in this file reaches the network without it.
 */
import {
  BrowserPool,
  HostRateLimiter,
  type RobotsRules,
  captureWithBrowser,
  type FetchGuardedResult,
  type GuardedUrl,
  evaluateRobots,
  extractFromHtml,
  fetchGuarded,
  fetchRobots,
  guardUrl,
  intervalForRpm,
  isGuardPolicyRefusal,
  robotsOriginFor,
} from "@uxd/crawler";
import {
  type Logger,
  ErrorCode,
  resolveDiscoveredHref,
  sleep,
  validateUrl,
} from "@uxd/shared";
import {
  type CrawlJobConfig,
  type DeviceProfileKey,
  type MediaUsageRole,
  DEVICE_PROFILES,
} from "@uxd/types";
import type { ControlPlaneClient, LeasedItem } from "./control-plane.js";
import type { WorkerRuntimeConfig } from "./config.js";

export interface CaptureOutcome {
  readonly outcome: "succeeded" | "failed" | "blocked" | "skipped_limit";
  readonly retryable: boolean;
  readonly report: Record<string, unknown>;
}

export interface CaptureItemDeps {
  readonly client: ControlPlaneClient;
  readonly pool: BrowserPool;
  readonly limiter: HostRateLimiter;
  readonly runtime: WorkerRuntimeConfig;
  readonly logger: Logger;
  readonly robotsCache: Map<string, RobotsRules>;
}

/**
 * Should this page be rendered in a browser?
 *
 * Answered from the level-1 response, so the decision costs one cheap fetch
 * rather than a browser launch. A job that only needs metadata never starts
 * Chromium at all, which is the whole economic argument of §26.
 */
function needsBrowser(input: {
  readonly config: CrawlJobConfig;
  readonly html: string | null;
  readonly wordCount: number;
  readonly hasTitle: boolean;
}): { needed: boolean; reason: string } {
  if (input.config.maxCaptureLevel < 2) {
    return { needed: false, reason: "This job is metadata-only (capture level 1)." };
  }
  // A triage thumbnail requires a browser by definition.
  if (input.config.capturePreview) {
    return { needed: true, reason: "The job asks for preview thumbnails." };
  }
  if (input.html === null) {
    return { needed: true, reason: "The plain fetch returned no HTML to read." };
  }
  // A shell page with almost no text and a script tag is a client-rendered
  // app: the HTTP response is not what a visitor sees.
  if (input.wordCount < 50 && /<script/i.test(input.html)) {
    return {
      needed: true,
      reason: "The HTML has almost no text and loads scripts, so the page renders client side.",
    };
  }
  if (!input.hasTitle) {
    return { needed: true, reason: "The HTML had no title, which usually means it renders client side." };
  }
  return { needed: false, reason: "The plain fetch produced usable metadata." };
}

export async function captureItem(
  deps: CaptureItemDeps,
  item: LeasedItem,
): Promise<CaptureOutcome> {
  const { client, logger, runtime } = deps;
  const config = item.config;
  const startedAt = new Date();

  const baseReport = {
    itemId: item.id,
    leaseToken: item.leaseToken,
    requestedUrl: item.url,
    finalUrl: item.url,
    depth: item.depth,
    // Discovery produces candidates, not content. The field stays on the
    // report for the queue's own bookkeeping and is no longer a job setting.
    contentKind: "page" as const,
    platform: "web" as const,
    startedAt: startedAt.toISOString(),
  };

  const failure = (
    code: string,
    message: string,
    options: { outcome?: "failed" | "blocked" | "skipped_limit"; retryable?: boolean } = {},
  ): CaptureOutcome => ({
    outcome: options.outcome ?? "failed",
    retryable: options.retryable ?? true,
    report: {
      ...baseReport,
      outcome: options.outcome ?? "failed",
      retryable: options.retryable ?? true,
      captureStatus: "failed",
      method: "http_fetch",
      captureLevel: 1,
      errorCode: code,
      errorMessage: message,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      media: [],
      signals: {},
      discoveredUrls: [],
      warnings: [],
      browserErrors: [],
      headings: [],
      redirectChain: [],
    },
  });

  // --- Guard -----------------------------------------------------------
  const guarded = await guardUrl(item.url, {
    blockedDomains: runtime.blockedDomains,
    logger,
  });
  if (!guarded.ok) {
    // "Not allowed" and "could not tell" are different outcomes. Only the
    // former is a block the operator should treat as final; a DNS failure is
    // infrastructure and has to stay retryable, or one bad resolver moment
    // silently deletes a batch of perfectly good URLs.
    const refused = isGuardPolicyRefusal(guarded.error.kind);
    logger.warn(refused ? "Refused a leased URL" : "Could not resolve a leased URL", {
      url: item.url,
      reason: guarded.error.message,
      kind: guarded.error.kind,
    });
    return failure(guarded.error.errorCode, guarded.error.message, {
      outcome: refused ? "blocked" : "failed",
      retryable: !refused,
    });
  }

  // --- robots.txt -------------------------------------------------------
  const origin = robotsOriginFor(guarded.value.parsed.fetchUrl);
  if (origin && config.respectRobots) {
    const rules = await resolveRobots(deps, origin);
    // robots.txt path matching is against the path the server will see, so
    // the fetch target is the right input rather than the dedupe key.
    const decision = evaluateRobots(rules, guarded.value.parsed.fetchUrl, {
      userAgent: runtime.userAgent,
      respectRobots: true,
    });
    if (!decision.allowed) {
      await client.logEvent(item.jobId, {
        level: "warn",
        code: "robots_disallowed",
        itemId: item.id,
        message: decision.reason,
      });
      return failure(ErrorCode.ROBOTS_DISALLOWED, decision.reason, {
        outcome: "blocked",
        retryable: false,
      });
    }
    // The job's own rate limit was already paid before this item's deadline
    // started (see `main.ts`). What can only be known here is a `Crawl-delay`
    // the host declares in robots.txt, which may be longer than our own
    // interval — so the slot is re-reserved with that floor, and any extra
    // wait is honoured. Usually zero.
    const waitMs = deps.limiter.delayFor(guarded.value.parsed.host, {
      crawlDelayMs: decision.crawlDelayMs,
      intervalMs: 0,
    });
    if (waitMs > 0) {
      deps.logger.debug("Honouring a declared Crawl-delay", {
        host: guarded.value.parsed.host,
        waitMs,
      });
      await sleep(waitMs);
    }
  }

  // --- Level 1: HTTP fetch ---------------------------------------------
  const fetched = await fetchGuarded(guarded.value.parsed.fetchUrl, {
    userAgent: runtime.userAgent,
    timeoutMs: Math.min(config.navigationTimeoutMs, runtime.navTimeoutMs),
    maxBytes: runtime.maxPageBytes,
    maxRedirects: runtime.maxRedirects,
    guardPolicy: { blockedDomains: runtime.blockedDomains, logger },
    logger,
  });

  if (!fetched.ok) {
    // A browser sometimes succeeds where a plain fetch fails — bot protection
    // that checks for a real user agent stack, TLS fingerprinting — so escalate
    // rather than giving up, if the job allows a browser at all.
    if (config.maxCaptureLevel >= 2) {
      logger.debug("HTTP fetch failed; escalating to the browser", {
        url: item.url,
        reason: fetched.error.message,
      });
      return captureWithBrowserLevel(deps, item, guarded.value, startedAt, baseReport, null);
    }
    return failure(fetched.error.errorCode, fetched.error.message, {
      retryable: fetched.error.kind !== "BLOCKED_HOSTNAME" && fetched.error.kind !== "INVALID_URL",
    });
  }

  const response = fetched.value;
  const html = response.bodyText;
  const extracted = html
    ? extractFromHtml(html, {
        pageUrl: response.finalUrl,
        includeSubdomains: config.includeSubdomains,
      })
    : null;

  // A 4xx/5xx page is a failed capture, not a page worth publishing.
  if (response.httpStatus >= 400) {
    return failure(
      ErrorCode.NAVIGATION_FAILED,
      `The page returned HTTP ${response.httpStatus}.`,
      { retryable: response.httpStatus >= 500 || response.httpStatus === 429 },
    );
  }

  // A body that is not text is not a web page. `bodyText` is null whenever the
  // content type is not textual — a PDF, an image, a binary blob — and the
  // pipeline would otherwise report `succeeded` for it while storing no title,
  // no text and no content hash. That is the worst of the available outcomes:
  // change detection can never compare the record against a later capture,
  // and the operator is shown a success. An audit run surfaced exactly one of
  // these and it took a database integrity check to notice, because nothing in
  // the CMS distinguishes it from a real page.
  //
  // Escalating to a browser would not help: Chromium renders a PDF or an image
  // in a viewer, and a screenshot of a viewer is not the document.
  if (html === null) {
    return failure(
      ErrorCode.NAVIGATION_FAILED,
      `This URL returned ${response.contentType || "a non-text response"}, not a web page.`,
      { retryable: false },
    );
  }

  const decision = needsBrowser({
    config,
    html,
    wordCount: extracted?.wordCount ?? 0,
    hasTitle: Boolean(extracted?.title),
  });

  if (decision.needed) {
    logger.debug("Escalating to browser capture", { url: item.url, reason: decision.reason });
    return captureWithBrowserLevel(deps, item, guarded.value, startedAt, baseReport, response);
  }

  // --- Level 1 result ---------------------------------------------------
  const finishedAt = new Date();
  return {
    outcome: "succeeded",
    retryable: false,
    report: {
      ...baseReport,
      outcome: "succeeded",
      retryable: false,
      captureStatus: "succeeded",
      method: "http_fetch",
      captureLevel: 1,
      finalUrl: response.finalUrl,
      httpStatus: response.httpStatus,
      redirectChain: response.redirectChain,
      pageTitle: extracted?.title ?? null,
      pageDescription: extracted?.metaDescription ?? extracted?.ogDescription ?? null,
      ogTitle: extracted?.ogTitle ?? null,
      ogType: extracted?.ogType ?? null,
      canonicalUrl: extracted?.canonicalUrl ?? null,
      langAttr: extracted?.langAttr ?? null,
      h1: extracted?.h1 ?? null,
      headings: extracted?.headings.map((h) => h.text).slice(0, 50) ?? [],
      wordCount: extracted?.wordCount ?? null,
      contentHash: extracted?.contentHash ?? null,
      layoutHash: extracted?.layoutHash ?? null,
      domHash: extracted?.domHash ?? null,
      fullPage: false,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      loadTimeMs: response.durationMs,
      bytesTransferred: response.byteSize,
      media: [],
      signals: extracted?.signals ?? {},
      discoveredUrls: collectDiscovered(extracted, response.finalUrl, config),
      warnings: response.truncated
        ? [{ code: "TRUNCATED", message: "The page was larger than our size limit and was cut short." }]
        : [],
      browserErrors: [],
    },
  };
}

/** Level 2/3: render in Chromium, screenshot, optionally interact. */
async function captureWithBrowserLevel(
  deps: CaptureItemDeps,
  item: LeasedItem,
  guarded: GuardedUrl,
  startedAt: Date,
  baseReport: Record<string, unknown>,
  /** The level-1 response, when there was one. Used only for its status code. */
  httpResponse: FetchGuardedResult | null,
): Promise<CaptureOutcome> {
  const { client, logger, runtime } = deps;
  const config = item.config;

  // One profile, one viewport shot, no interactions. Discovery renders a page
  // to read its title and links when a plain fetch could not, and to take an
  // optional thumbnail — it is not photographing anything anyone will study.
  // The research image is captured later, by a person, in the studio.
  const profiles: DeviceProfileKey[] = [config.previewProfile];

  const result = await captureWithBrowser({
    pool: deps.pool,
    guarded,
    deviceProfiles: profiles,
    // Never. A full-page screenshot of a 20,000-pixel marketing site costs
    // seconds and megabytes, and discovery has no use for one.
    fullPage: false,
    viewport: config.capturePreview,
    userAgent: runtime.userAgent,
    navigationTimeoutMs: Math.min(config.navigationTimeoutMs, runtime.navTimeoutMs),
    totalTimeoutMs: Math.min(config.itemTimeoutMs, runtime.itemTimeoutMs),
    maxPageBytes: runtime.maxPageBytes,
    guardPolicy: { blockedDomains: runtime.blockedDomains, logger },
    interactionSteps: [],
    settleMs: 1_200,
    logger,
  });

  const finishedAt = new Date();

  if (!result.ok) {
    return {
      outcome: "failed",
      retryable: result.error.kind !== "BLOCKED_HOSTNAME" && result.error.kind !== "INVALID_URL",
      report: {
        ...baseReport,
        outcome: "failed",
        retryable: true,
        captureStatus: "failed",
        method: "browser_render",
        captureLevel: 2,
        errorCode: result.error.errorCode,
        errorMessage: result.error.message,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        media: [],
        signals: {},
        discoveredUrls: [],
        warnings: [],
        browserErrors: [],
        headings: [],
        redirectChain: [],
      },
    };
  }

  const capture = result.value;

  // --- Upload the screenshots -------------------------------------------
  const media: { mediaId: string; role: MediaUsageRole }[] = [];
  const warnings = [...capture.warnings];

  for (const shot of capture.screenshots) {
    const profile = DEVICE_PROFILES[shot.deviceProfile];
    const role: MediaUsageRole =
      shot.scope === "full_page"
        ? "screenshot_full_page"
        : profile.isMobile
          ? "screenshot_mobile"
          : "screenshot_desktop";
    try {
      const uploaded = await client.uploadMedia({
        bytes: shot.bytes,
        filename: `${shot.deviceProfile}-${shot.scope}.png`,
        contentType: "image/png",
        sourceUrl: capture.finalUrl,
        viewportWidth: profile.width,
        viewportHeight: profile.height,
        deviceScaleFactor: profile.deviceScaleFactor,
        deviceProfile: shot.deviceProfile,
        browserName: capture.browserName,
        browserVersion: capture.browserVersion,
        screenshotScope: shot.scope,
        altText: capture.extracted.title ? `${capture.extracted.title} — ${shot.label}` : shot.label,
      });
      media.push({ mediaId: uploaded.mediaId, role });
    } catch (error) {
      // A failed upload must not throw away a successful capture: report what
      // did store and let the operator retry the item if they want the rest.
      logger.warn("Screenshot upload failed", { url: item.url, scope: shot.scope, error });
      warnings.push({
        code: "STORAGE_FAILED",
        message: `The ${shot.label} screenshot could not be saved.`,
      });
    }
  }

  // --- Interaction before/after states (§8) -----------------------------
  for (const interaction of capture.interactions) {
    for (const [state, shot] of [
      ["before_state", interaction.beforeScreenshot],
      ["after_state", interaction.afterScreenshot],
    ] as const) {
      if (!shot) continue;
      try {
        const uploaded = await client.uploadMedia({
          bytes: shot.bytes,
          filename: `${interaction.step.type}-${state}.png`,
          contentType: "image/png",
          sourceUrl: capture.finalUrl,
          deviceProfile: shot.deviceProfile,
          screenshotScope: shot.scope,
          browserName: capture.browserName,
          browserVersion: capture.browserVersion,
          altText: `${interaction.step.type} — ${state.replace("_", " ")}`,
        });
        media.push({ mediaId: uploaded.mediaId, role: state });
      } catch (error) {
        logger.warn("Interaction screenshot upload failed", { error });
      }
    }
    if (!interaction.succeeded) {
      warnings.push({ code: "INTERACTION_FAILED", message: interaction.note });
    }
  }

  const primaryProfile = DEVICE_PROFILES[profiles[0]!];

  return {
    outcome: "succeeded",
    retryable: false,
    report: {
      ...baseReport,
      outcome: "succeeded",
      retryable: false,
      captureStatus: "succeeded",
      method: "browser_render",
      captureLevel: 2,
      finalUrl: capture.finalUrl,
      httpStatus: capture.httpStatus ?? httpResponse?.httpStatus ?? null,
      redirectChain: capture.redirectChain,
      pageTitle: capture.extracted.title,
      pageDescription: capture.extracted.metaDescription ?? capture.extracted.ogDescription,
      ogTitle: capture.extracted.ogTitle,
      ogType: capture.extracted.ogType,
      canonicalUrl: capture.extracted.canonicalUrl,
      langAttr: capture.extracted.langAttr,
      h1: capture.extracted.h1,
      headings: capture.extracted.headings.map((h) => h.text).slice(0, 50),
      wordCount: capture.extracted.wordCount,
      contentHash: capture.extracted.contentHash,
      layoutHash: capture.extracted.layoutHash,
      domHash: capture.extracted.domHash,
      pageWidth: capture.pageWidth,
      pageHeight: capture.pageHeight,
      viewportWidth: primaryProfile.width,
      viewportHeight: primaryProfile.height,
      deviceProfile: profiles[0],
      deviceClass: primaryProfile.deviceClass,
      deviceScaleFactor: primaryProfile.deviceScaleFactor,
      fullPage: false,
      browserName: capture.browserName,
      browserVersion: capture.browserVersion,
      userAgent: capture.userAgent,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      loadTimeMs: capture.loadTimeMs,
      resourceCount: capture.resourceCount,
      bytesTransferred: capture.bytesTransferred,
      media,
      signals: capture.extracted.signals,
      discoveredUrls: collectDiscovered(capture.extracted, capture.finalUrl, config),
      warnings,
      browserErrors: capture.browserErrors,
    },
  };
}

/**
 * Which discovered links to report.
 *
 * The worker applies scope and shape filters here; the control plane applies
 * the *limits* (depth, per-domain, total) when it queues them, because only it
 * can see the job's true totals across every worker. A worker cannot expand its
 * own crawl by over-reporting.
 */
function collectDiscovered(
  extracted: ReturnType<typeof extractFromHtml> | null,
  pageUrl: string,
  config: CrawlJobConfig,
): string[] {
  if (!extracted || !config.crawlInternalLinks) return [];

  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const allowedHosts = new Set<string>([pageHost, ...config.additionalAllowedHosts.map((h) => h.toLowerCase())]);
  const out = new Set<string>();

  for (const link of extracted.links) {
    if (out.size >= 500) break;
    const resolved = resolveDiscoveredHref(link.url, pageUrl);
    if (!resolved) continue;

    const parsed = validateUrl(resolved, { assumeHttps: false });
    if (!parsed.ok) continue;

    if (config.restrictToSubmittedDomains) {
      const host = parsed.value.host;
      const inScope =
        allowedHosts.has(host) ||
        (config.includeSubdomains && [...allowedHosts].some((allowed) => host.endsWith(`.${allowed}`)));
      if (!inScope) continue;
    }

    // The fetch target, not the dedupe key: this string is enqueued and
    // later requested, and enqueueing the slash-stripped form would
    // reintroduce the redirect loop one job later. Deduplication still
    // works, because the queue dedupes on `normalizedUrlHash`.
    out.add(parsed.value.fetchUrl);
  }

  return [...out];
}

/**
 * robots.txt, from the shared cache when possible.
 *
 * Checked in three places in order — this worker's memory, the control plane's
 * cache, then the network — so a 250-URL job across six domains fetches six
 * robots files rather than 250, even with several workers running.
 */
async function resolveRobots(deps: CaptureItemDeps, origin: string): Promise<RobotsRules | null> {
  const cached = deps.robotsCache.get(origin);
  if (cached && cached.expiresAt.getTime() > Date.now()) return cached;

  const shared = (await deps.client.getRobots(origin).catch(() => null)) as
    | (Omit<RobotsRules, "fetchedAt" | "expiresAt"> & { fetchedAt: string; expiresAt: string })
    | null;
  if (shared) {
    const rules: RobotsRules = {
      ...shared,
      // Never cached when truncated (see below), so anything read back is a
      // complete file. `bodyExcerpt` is display-only and not transported.
      bodyTruncated: false,
      bodyExcerpt: null,
      fetchedAt: new Date(shared.fetchedAt),
      expiresAt: new Date(shared.expiresAt),
    };
    deps.robotsCache.set(origin, rules);
    return rules;
  }

  const fetched = await fetchRobots(origin, {
    userAgent: deps.runtime.userAgent,
    timeoutMs: 10_000,
    logger: deps.logger,
  });
  deps.robotsCache.set(origin, fetched);

  // Share it with sibling workers, so a 250-URL job across six domains fetches
  // six robots files rather than 250. A file that hit the size cap is *not*
  // shared: siblings parse what they read back, and caching a partial rule set
  // would spread a wrong decision to every worker instead of one.
  if (!fetched.bodyTruncated) {
    await deps.client.putRobots({
      origin: fetched.origin,
      status: fetched.status,
      body: fetched.body,
      bodyTruncated: false,
      httpStatus: fetched.httpStatus,
      fetchFailed: fetched.fetchFailed,
      crawlDelayMs: fetched.crawlDelayMs,
      sitemapUrls: fetched.sitemapUrls,
      expiresAt: fetched.expiresAt.toISOString(),
    });
  }
  return fetched;
}

/** Build the per-host rate limiter for a job's configuration. */
export function limiterForConfig(config: CrawlJobConfig): HostRateLimiter {
  return new HostRateLimiter(intervalForRpm(config.requestsPerMinutePerDomain));
}
