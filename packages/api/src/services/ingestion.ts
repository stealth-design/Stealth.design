/**
 * Ingestion (§4, §5, §6).
 *
 * Two phases, deliberately separate, because §5's workflow is
 * paste -> validate -> configure -> start and an operator has to see the
 * validation result *before* committing to a job:
 *
 *   `validateUrlBatch`  Pure-ish and fast. Normalises, deduplicates, applies
 *                       the URL guard and checks the database, then reports
 *                       every line in one of six buckets with a count. No
 *                       job is created and nothing is fetched.
 *
 *   `createIngestionJob` Takes the validated set plus a configuration and
 *                        writes the job, its submitted-URL audit rows, and its
 *                        queue items.
 *
 * Keeping them apart is what makes "paste 250 URLs, see that 42 are already in
 * the database, decide what to do about it, then start" possible.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requirePermission } from "@uxd/auth";
import {
  type Db,
  appendJobEvent,
  contentItems,
  crawlJobItems,
  crawlJobUrls,
  crawlJobs,
  enqueueItems,
  pageDetails,
  sources,
  urlRegistry,
} from "@uxd/database";
import { GUARD_FAILURE_KINDS, guardUrl, probeReachable } from "@uxd/crawler";
import {
  AppError,
  ErrorCode,
  type ParsedUrl,
  mapLimit,
  notFound,
  registrableDomain,
  shortId,
  slugify,
  splitPastedUrls,
  URL_REFUSAL_BUCKET,
  uuidv7,
  validateUrl,
} from "@uxd/shared";
import {
  type CrawlJobConfig,
  JOB_LIMITS,
  JOB_PRIORITY_WEIGHT,
  type UrlValidationOutcome,
  URL_VALIDATION_OUTCOME_META,
  crawlJobConfigSchema,
  estimateMaxItems,
} from "@uxd/types";
import { recordAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";

// --- Validation -----------------------------------------------------------

export interface ValidatedUrlRow {
  readonly lineNumber: number;
  readonly rawUrl: string;
  /** Dedupe identity. Lossy — see `ParsedUrl.normalized`. Never fetched. */
  readonly normalizedUrl: string | null;
  /**
   * What the worker should request.
   *
   * Carried separately from `normalizedUrl` because the queue stores the URL
   * to fetch, and the normalised form has its trailing slash stripped. An
   * audit run found jobs enqueuing `/3` for a site whose canonical path is
   * `/3/`, which cost a wasted request and a spurious redirect on every item —
   * and, before the fetch layer was fixed, an infinite redirect loop.
   */
  readonly fetchUrl: string | null;
  readonly normalizedUrlHash: string | null;
  readonly host: string | null;
  readonly outcome: UrlValidationOutcome;
  readonly reasonCode: string | null;
  readonly reasonMessage: string | null;
  /** For `already_in_database`: what we already have. */
  readonly existingContentId: string | null;
  readonly existingCaptureCount: number;
  readonly existingLastCapturedAt: Date | null;
  /** Whether this row is included in the job by default. */
  readonly included: boolean;
}

export interface ValidationSummary {
  readonly rows: readonly ValidatedUrlRow[];
  readonly counts: Readonly<Record<UrlValidationOutcome, number>>;
  readonly hostCount: number;
  readonly hosts: readonly { readonly host: string; readonly count: number }[];
  readonly totalSubmitted: number;
  readonly includedCount: number;
  readonly truncated: boolean;
}

export interface ValidateUrlBatchOptions {
  /** Run a network reachability pre-flight. Off by default: it is slow for a
   * large paste and a false "unreachable" discourages a valid URL. */
  readonly checkReachability?: boolean;
  /** Operator blocklist from settings. */
  readonly blockedDomains?: readonly string[];
  readonly userAgent?: string;
  readonly maxUrls?: number;
}

/**
 * Validate a batch of pasted URLs.
 *
 * The guard is applied here, at paste time, rather than only at capture time.
 * That means an operator who pastes `http://localhost:8080/admin` or
 * `http://169.254.169.254/` sees it refused with an explanation on the
 * validation screen, instead of watching the item fail later in a crawl log.
 */
export async function validateUrlBatch(
  db: Db,
  input: string | readonly string[],
  options: ValidateUrlBatchOptions = {},
): Promise<ValidationSummary> {
  const maxUrls = Math.min(options.maxUrls ?? JOB_LIMITS.maxUrlsPerJob, JOB_LIMITS.maxUrlsPerJob);
  // Accept either a pasted blob (split on newlines/commas/whitespace) or an
  // already-split list, which is what CSV and sitemap import produce.
  const candidates =
    typeof input === "string"
      ? splitPastedUrls(input, maxUrls + 1)
      : input.map((s) => s.trim()).filter((s) => s.length > 0);

  const truncated = candidates.length > maxUrls;
  const submitted = candidates.slice(0, maxUrls);

  // --- Pass 1: parse, normalise, detect in-batch duplicates -------------
  interface Interim {
    lineNumber: number;
    rawUrl: string;
    parsed: ParsedUrl | null;
    outcome: UrlValidationOutcome | null;
    reasonCode: string | null;
    reasonMessage: string | null;
  }

  const interim: Interim[] = [];
  const seenHashes = new Set<string>();

  for (const [index, rawUrl] of submitted.entries()) {
    const lineNumber = index + 1;
    const parsed = validateUrl(rawUrl, { assumeHttps: true });

    if (!parsed.ok) {
      // The bucket comes from the *reason*, not from the fact that the syntax
      // pass caught it. `validateUrl` checks both shape and policy, so this
      // branch legitimately produces both "you mistyped" and "we refuse this
      // address" — and an operator reading a 500-row validation report needs
      // to know which, because one means edit the list and the other means
      // talk to whoever set the policy.
      interim.push({
        lineNumber,
        rawUrl,
        parsed: null,
        outcome: URL_REFUSAL_BUCKET[parsed.error.reason],
        reasonCode: parsed.error.reason,
        reasonMessage: parsed.error.message,
      });
      continue;
    }

    if (seenHashes.has(parsed.value.hash)) {
      interim.push({
        lineNumber,
        rawUrl,
        parsed: parsed.value,
        outcome: "duplicate_in_batch",
        reasonCode: "DUPLICATE_IN_BATCH",
        reasonMessage: "This address appears more than once in what you pasted. It will be captured once.",
      });
      continue;
    }

    seenHashes.add(parsed.value.hash);
    interim.push({
      lineNumber,
      rawUrl,
      parsed: parsed.value,
      outcome: null,
      reasonCode: null,
      reasonMessage: null,
    });
  }

  // --- Pass 2: the URL guard, in parallel with a bounded fan-out --------
  const pending = interim.filter((row) => row.outcome === null && row.parsed !== null);

  await mapLimit(pending, 12, async (row) => {
    const guarded = await guardUrl(row.parsed!.normalized, {
      blockedDomains: options.blockedDomains,
    });
    if (!guarded.ok) {
      // A DNS failure is a *reachability* problem, not a policy refusal, and
      // §5 gives it its own bucket. Reporting "blocked" for a domain that
      // simply does not resolve tells an operator we refused it on purpose,
      // which sends them looking for a rule that does not exist.
      row.outcome =
        guarded.error.kind === GUARD_FAILURE_KINDS.DNS_FAILED ? "unreachable" : "blocked";
      row.reasonCode = guarded.error.kind;
      row.reasonMessage = guarded.error.message;
    }
  });

  // --- Pass 3: is it already in the database? --------------------------
  const stillPending = interim.filter((row) => row.outcome === null && row.parsed !== null);
  const hashes = stillPending.map((row) => row.parsed!.hash);

  const existing = new Map<
    string,
    { contentItemId: string | null; captureCount: number; lastCapturedAt: Date | null; blockedAt: Date | null; blockedReason: string | null }
  >();

  if (hashes.length > 0) {
    // Chunked, because a 5,000-URL paste would otherwise build an IN list far
    // beyond what Postgres will plan efficiently.
    for (let i = 0; i < hashes.length; i += 500) {
      const chunk = hashes.slice(i, i + 500);
      const rows = await db
        .select({
          hash: urlRegistry.normalizedUrlHash,
          contentItemId: urlRegistry.contentItemId,
          captureCount: urlRegistry.captureCount,
          lastCapturedAt: urlRegistry.lastCapturedAt,
          blockedAt: urlRegistry.blockedAt,
          blockedReason: urlRegistry.blockedReason,
        })
        .from(urlRegistry)
        .where(inArray(urlRegistry.normalizedUrlHash, chunk));
      for (const row of rows) existing.set(row.hash, row);
    }
  }

  for (const row of stillPending) {
    const known = existing.get(row.parsed!.hash);
    if (!known) continue;

    // A URL an operator previously blocked stays blocked, even when pasted
    // again later by someone who does not know that.
    if (known.blockedAt) {
      row.outcome = "blocked";
      row.reasonCode = "URL_BLOCKED";
      row.reasonMessage = known.blockedReason ?? "This address was blocked by an operator.";
      continue;
    }

    if (known.captureCount > 0) {
      row.outcome = "already_in_database";
      row.reasonCode = "ALREADY_CAPTURED";
      row.reasonMessage = `Captured ${known.captureCount} time${known.captureCount === 1 ? "" : "s"} before. Include it to record a new version and see what changed.`;
    }
  }

  // --- Pass 4: optional reachability pre-flight ------------------------
  if (options.checkReachability) {
    const toProbe = interim.filter((row) => row.outcome === null && row.parsed !== null);
    await mapLimit(toProbe, 8, async (row) => {
      const probe = await probeReachable(row.parsed!.normalized, {
        userAgent: options.userAgent ?? "uxdisrupt-research/0.1",
        timeoutMs: 6_000,
      });
      if (!probe.reachable) {
        row.outcome = "unreachable";
        row.reasonCode = "UNREACHABLE";
        row.reasonMessage = probe.reason ?? "The host did not respond.";
      }
    });
  }

  // --- Assemble --------------------------------------------------------
  const rows: ValidatedUrlRow[] = interim.map((row) => {
    const outcome = row.outcome ?? "valid";
    const known = row.parsed ? existing.get(row.parsed.hash) : undefined;
    return {
      lineNumber: row.lineNumber,
      rawUrl: row.rawUrl,
      normalizedUrl: row.parsed?.normalized ?? null,
      fetchUrl: row.parsed?.fetchUrl ?? null,
      normalizedUrlHash: row.parsed?.hash ?? null,
      host: row.parsed?.host ?? null,
      outcome,
      reasonCode: row.reasonCode,
      reasonMessage: row.reasonMessage,
      existingContentId: known?.contentItemId ?? null,
      existingCaptureCount: known?.captureCount ?? 0,
      existingLastCapturedAt: known?.lastCapturedAt ?? null,
      included: URL_VALIDATION_OUTCOME_META[outcome].includeByDefault,
    };
  });

  const counts = Object.fromEntries(
    (Object.keys(URL_VALIDATION_OUTCOME_META) as UrlValidationOutcome[]).map((outcome) => [
      outcome,
      rows.filter((r) => r.outcome === outcome).length,
    ]),
  ) as Record<UrlValidationOutcome, number>;

  // Host counts for the "42 URLs across 6 domains" line on the review screen.
  const hostCounts = new Map<string, number>();
  for (const row of rows) {
    if (!row.host) continue;
    hostCounts.set(row.host, (hostCounts.get(row.host) ?? 0) + 1);
  }
  const hosts = [...hostCounts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  return {
    rows,
    counts,
    hostCount: hosts.length,
    hosts,
    totalSubmitted: submitted.length,
    includedCount: rows.filter((r) => r.included).length,
    truncated,
  };
}

// --- Sitemap import -------------------------------------------------------

/**
 * Fetch a sitemap and return the URLs it lists (§16 "sitemap import").
 *
 * Nested sitemap indexes are followed one level only, and the total is capped.
 * A sitemap index can point at fifty thousand URLs, and an operator who pastes
 * one should get a reviewable set rather than an unbounded crawl.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: { readonly userAgent: string; readonly maxUrls?: number },
): Promise<{ urls: string[]; truncated: boolean; nestedFollowed: number; error: string | null }> {
  const { fetchGuarded } = await import("@uxd/crawler");
  const { parseSitemap } = await import("@uxd/crawler");
  const maxUrls = Math.min(options.maxUrls ?? 2_000, JOB_LIMITS.maxUrlsPerJob);

  const first = await fetchGuarded(sitemapUrl, {
    userAgent: options.userAgent,
    maxBytes: 20 * 1024 * 1024,
    accept: "application/xml,text/xml,*/*;q=0.8",
  });
  if (!first.ok) return { urls: [], truncated: false, nestedFollowed: 0, error: first.error.message };
  if (!first.value.bodyText) {
    return { urls: [], truncated: false, nestedFollowed: 0, error: "The sitemap was not readable as XML." };
  }

  const parsed = parseSitemap(first.value.bodyText, maxUrls);
  const urls = parsed.urls.map((u) => u.url);
  let nestedFollowed = 0;

  // Follow nested sitemaps until the cap is reached.
  for (const nested of parsed.nestedSitemaps.slice(0, 20)) {
    if (urls.length >= maxUrls) break;
    const child = await fetchGuarded(nested, {
      userAgent: options.userAgent,
      maxBytes: 20 * 1024 * 1024,
      accept: "application/xml,text/xml,*/*;q=0.8",
    });
    if (!child.ok || !child.value.bodyText) continue;
    nestedFollowed += 1;
    const childParsed = parseSitemap(child.value.bodyText, maxUrls - urls.length);
    urls.push(...childParsed.urls.map((u) => u.url));
  }

  return {
    urls: urls.slice(0, maxUrls),
    truncated: parsed.truncated || urls.length > maxUrls,
    nestedFollowed,
    error: null,
  };
}

// --- Job creation ---------------------------------------------------------

export interface CreateIngestionJobInput {
  readonly name: string;
  readonly config: unknown;
  /** The validated batch. Only rows with `included` become queue items. */
  readonly validation: ValidationSummary;
  /** Explicit overrides of which lines to include, keyed by line number. */
  readonly includeOverrides?: Readonly<Record<number, boolean>>;
  readonly notes?: string | null;
  /** Start immediately rather than leaving the job `ready`. */
  readonly startNow?: boolean;
}

export interface CreateIngestionJobResult {
  readonly jobId: string;
  readonly reference: string;
  readonly queuedCount: number;
  readonly submittedCount: number;
  readonly estimatedMaxItems: number;
  readonly status: string;
}

export async function createIngestionJob(
  context: AdminContext,
  input: CreateIngestionJobInput,
): Promise<CreateIngestionJobResult> {
  requirePermission(context.actor, "ingestion.create");

  // The config is validated by the same schema the worker reads, so a job that
  // validates here is a job the worker understands.
  const parsedConfig = crawlJobConfigSchema.safeParse(input.config);
  if (!parsedConfig.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "This job configuration is not valid.", {
      issues: parsedConfig.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const config: CrawlJobConfig = parsedConfig.data;

  // Overriding robots.txt is a separate, audited capability.
  if (!config.respectRobots) {
    requirePermission(context.actor, "ingestion.override_robots");
  }

  const included = input.validation.rows.filter((row) => {
    const override = input.includeOverrides?.[row.lineNumber];
    const include = override ?? row.included;
    // A blocked or invalid URL can never be included, whatever the override
    // says. This is the server-side enforcement of the validation screen's
    // checkboxes — a crafted request cannot smuggle a blocked address in.
    if (row.outcome === "blocked" || row.outcome === "invalid") return false;
    if (row.outcome === "duplicate_in_batch") return false;
    return include && row.fetchUrl !== null && row.normalizedUrlHash !== null;
  });

  if (included.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "No usable URLs were selected for this job.", {
      issues: [{ path: "urls", message: "Select at least one valid URL." }],
    });
  }

  const jobId = uuidv7();
  const reference = `JOB-${shortId(8)}`;

  return inTransaction(context, async (tx) => {
    await tx.db.insert(crawlJobs).values({
      id: jobId,
      reference,
      name: input.name.trim().slice(0, 200) || `Ingestion ${reference}`,
      module: config.module,
      status: input.startNow ? "queued" : "ready",
      priority: config.priority,
      config,
      sourceId: config.targetSourceId ?? null,
      submittedCount: input.validation.totalSubmitted,
      notes: input.notes?.slice(0, 5_000) ?? null,
      createdBy: context.actor.id,
    });

    // Record every submitted line, including the rejects (§5). An operator
    // returning to this job later can see that 42 of their 250 were already in
    // the database, rather than silently receiving 208.
    const urlRows = input.validation.rows.map((row) => ({
      id: uuidv7(),
      jobId,
      rawUrl: row.rawUrl.slice(0, 2_048),
      normalizedUrl: row.normalizedUrl,
      normalizedUrlHash: row.normalizedUrlHash,
      outcome: row.outcome,
      reasonCode: row.reasonCode,
      reasonMessage: row.reasonMessage,
      existingContentId: row.existingContentId,
      included: included.some((i) => i.lineNumber === row.lineNumber),
      lineNumber: row.lineNumber,
    }));
    for (let i = 0; i < urlRows.length; i += 500) {
      await tx.db.insert(crawlJobUrls).values(urlRows.slice(i, i + 500));
    }

    // Queue items for the included rows.
    const { inserted } = await enqueueItems(
      tx.db,
      included.map((row) => ({
        jobId,
        // The fetch target. The queue's `url` is what gets requested; its
        // `normalizedUrlHash` is what dedupes. Enqueueing the normalised form
        // here is what caused the redirect loop the audit found.
        url: row.fetchUrl ?? row.normalizedUrl!,
        normalizedUrlHash: row.normalizedUrlHash!,
        host: row.host ?? "",
        depth: 0,
        priority: config.priority,
        maxAttempts: config.maxAttempts,
      })),
    );

    await appendJobEvent(tx.db, {
      jobId,
      level: "info",
      code: "job_created",
      actor: context.actor.name,
      data: {
        submitted: input.validation.totalSubmitted,
        queued: inserted,
        hosts: input.validation.hostCount,
        ...input.validation.counts,
      },
    });
    await appendJobEvent(tx.db, {
      jobId,
      level: "info",
      code: "job_validated",
      data: input.validation.counts,
    });

    if (input.startNow) {
      await appendJobEvent(tx.db, {
        jobId,
        level: "info",
        code: "job_started",
        actor: context.actor.name,
      });
    }
    if (!config.respectRobots) {
      await appendJobEvent(tx.db, {
        jobId,
        level: "warn",
        code: "robots_overridden",
        actor: context.actor.name,
        data: { reason: config.robotsOverrideReason },
      });
      await recordAudit(tx.db, context, {
        action: "crawl.robots_overridden",
        entityType: "crawl_job",
        entityId: jobId,
        entityLabel: reference,
        context: { reason: config.robotsOverrideReason },
      });
    }

    await recordAudit(tx.db, context, {
      action: "crawl.job_created",
      entityType: "crawl_job",
      entityId: jobId,
      entityLabel: reference,
      context: {
        queued: inserted,
        submitted: input.validation.totalSubmitted,
        crawlInternalLinks: config.crawlInternalLinks,
        maxDepth: config.maxDepth,
      },
    });
    if (input.startNow) {
      await recordAudit(tx.db, context, {
        action: "crawl.job_started",
        entityType: "crawl_job",
        entityId: jobId,
        entityLabel: reference,
      });
    }

    return {
      jobId,
      reference,
      queuedCount: inserted,
      submittedCount: input.validation.totalSubmitted,
      estimatedMaxItems: estimateMaxItems(config, inserted),
      status: input.startNow ? "queued" : "ready",
    };
  });
}

/** Move a `ready` job to `queued` so workers can claim its items. */
export async function startJob(context: AdminContext, jobId: string): Promise<void> {
  requirePermission(context.actor, "ingestion.control");

  await inTransaction(context, async (tx) => {
    const [job] = await tx.db
      .select({ id: crawlJobs.id, reference: crawlJobs.reference, status: crawlJobs.status })
      .from(crawlJobs)
      .where(eq(crawlJobs.id, jobId))
      .limit(1);
    if (!job) throw notFound("Crawl job");

    if (!["ready", "draft", "completed", "completed_with_errors", "failed", "cancelled"].includes(job.status)) {
      throw new AppError(ErrorCode.CONFLICT, `This job is already ${job.status}.`);
    }

    // Only start if there is something to do.
    const [pending] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(crawlJobItems)
      .where(and(eq(crawlJobItems.jobId, jobId), eq(crawlJobItems.status, "pending")));
    if ((pending?.n ?? 0) === 0) {
      throw new AppError(
        ErrorCode.PRECONDITION_FAILED,
        "This job has no queued URLs left. Retry its failed items, or create a new job.",
      );
    }

    await tx.db
      .update(crawlJobs)
      .set({ status: "queued", finishedAt: null, updatedAt: new Date() })
      .where(eq(crawlJobs.id, jobId));

    await appendJobEvent(tx.db, {
      jobId,
      level: "info",
      code: "job_started",
      actor: context.actor.name,
    });
    await recordAudit(tx.db, context, {
      action: "crawl.job_started",
      entityType: "crawl_job",
      entityId: jobId,
      entityLabel: job.reference,
    });
  });
}

/**
 * Find or create the source a URL belongs to.
 *
 * Called during capture intake so that a pasted URL from a domain we have never
 * seen produces a real Source record rather than orphaned content. §3 makes the
 * Source the anchor for everything, so creating one implicitly here is what
 * keeps "show me everything from this product" true without asking the operator
 * to set the source up first.
 */
export async function resolveSourceForUrl(
  db: Db,
  parsed: ParsedUrl,
  options: { readonly createdBy?: string | null; readonly module?: string } = {},
): Promise<{ sourceId: string; created: boolean; blocked: boolean; blockedReason: string | null }> {
  // One website, one product. The site is the registrable domain, so a page
  // on app.notion.com finds the product added as www.notion.com instead of
  // quietly starting a second Notion. Rows from before `site` existed are
  // matched on their domain until the backfill reaches them.
  const site = registrableDomain(parsed.host);
  const [existing] = await db
    .select({
      id: sources.id,
      crawlBlockedAt: sources.crawlBlockedAt,
      crawlBlockedReason: sources.crawlBlockedReason,
    })
    .from(sources)
    .where(
      and(
        sql`${sources.deletedAt} is null`,
        or(
          eq(sources.site, site),
          and(
            isNull(sources.site),
            or(eq(sources.domain, site), sql`${sources.domain} like ${`%.${site}`}`),
          ),
        ),
      ),
    )
    // The product added for exactly this host wins over a sibling subdomain.
    .orderBy(sql`(${sources.domain} = ${parsed.host}) desc`, asc(sources.createdAt))
    .limit(1);

  if (existing) {
    return {
      sourceId: existing.id,
      created: false,
      blocked: existing.crawlBlockedAt !== null,
      blockedReason: existing.crawlBlockedReason,
    };
  }

  const sourceId = uuidv7();
  const name = site.replace(/\.[a-z.]+$/, "").replace(/^./, (c) => c.toUpperCase());

  await db
    .insert(sources)
    .values({
      id: sourceId,
      module: (options.module ?? "web") as "web",
      type: "website",
      name,
      slug: `${slugify(site)}-${shortId(4).toLowerCase()}`,
      domain: parsed.host,
      site,
      canonicalUrl: `${parsed.protocol}//${parsed.host}`,
      canonicalUrlHash: parsed.hash,
      status: "draft",
      health: "unknown",
      createdBy: options.createdBy ?? null,
    })
    // No conflict target: `sources_site_key` and `sources_domain_key` are both
    // partial unique indexes, and a concurrent capture may trip either. Doing
    // nothing on any of them and re-reading is what makes this race-safe.
    .onConflictDoNothing();

  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.site, site), sql`${sources.deletedAt} is null`))
    .limit(1);

  return {
    sourceId: row?.id ?? sourceId,
    created: row?.id === sourceId || !row,
    blocked: false,
    blockedReason: null,
  };
}

/** Priority weight for a job, exposed so the CMS can explain queue ordering. */
export function priorityWeight(config: CrawlJobConfig): number {
  return JOB_PRIORITY_WEIGHT[config.priority];
}

// --- Recapture ------------------------------------------------------------

export interface RecaptureSourceInput {
  /**
   * Only recapture content in these lifecycle statuses.
   *
   * Defaults to everything, because "refresh this source" usually means all of
   * it. Narrowing to `published` is the other common intent: keep what is live
   * accurate without re-opening records still in review.
   */
  readonly statuses?: readonly string[];
  /** Cap on how many of the source's URLs to queue. */
  readonly limit?: number;
  readonly startNow?: boolean;
  readonly notes?: string | null;
}

/**
 * Queue a recapture of everything already held for one source (§40).
 *
 * The URLs come from `page_details`, so this recaptures what we actually have
 * rather than re-crawling to rediscover it — which is the point of a recapture:
 * same addresses, new snapshot, so the change detection in `intakeCapture` has
 * something to compare against.
 *
 * Every URL is put back through `validateUrlBatch` even though each one was
 * captured successfully before. That is deliberate. A hostname's DNS can be
 * re-pointed at a private address between captures, a domain can lapse and be
 * re-registered, and robots policy can change; a URL that was safe in March is
 * not thereby safe in September. Re-validating costs one DNS resolution per
 * host and keeps the SSRF guard on the only path that reaches the worker.
 *
 * The result is an ordinary crawl job, so it appears in Crawl jobs with the
 * same controls, log and per-URL outcomes as any other run.
 */
export async function recaptureSource(
  context: AdminContext,
  sourceId: string,
  input: RecaptureSourceInput = {},
): Promise<CreateIngestionJobResult> {
  requirePermission(context.actor, "ingestion.create");

  const [source] = await context.db
    .select({
      id: sources.id,
      name: sources.name,
      domain: sources.domain,
      module: sources.module,
      crawlBlockedAt: sources.crawlBlockedAt,
      crawlBlockedReason: sources.crawlBlockedReason,
      requestsPerMinuteOverride: sources.requestsPerMinuteOverride,
    })
    .from(sources)
    .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
    .limit(1);
  if (!source) throw notFound("Source");

  // A source an operator has blocked stays blocked. Recapture is a bulk
  // action, and a bulk action is exactly where an operator-set block is most
  // likely to be forgotten.
  if (source.crawlBlockedAt) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Crawling is blocked for this source.", {
      issues: [
        {
          path: "sourceId",
          message: source.crawlBlockedReason ?? "Unblock the source before recapturing it.",
        },
      ],
    });
  }

  const limit = Math.min(input.limit ?? JOB_LIMITS.maxUrlsPerJob, JOB_LIMITS.maxUrlsPerJob);
  const conditions = [eq(contentItems.sourceId, sourceId), isNull(contentItems.deletedAt)];
  if (input.statuses?.length) {
    conditions.push(sql`${contentItems.status}::text in ${input.statuses}`);
  }

  const rows = await context.db
    .select({ url: pageDetails.url })
    .from(pageDetails)
    .innerJoin(contentItems, eq(contentItems.id, pageDetails.contentItemId))
    .where(and(...conditions))
    .orderBy(asc(pageDetails.url))
    .limit(limit);

  const urls = [...new Set(rows.map((row) => row.url))];
  if (urls.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "This source has no captured URLs to recapture.", {
      issues: [
        {
          path: "sourceId",
          message: input.statuses?.length
            ? "No content in the selected statuses has a captured URL."
            : "Capture something from this source first.",
        },
      ],
    });
  }

  const validation = await validateUrlBatch(context.db, urls);

  // Every one of these URLs will come back `already_in_database`, which is not
  // included by default — correct for a paste, where a human should decide, and
  // wrong here, where re-capturing a known URL is the entire intent. So each
  // line is explicitly overridden to included.
  //
  // This does not weaken the guard: `createIngestionJob` refuses `blocked` and
  // `invalid` rows whatever the override says, so a URL whose host now resolves
  // to a private address is still dropped here even though it was captured
  // successfully before.
  const includeOverrides: Record<number, boolean> = {};
  for (const row of validation.rows) {
    if (row.outcome === "already_in_database" || row.outcome === "valid") {
      includeOverrides[row.lineNumber] = true;
    }
  }

  const rejected = validation.rows.filter(
    (row) => row.outcome === "blocked" || row.outcome === "invalid",
  );

  const config = crawlJobConfigSchema.parse({
    module: source.module,
    // Never crawl outward on a recapture: the URL list is the whole job. This
    // is what keeps a "refresh" bounded and predictable rather than turning
    // into a fresh crawl of a site that has since grown.
    crawlInternalLinks: false,
    maxDepth: 0,
    priority: "low",
    requestsPerMinute: source.requestsPerMinuteOverride ?? undefined,
    targetSourceId: sourceId,
  });

  const noteParts = [
    `Recapture of ${urls.length} URL${urls.length === 1 ? "" : "s"} already held for ${source.name}.`,
  ];
  if (rejected.length > 0) {
    // Say so on the job rather than dropping them quietly: a URL that captured
    // fine before and is refused now is a signal about the source, not noise.
    noteParts.push(
      `${rejected.length} previously-captured URL${rejected.length === 1 ? "" : "s"} no longer pass validation and were not queued.`,
    );
  }

  return createIngestionJob(context, {
    name: `Recapture ${source.name}`,
    config,
    validation,
    includeOverrides,
    notes: input.notes ?? noteParts.join(" "),
    startNow: input.startNow ?? true,
  });
}

// --- Source rights --------------------------------------------------------

/**
 * Update a source's rights position (§22).
 *
 * Separate from the per-content rights editor because a source-level position
 * is the broader statement — "we do not have permission for this product" —
 * and it needs to be recordable in one place rather than repeated across every
 * page captured from it.
 *
 * What it deliberately does *not* do is cascade to content. A source-level
 * label is the team's knowledge about the source; the publish gate reads the
 * *content* record's own rights status, and silently rewriting hundreds of
 * content rows from one dropdown would destroy per-record decisions a reviewer
 * made deliberately. The CMS surfaces the source position on each content
 * record instead, so the discrepancy is visible where the publish decision is
 * actually taken.
 *
 * These are operational labels, not legal determinations, and nothing here
 * computes one.
 */
export async function updateSourceRights(
  context: AdminContext,
  sourceId: string,
  patch: {
    readonly rightsStatus?: string;
    readonly rightsOwner?: string | null;
    readonly attribution?: string | null;
    readonly permissionStatus?: string;
    readonly takedownStatus?: string;
    readonly legalReviewStatus?: string;
    readonly rightsNotes?: string | null;
  },
): Promise<void> {
  requirePermission(context.actor, "rights.update");

  await inTransaction(context, async (tx) => {
    const [before] = await tx.db
      .select({
        id: sources.id,
        name: sources.name,
        rightsStatus: sources.rightsStatus,
        rightsOwner: sources.rightsOwner,
        attribution: sources.attribution,
        permissionStatus: sources.permissionStatus,
        takedownStatus: sources.takedownStatus,
        legalReviewStatus: sources.legalReviewStatus,
      })
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .limit(1);
    if (!before) throw notFound("Source");

    await tx.db
      .update(sources)
      .set({
        ...patch,
        updatedBy: context.actor.id,
        updatedAt: new Date(),
      } as Record<string, unknown>)
      .where(eq(sources.id, sourceId));

    await recordAudit(tx.db, context, {
      action: "source.rights_changed",
      entityType: "source",
      entityId: sourceId,
      entityLabel: before.name,
      before: {
        rightsStatus: before.rightsStatus,
        rightsOwner: before.rightsOwner,
        attribution: before.attribution,
        permissionStatus: before.permissionStatus,
        takedownStatus: before.takedownStatus,
        legalReviewStatus: before.legalReviewStatus,
      },
      after: patch as Record<string, unknown>,
    });
  });
}
