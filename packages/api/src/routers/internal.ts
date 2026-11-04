/**
 * The internal control-plane API (§25).
 *
 * The capture worker's only interface to this system. It holds no database
 * credentials, no storage credentials and no session secret — see
 * `loadWorkerEnv`, which refuses to start if any are present — so everything it
 * needs comes through these endpoints, authenticated by a bearer token.
 *
 * That indirection is the isolation boundary. A renderer escape or a
 * compromised dependency inside the worker yields an attacker a token scoped to
 * `capture`, whose reachable surface is exactly what is defined below: lease
 * work, heartbeat, upload an image, report a result. It cannot read content,
 * publish anything, reach the taxonomy, or query the database.
 *
 * Every payload is validated with Zod at the boundary, because everything the
 * worker sends is derived from a hostile web page. A worker is a *semi-trusted*
 * caller: trusted to be our software, not trusted about what it reports.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  WORKER_SCOPE_CAPTURE,
  authenticateWorker,
  parseBearer,
  requireScope,
  touchWorkerToken,
} from "@uxd/auth";
import {
  appendJobEvent,
  captureSessionCommands,
  captureSessions,
  claimItems,
  claimSession,
  expireStaleSessions,
  pendingCommands,
  touchSession,
  completeItem,
  crawlJobItems,
  crawlJobs,
  reclaimExpiredLeases,
  enqueueItems,
  finalizeJobIfComplete,
  heartbeat,
  isJobActive,
  markItemRunning,
  robotsCache,
  sources,
  workerInstances,
} from "@uxd/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  AppError,
  ErrorCode,
  type ParsedUrl,
  seconds,
  uuidv7,
  validateUrl,
} from "@uxd/shared";
import {
  CAPTURE_METHODS,
  CAPTURE_STATUSES,
  CONTENT_KINDS,
  DEVICE_CLASSES,
  JOB_LIMITS,
  MEDIA_USAGE_ROLES,
  PLATFORMS,
  STUDIO_FRAME,
  STUDIO_LIMITS,
  crawlJobConfigSchema,
} from "@uxd/types";
import type { BaseContext, WorkerContext } from "../context.js";
import { validate } from "../errors.js";
import { recordDiscoveredPage } from "../services/discovery.js";
import { createScreenFromCapture } from "../services/studio.js";
import { useHeaderLogo } from "../services/logo.js";
import {
  endLiveSession,
  liveLeaseIsFresh,
  publishLiveFrame,
  rememberLiveLease,
  takeLiveInput,
  waitForLiveCommand,
} from "../services/studio-live.js";
import { ingestMedia } from "../services/media-intake.js";

/** Everything the router needs, supplied by the host app per request. */
export interface InternalApiDeps {
  /** Build a base context for this request. */
  readonly baseContext: (requestId: string, ip: string | null, userAgent: string | null) => BaseContext;
}

type Env = { Variables: { worker: WorkerContext } };

// --- Payload schemas ------------------------------------------------------

const urlString = z.string().min(1).max(2048);

const leaseSchema = z.object({
  workerName: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(50).default(4),
  leaseSeconds: z.number().int().min(30).max(3600).default(300),
  jobId: z.string().uuid().optional(),
});

const heartbeatSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(50),
  leaseToken: z.string().min(8).max(128),
  leaseSeconds: z.number().int().min(30).max(3600).default(300),
});

const captureReportSchema = z.object({
  itemId: z.string().uuid(),
  leaseToken: z.string().min(8).max(128),
  outcome: z.enum(["succeeded", "failed", "blocked", "skipped_duplicate", "skipped_limit"]),
  retryable: z.boolean().default(true),

  requestedUrl: urlString,
  finalUrl: urlString,
  httpStatus: z.number().int().min(100).max(599).nullable().default(null),
  redirectChain: z
    .array(z.object({ status: z.number().int(), url: urlString }))
    .max(10)
    .default([]),
  method: z.enum(CAPTURE_METHODS),
  captureLevel: z.number().int().min(1).max(3),
  captureStatus: z.enum(CAPTURE_STATUSES),

  // Extracted page metadata. All attacker-controlled; capped here and
  // sanitised again in the intake service.
  pageTitle: z.string().max(2_000).nullable().default(null),
  pageDescription: z.string().max(4_000).nullable().default(null),
  ogTitle: z.string().max(2_000).nullable().default(null),
  ogType: z.string().max(200).nullable().default(null),
  canonicalUrl: z.string().max(2_048).nullable().default(null),
  langAttr: z.string().max(40).nullable().default(null),
  h1: z.string().max(2_000).nullable().default(null),
  headings: z.array(z.string().max(500)).max(50).default([]),
  wordCount: z.number().int().min(0).max(10_000_000).nullable().default(null),

  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  layoutHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  domHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),

  pageWidth: z.number().int().min(0).max(200_000).nullable().default(null),
  pageHeight: z.number().int().min(0).max(500_000).nullable().default(null),
  viewportWidth: z.number().int().min(0).max(10_000).nullable().default(null),
  viewportHeight: z.number().int().min(0).max(10_000).nullable().default(null),
  deviceProfile: z.string().max(60).nullable().default(null),
  deviceClass: z.enum(DEVICE_CLASSES).nullable().default(null),
  deviceScaleFactor: z.number().int().min(1).max(5).nullable().default(null),
  fullPage: z.boolean().default(false),
  browserName: z.string().max(60).nullable().default(null),
  browserVersion: z.string().max(60).nullable().default(null),
  userAgent: z.string().max(500).nullable().default(null),

  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  durationMs: z.number().int().min(0).nullable().default(null),
  loadTimeMs: z.number().int().min(0).nullable().default(null),
  resourceCount: z.number().int().min(0).max(100_000).nullable().default(null),
  bytesTransferred: z.number().int().min(0).nullable().default(null),

  errorCode: z.string().max(80).nullable().default(null),
  errorMessage: z.string().max(4_000).nullable().default(null),
  warnings: z
    .array(z.object({ code: z.string().max(80), message: z.string().max(1_000) }))
    .max(50)
    .default([]),
  browserErrors: z.array(z.string().max(1_000)).max(50).default([]),

  media: z
    .array(z.object({ mediaId: z.string().uuid(), role: z.enum(MEDIA_USAGE_ROLES) }))
    .max(40)
    .default([]),

  // Structural signals only — counts and booleans, never page text.
  signals: z.record(z.string().max(60), z.union([z.number(), z.boolean(), z.array(z.string().max(60)).max(50)])).default({}),

  discoveredUrls: z.array(urlString).max(500).default([]),
  depth: z.number().int().min(0).max(JOB_LIMITS.maxDepth).default(0),
  contentKind: z.enum(CONTENT_KINDS).default("page"),
  platform: z.enum(PLATFORMS).nullable().default(null),
});

/**
 * What the worker reports after running a batch of studio commands.
 *
 * Sent as the JSON half of a multipart request whose other half is the current
 * frame — one round trip carries both "here is what happened" and "here is what
 * the page looks like now", which is what keeps the studio feeling connected
 * over a transport that is really just polling.
 */
const sessionSyncSchema = z.object({
  leaseToken: z.string().min(8).max(128),
  /** Where the page actually is, which a click may have changed. */
  currentUrl: z.string().max(2_048).nullable().default(null),
  currentTitle: z.string().max(500).nullable().default(null),
  /** Move the session out of `starting` once the first page has painted. */
  live: z.boolean().default(false),
  /**
   * The worker ran a `close` command and is shutting the browser down.
   *
   * Without this the session sits `live` with no worker behind it until its
   * lease lapses and the reaper retires it as `expired` — so a session an
   * operator deliberately closed reads back as "idle too long", which is both
   * untrue and the wrong thing to see in a log.
   */
  closing: z.boolean().default(false),
  results: z
    .array(
      z.object({
        commandId: z.string().uuid(),
        status: z.enum(["done", "failed"]),
        errorMessage: z.string().max(1_000).nullable().default(null),
        result: z.record(z.string().max(60), z.unknown()).default({}),
      }),
    )
    .max(20)
    .default([]),
  /** Set when the browser is gone and the session cannot continue. */
  failure: z
    .object({ code: z.string().max(80), message: z.string().max(1_000) })
    .nullable()
    .default(null),
});

/** A Screen the researcher just captured. */
const screenCaptureSchema = z.object({
  leaseToken: z.string().min(8).max(128),
  commandId: z.string().uuid(),
  mediaId: z.string().uuid(),
  screenName: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().default(null),
  stateLabel: z.string().max(120).nullable().default(null),
  url: urlString,
  pageTitle: z.string().max(500).nullable().default(null),
  viewportWidth: z.number().int().min(1).max(10_000),
  viewportHeight: z.number().int().min(1).max(10_000),
  deviceScaleFactor: z.number().int().min(1).max(5),
  imageWidth: z.number().int().min(1).max(40_000).nullable().default(null),
  imageHeight: z.number().int().min(1).max(40_000).nullable().default(null),
  browserName: z.string().max(60).nullable().default(null),
  browserVersion: z.string().max(60).nullable().default(null),
  userAgent: z.string().max(500).nullable().default(null),
  signals: z
    .record(z.string().max(60), z.union([z.number(), z.boolean(), z.array(z.string().max(60)).max(50)]))
    .default({}),
});

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  hostname: z.string().max(200).optional(),
  version: z.string().max(60).optional(),
  capabilities: z.record(z.string().max(60), z.unknown()).default({}),
});

const robotsReportSchema = z.object({
  origin: z.string().min(1).max(300),
  status: z.enum(["unknown", "allowed", "disallowed", "partial", "unreachable", "overridden"]),
  /**
   * The rules, in full.
   *
   * Capped at the crawler's own `MAX_ROBOTS_BYTES` rather than something
   * smaller, because a sibling worker reads this back and *parses it* to make
   * allow/deny decisions. A cap below the real file size does not degrade the
   * decision, it corrupts it: Wikipedia's robots.txt is 28 KB, and the
   * previous 20,000-character limit meant the cached copy either failed
   * validation or was obeyed in part. The dangerous direction is a `Disallow`
   * falling past the cut and being silently ignored.
   */
  body: z.string().max(512 * 1024).nullable().default(null),
  /** True when the fetch itself hit the size cap; such a file is not authoritative. */
  bodyTruncated: z.boolean().default(false),
  httpStatus: z.number().int().nullable().default(null),
  fetchFailed: z.boolean().default(false),
  crawlDelayMs: z.number().int().min(0).max(60_000).nullable().default(null),
  sitemapUrls: z.array(urlString).max(50).default([]),
  expiresAt: z.string().datetime(),
});

// --- Router ---------------------------------------------------------------

export function createInternalApi(deps: InternalApiDeps): Hono<Env> {
  const app = new Hono<Env>();

  /**
   * Authenticate every request and build the worker context.
   *
   * Failure returns 401 with no detail about *why* — a token-probing attacker
   * learns nothing from the difference between "unknown token" and "revoked
   * token".
   */
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? uuidv7();
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const userAgent = c.req.header("user-agent") ?? null;
    const base = deps.baseContext(requestId, ip, userAgent);

    const worker = await authenticateWorker(
      base.db,
      { sharedSecret: base.env.WORKER_SHARED_SECRET },
      parseBearer(c.req.header("authorization")),
      // Only consulted on the shared-secret bootstrap path, where the
      // credential itself carries no identity.
      { reportedName: c.req.header("x-worker-name") },
    );
    requireScope(worker, WORKER_SCOPE_CAPTURE);
    if (worker.tokenId) await touchWorkerToken(base.db, worker.tokenId, ip);

    c.set("worker", { ...base, worker });
    await next();
  });

  /** Worker registration and heartbeat, so the CMS can show live workers. */
  app.post("/workers/register", validate("json", registerSchema), async (c) => {
    const context = c.get("worker");
    const body = c.req.valid("json");
    const id = uuidv7();

    await context.db.insert(workerInstances).values({
      id,
      tokenId: context.worker.tokenId ?? null,
      name: body.name,
      hostname: body.hostname ?? null,
      version: body.version ?? null,
      capabilities: body.capabilities,
    });

    context.logger.info("Capture worker registered", { worker: body.name, instanceId: id });
    return c.json({ instanceId: id, serverTime: new Date().toISOString() });
  });

  app.post(
    "/workers/:instanceId/heartbeat",
    validate(
      "json",
      z.object({
        itemsInFlight: z.number().int().min(0).max(1_000).default(0),
        itemsCompleted: z.number().int().min(0).default(0),
        itemsFailed: z.number().int().min(0).default(0),
      }),
    ),
    async (c) => {
      const context = c.get("worker");
      const body = c.req.valid("json");
      await context.db
        .update(workerInstances)
        .set({
          lastHeartbeatAt: new Date(),
          itemsInFlight: body.itemsInFlight,
          itemsCompleted: body.itemsCompleted,
          itemsFailed: body.itemsFailed,
        })
        .where(eq(workerInstances.id, c.req.param("instanceId")));
      return c.json({ ok: true });
    },
  );

  /**
   * Lease work.
   *
   * The job's configuration comes back with each item, so the worker needs no
   * second request and cannot act on a stale config after an operator edits it.
   */
  app.post("/jobs/lease", validate("json", leaseSchema), async (c) => {
    const context = c.get("worker");
    const body = c.req.valid("json");

    // --- Reclaim before claiming -------------------------------------
    //
    // This is where abandoned work comes back. An item whose lease expired —
    // because the worker holding it crashed, was killed, or returned early
    // without reporting — is stuck in `leased`/`running` until something
    // requeues it, and while any item is outstanding the job never finalises.
    //
    // Doing it here rather than on a schedule is deliberate. A crashed worker
    // cannot reclaim its own leases, so the reclaim has to be someone else's
    // job; putting it on the lease call means *any* worker asking for work
    // first returns abandoned work to the pool, which self-heals with a single
    // worker too — a restarted one recovers its predecessor's items. No
    // scheduler, no leader election, nothing to forget to run.
    //
    // An audit run found this function implemented, unit-tested and documented
    // while no production code path called it. Three items sat `running` with
    // leases 140 seconds expired, the job hung at 97% forever, and the only
    // recovery was manual SQL. The tests passed throughout, because they call
    // `reclaimExpiredLeases` directly — they tested the function, not that
    // anything invoked it.
    const reclaimed = await reclaimExpiredLeases(context.db, context.logger).catch((error) => {
      // Never fail a lease because a reclaim failed: a worker that cannot take
      // work is worse than one item staying stuck a little longer.
      context.logger.warn("Could not reclaim expired leases", { error });
      return { requeued: 0, deadLettered: 0 };
    });
    if (reclaimed.requeued > 0 || reclaimed.deadLettered > 0) {
      context.logger.info("Reclaimed abandoned work", {
        requeued: reclaimed.requeued,
        deadLettered: reclaimed.deadLettered,
        requestedBy: body.workerName,
      });
    }

    const claimed = await claimItems(context.db, {
      workerName: body.workerName,
      limit: body.limit,
      leaseMs: seconds(body.leaseSeconds),
      jobId: body.jobId,
      logger: context.logger,
    });

    return c.json({
      items: claimed.map((item) => ({
        id: item.id,
        jobId: item.jobId,
        jobReference: item.jobReference,
        url: item.url,
        host: item.host,
        depth: item.depth,
        attempts: item.attempts,
        maxAttempts: item.maxAttempts,
        leaseToken: item.leaseToken,
        leaseExpiresAt: item.leaseExpiresAt.toISOString(),
        // Re-validated so a config written by an older deployment cannot make
        // the worker act on a shape it does not understand.
        config: crawlJobConfigSchema.parse(item.config),
      })),
    });
  });

  app.post("/jobs/heartbeat", validate("json", heartbeatSchema), async (c) => {
    const context = c.get("worker");
    const body = c.req.valid("json");
    const result = await heartbeat(
      context.db,
      body.itemIds,
      body.leaseToken,
      seconds(body.leaseSeconds),
    );
    // `lost` tells the worker to abandon those items: their lease expired and
    // another worker owns them now.
    return c.json(result);
  });

  app.post(
    "/items/:itemId/start",
    validate("json", z.object({ leaseToken: z.string().min(8).max(128) })),
    async (c) => {
      const context = c.get("worker");
      const accepted = await markItemRunning(
        context.db,
        c.req.param("itemId"),
        c.req.valid("json").leaseToken,
      );
      return c.json({ accepted });
    },
  );

  /** Is this job still running? Polled mid-capture so cancel takes effect. */
  app.get("/jobs/:jobId/active", async (c) => {
    const context = c.get("worker");
    return c.json({ active: await isJobActive(context.db, c.req.param("jobId")) });
  });

  /**
   * Upload captured bytes.
   *
   * The worker never touches object storage — it has no credentials for it —
   * so bytes come through here and the control plane validates, hashes,
   * deduplicates and stores them. That is also what makes the upload allowlist
   * unavoidable: there is no path to storage that skips `validateMedia`.
   */
  app.post("/media", async (c) => {
    const context = c.get("worker");
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Upload must be multipart/form-data.");
    }

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError(ErrorCode.BAD_REQUEST, "No file was included in the upload.");
    }

    const maxBytes = context.env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That capture is larger than the upload limit.");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sourceUrlRaw = form.get("sourceUrl");
    const sourceUrl = typeof sourceUrlRaw === "string" ? sourceUrlRaw : null;
    let parsedSource: ParsedUrl | null = null;
    if (sourceUrl) {
      const parsed = validateUrl(sourceUrl, { assumeHttps: true });
      if (parsed.ok) parsedSource = parsed.value;
    }

    const numeric = (key: string): number | null => {
      const value = form.get(key);
      if (typeof value !== "string") return null;
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const text = (key: string, max = 200): string | null => {
      const value = form.get(key);
      return typeof value === "string" ? value.slice(0, max) : null;
    };

    const result = await ingestMedia(context, {
      bytes,
      originalFilename: text("filename", 300) ?? file.name,
      altText: text("altText", 500),
      // Capture output includes HTML snapshots, which operators cannot upload.
      allowCaptureOnlyTypes: true,
      maxBytes,
      uploadedBy: null,
      provenance: {
        sourceUrl: parsedSource?.normalized ?? sourceUrl,
        originDomain: parsedSource?.host ?? null,
        captureMethod: "browser_render",
        uploadSource: "capture",
        capturedAt: new Date(),
        viewportWidth: numeric("viewportWidth"),
        viewportHeight: numeric("viewportHeight"),
        deviceScaleFactor: numeric("deviceScaleFactor"),
        deviceProfile: text("deviceProfile", 60),
        browserName: text("browserName", 60),
        browserVersion: text("browserVersion", 60),
        screenshotScope: (() => {
          const scope = text("screenshotScope", 20);
          return scope === "full_page" || scope === "viewport" || scope === "element" ? scope : null;
        })(),
      },
    });

    return c.json({
      mediaId: result.mediaId,
      deduplicated: result.deduplicated,
      sha256: result.sha256,
      byteSize: result.byteSize,
      width: result.width,
      height: result.height,
      derivativeCount: result.derivativeCount,
      nearDuplicateCount: result.nearDuplicates.length,
    });
  });

  /**
   * Report a capture result.
   *
   * The lease token is checked by `completeItem` before anything is written, so
   * a worker whose lease expired mid-capture cannot overwrite the newer
   * attempt's result. When the token is stale the response says so and the
   * worker discards its work.
   */
  app.post("/items/report", validate("json", captureReportSchema), async (c) => {
    const context = c.get("worker");
    const body = c.req.valid("json");

    // Which job and config does this item belong to? Needed for the
    // post-capture behaviour (classify, send to review, discovery).
    const [item] = await context.db
      .select({
        id: crawlJobItems.id,
        jobId: crawlJobItems.jobId,
        depth: crawlJobItems.depth,
        discoveredFromUrl: crawlJobItems.discoveredFromUrl,
        config: crawlJobs.config,
        jobStatus: crawlJobs.status,
      })
      .from(crawlJobItems)
      .innerJoin(crawlJobs, eq(crawlJobs.id, crawlJobItems.jobId))
      .where(eq(crawlJobItems.id, body.itemId))
      .limit(1);

    if (!item) {
      throw new AppError(ErrorCode.NOT_FOUND, "That queue item does not exist.");
    }
    const config = crawlJobConfigSchema.parse(item.config);

    // --- Record the candidate, if there is one --------------------------
    //
    // A crawl produces a row in `discovered_pages` and nothing else. It used
    // to call `intakeCapture` here and create a publishable content record per
    // URL, which is the behaviour this whole change exists to remove: the
    // library's contents were decided by whatever the crawler reached, and a
    // reviewer's job was to say no several hundred times. Screens are created
    // in the capture studio, by a person, and there is no configuration value
    // that routes back to the old path.
    let discovery: Awaited<ReturnType<typeof recordDiscoveredPage>> | null = null;
    if (body.outcome === "succeeded") {
      discovery = await recordDiscoveredPage(
        // The authenticated worker's own name, not one it reported.
        { ...context },
        {
          jobId: item.jobId,
          jobItemId: item.id,
          requestedUrl: body.requestedUrl,
          finalUrl: body.finalUrl,
          httpStatus: body.httpStatus,
          pageTitle: body.pageTitle,
          pageDescription: body.pageDescription,
          ogTitle: body.ogTitle,
          ogType: body.ogType,
          langAttr: body.langAttr,
          h1: body.h1,
          wordCount: body.wordCount,
          depth: body.depth,
          discoveredFromUrl: item.discoveredFromUrl,
          // A crawl may attach at most one small triage thumbnail. Anything
          // else it uploaded is not a research image and is not wanted here.
          previewMediaId: body.media[0]?.mediaId ?? null,
          module: config.module,
        },
      );
    }

    // --- Settle the queue item ------------------------------------------
    const completion = await completeItem(context.db, {
      itemId: body.itemId,
      leaseToken: body.leaseToken,
      status: body.outcome,
      httpStatus: body.httpStatus,
      finalUrl: body.finalUrl,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
      captureId: null,
      contentItemId: null,
      durationMs: body.durationMs,
      retryable: body.retryable,
      resultSummary: {
        discoveredPageId: discovery?.discoveredPageId ?? null,
        newCandidate: discovery?.created ?? false,
        mediaCount: body.media.length,
        discovered: body.discoveredUrls.length,
      },
    });

    if (!completion.accepted) {
      // Stale lease. The capture rows we just wrote are still valid history —
      // a capture happened — but the queue item belongs to someone else now.
      context.logger.warn("Rejected a capture report with a stale lease", {
        itemId: body.itemId,
        worker: context.worker.name,
      });
      return c.json(
        {
          accepted: false,
          reason:
            "This item's lease expired and it was reassigned. Discard the result and take new work.",
        },
        409,
      );
    }

    // --- Queue the links this page pointed at ---------------------------
    const discovered = await enqueueDiscovered(context, {
      jobId: item.jobId,
      parentItemId: item.id,
      fromUrl: body.finalUrl,
      urls: body.discoveredUrls,
      depth: body.depth,
      config,
    });

    await finalizeJobIfComplete(context.db, item.jobId);

    return c.json({
      accepted: true,
      willRetry: completion.willRetry,
      finalStatus: completion.finalStatus,
      discoveredPageId: discovery?.discoveredPageId ?? null,
      newCandidate: discovery?.created ?? false,
      alreadyTriaged: discovery?.alreadyTriaged ?? false,
      discoveredQueued: discovered.queued,
      discoveredRejected: discovered.rejected,
    });
  });

  // --- The capture studio -------------------------------------------------
  //
  // A live session is a conversation, not a request: the worker asks for one,
  // then loops — post what happened and what the page looks like, receive what
  // to do next. Three endpoints carry the whole of it.

  /**
   * Take a session that is waiting for a browser.
   *
   * Also the moment stale sessions get reaped. Putting the reaper here rather
   * than on a timer means it runs exactly when it matters — a worker with
   * capacity is asking for work — and needs no scheduler of its own. The same
   * reasoning put `reclaimExpiredLeases` on the crawl queue's lease call.
   */
  app.post("/sessions/claim", async (c) => {
    const context = c.get("worker");
    await expireStaleSessions(context.db, context.logger).catch((error) => {
      context.logger.warn("Could not expire stale capture sessions", { error });
    });

    const session = await claimSession(context.db, {
      workerName: context.worker.name,
      logger: context.logger,
    });
    if (!session) return c.json({ session: null });

    // Ask the browser to photograph the header logo while it is there, when
    // the website has no logo yet or only its app icon.
    const [logo] = await context.db
      .select({ mediaId: sources.logoMediaId, origin: sources.logoOrigin })
      .from(captureSessions)
      .innerJoin(sources, eq(sources.id, captureSessions.sourceId))
      .where(eq(captureSessions.id, session.id))
      .limit(1);
    const wantsLogo = Boolean(logo) && (logo!.mediaId === null || logo!.origin === "icon");

    return c.json({
      session: {
        wantsLogo,
        id: session.id,
        targetUrl: session.targetUrl,
        deviceProfile: session.deviceProfile,
        viewportWidth: session.viewportWidth,
        viewportHeight: session.viewportHeight,
        deviceScaleFactor: session.deviceScaleFactor,
        leaseToken: session.leaseToken,
        expiresAt: session.expiresAt.toISOString(),
      },
    });
  });

  /**
   * One turn of the conversation: post results and a frame, receive commands.
   *
   * The long poll at the end is what sets the idle frame rate. When somebody is
   * watching the studio, the wait is short and the worker comes straight back
   * with a fresh photograph — roughly a frame a second. When nobody is, the
   * wait is long and the worker stops photographing a page no one can see.
   * That single number is the difference between a live session costing a
   * screenshot a second forever and costing nothing while a researcher is at
   * lunch.
   */
  app.post("/sessions/:id/sync", async (c) => {
    const context = c.get("worker");
    const sessionId = c.req.param("id");

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Session sync must be multipart/form-data.");
    }

    const form = await c.req.formData();
    const payloadRaw = form.get("payload");
    if (typeof payloadRaw !== "string") {
      throw new AppError(ErrorCode.BAD_REQUEST, "The sync payload is missing.");
    }
    const body = sessionSyncSchema.parse(JSON.parse(payloadRaw));

    // Ownership first. Everything below writes to the session row, and a worker
    // whose lease lapsed must not be able to overwrite the state of a session
    // that has since been expired or closed.
    const owns = await touchSession(context.db, sessionId, body.leaseToken);
    if (!owns) {
      endLiveSession(sessionId);
      return c.json(
        { accepted: false, reason: "This session has ended. Close the browser and take new work." },
        409,
      );
    }
    rememberLiveLease(sessionId, body.leaseToken);

    // Settle whatever the worker just ran.
    for (const result of body.results) {
      await context.db
        .update(captureSessionCommands)
        .set({
          status: result.status,
          errorMessage: result.errorMessage,
          result: result.result as Record<string, unknown>,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(captureSessionCommands.id, result.commandId),
            eq(captureSessionCommands.sessionId, sessionId),
          ),
        );
    }

    // Store the frame. Capped rather than trusted: the frame is the largest
    // thing the worker can put in the database, and the only defence against a
    // bug there writing gigabytes is a limit on this side of the boundary.
    const frame = form.get("frame");
    let frameSeq: number | null = null;
    if (frame instanceof File && frame.size > 0) {
      if (frame.size > STUDIO_FRAME.maxBytes) {
        throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That preview frame is larger than the limit.");
      }
      const bytes = Buffer.from(await frame.arrayBuffer());
      const width = Number(form.get("frameWidth")) || null;
      const height = Number(form.get("frameHeight")) || null;
      publishLiveFrame(sessionId, { bytes, width: width ?? 0, height: height ?? 0 }, 0);
      const [updated] = await context.db
        .update(captureSessions)
        .set({
          frame: bytes,
          frameWidth: width,
          frameHeight: height,
          frameBytes: bytes.byteLength,
          frameAt: new Date(),
          frameSeq: sql`${captureSessions.frameSeq} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(captureSessions.id, sessionId))
        .returning({ seq: captureSessions.frameSeq });
      frameSeq = updated?.seq ?? null;
    }

    if (body.failure) {
      await context.db
        .update(captureSessions)
        .set({
          status: "failed",
          errorCode: body.failure.code,
          errorMessage: body.failure.message,
          closedAt: new Date(),
          leaseToken: null,
          updatedAt: new Date(),
        })
        .where(eq(captureSessions.id, sessionId));
      // Anything still waiting will never run; say so, or the studio shows
      // "Capturing…" forever.
      await context.db
        .update(captureSessionCommands)
        .set({ status: "failed", errorMessage: "The browser closed before this ran.", finishedAt: new Date() })
        .where(
          and(
            eq(captureSessionCommands.sessionId, sessionId),
            inArray(captureSessionCommands.status, ["pending", "running"]),
          ),
        );
      endLiveSession(sessionId);
      return c.json({ accepted: true, status: "failed", commands: [], frameSeq });
    }

    if (body.closing) {
      await context.db
        .update(captureSessions)
        .set({
          status: "closed",
          closedAt: new Date(),
          leaseToken: null,
          frame: null,
          frameBytes: null,
          currentUrl: body.currentUrl,
          currentTitle: body.currentTitle,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(captureSessions.id, sessionId),
            sql`${captureSessions.status} in ('pending','starting','live')`,
          ),
        );
      endLiveSession(sessionId);
      return c.json({ accepted: true, status: "closed", commands: [], frameSeq });
    }

    await context.db
      .update(captureSessions)
      .set({
        status: body.live ? "live" : sql`${captureSessions.status}`,
        currentUrl: body.currentUrl,
        currentTitle: body.currentTitle,
        updatedAt: new Date(),
      })
      .where(eq(captureSessions.id, sessionId));

    // --- The long poll ----------------------------------------------------
    const [state] = await context.db
      .select({ status: captureSessions.status, viewerSeenAt: captureSessions.viewerSeenAt })
      .from(captureSessions)
      .where(eq(captureSessions.id, sessionId))
      .limit(1);

    if (!state || state.status === "closed" || state.status === "expired") {
      return c.json({ accepted: true, status: state?.status ?? "closed", commands: [], frameSeq });
    }

    const viewerActive =
      state.viewerSeenAt !== null &&
      Date.now() - state.viewerSeenAt.getTime() < STUDIO_LIMITS.viewerActiveMs;
    const deadline = Date.now() + STUDIO_LIMITS.commandPollMs;

    // Held open until a command arrives. `enqueueCommand` wakes this through
    // the live relay the moment it writes the row, so a click reaches the
    // worker in one hop instead of on the next poll. The one-second re-check
    // is the backstop for a wake that never comes — a command written by
    // another process, or a relay that was reloaded underneath us.
    let commands = await pendingCommands(context.db, sessionId);
    while (commands.length === 0 && Date.now() < deadline) {
      await waitForLiveCommand(sessionId, Math.min(1_000, deadline - Date.now()), c.req.raw.signal);
      if (c.req.raw.signal.aborted) break;
      commands = await pendingCommands(context.db, sessionId);
    }

    if (commands.length > 0) {
      await context.db
        .update(captureSessionCommands)
        .set({ status: "running", startedAt: new Date() })
        .where(
          inArray(
            captureSessionCommands.id,
            commands.map((cmd) => cmd.id),
          ),
        );
    }

    return c.json({
      accepted: true,
      status: state.status,
      viewerActive,
      frameSeq,
      commands: commands.map((cmd) => ({ id: cmd.id, type: cmd.type, payload: cmd.payload })),
    });
  });

  /**
   * Is `token` this session's lease? The live relay remembers leases the
   * database confirmed, so the many-a-second frame and input calls below cost
   * no query; a cold or stale entry falls through to the database once.
   */
  const confirmLiveLease = async (context: WorkerContext, sessionId: string, token: string | undefined) => {
    if (!token) return false;
    if (liveLeaseIsFresh(sessionId, token, STUDIO_LIMITS.leaseCacheMs)) return true;
    const [row] = await context.db
      .select({ id: captureSessions.id })
      .from(captureSessions)
      .where(
        and(
          eq(captureSessions.id, sessionId),
          eq(captureSessions.leaseToken, token),
          inArray(captureSessions.status, ["starting", "live"]),
        ),
      )
      .limit(1);
    if (!row) return false;
    rememberLiveLease(sessionId, token);
    return true;
  };

  /**
   * One live frame, straight from the worker's screencast.
   *
   * The body is the JPEG itself — no form, no JSON — because this is called
   * up to `STUDIO_FRAME.maxFps` times a second. It goes to every studio
   * watching through the live relay; only one every `persistEveryMs` is also
   * written to the session row.
   */
  app.post("/sessions/:id/frame", async (c) => {
    const context = c.get("worker");
    const sessionId = c.req.param("id");

    if (!(await confirmLiveLease(context, sessionId, c.req.header("x-lease-token")))) {
      endLiveSession(sessionId);
      return c.json({ accepted: false, reason: "This session has ended." }, 409);
    }

    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > STUDIO_FRAME.maxBytes) {
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That preview frame is larger than the limit.");
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ accepted: true });
    if (bytes.byteLength > STUDIO_FRAME.maxBytes) {
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That preview frame is larger than the limit.");
    }

    const width = Number(c.req.header("x-frame-width")) || 0;
    const height = Number(c.req.header("x-frame-height")) || 0;
    const { seq, persist } = publishLiveFrame(sessionId, { bytes, width, height }, STUDIO_FRAME.persistEveryMs);

    if (persist) {
      await context.db
        .update(captureSessions)
        .set({
          frame: Buffer.from(bytes),
          frameWidth: width || null,
          frameHeight: height || null,
          frameBytes: bytes.byteLength,
          frameAt: new Date(),
          frameSeq: sql`${captureSessions.frameSeq} + 1`,
        })
        .where(eq(captureSessions.id, sessionId));
    }

    return c.json({ accepted: true, seq });
  });

  /**
   * Pointer and wheel input for the live page, held open until some arrives.
   *
   * Separate from `/sync` so that moving the mouse never waits behind a slow
   * navigation, and never writes to the database: only the latest pointer
   * position is kept, and wheel deltas are summed while the worker is busy.
   */
  app.get("/sessions/:id/input", async (c) => {
    const context = c.get("worker");
    const sessionId = c.req.param("id");

    if (!(await confirmLiveLease(context, sessionId, c.req.header("x-lease-token")))) {
      return c.json({ accepted: false, ended: true, pointer: null, wheel: null }, 409);
    }

    const input = await takeLiveInput(sessionId, STUDIO_LIMITS.inputPollMs, c.req.raw.signal);
    return c.json({ accepted: true, ...input });
  });

  /**
   * The logo the capture browser photographed in the page header. Used unless
   * a person has already chosen one (see `useHeaderLogo`).
   */
  app.post("/sessions/:id/logo", async (c) => {
    const context = c.get("worker");
    const sessionId = c.req.param("id");
    const body = z.object({ leaseToken: z.string().min(1), mediaId: z.string().uuid() }).parse(await c.req.json());
    if (!(await confirmLiveLease(context, sessionId, body.leaseToken))) {
      return c.json({ accepted: false, reason: "This session has ended." }, 409);
    }
    const [session] = await context.db
      .select({ sourceId: captureSessions.sourceId })
      .from(captureSessions)
      .where(eq(captureSessions.id, sessionId))
      .limit(1);
    if (!session?.sourceId) return c.json({ accepted: false });
    const used = await useHeaderLogo(context, session.sourceId, body.mediaId);
    return c.json({ accepted: true, used });
  });

  /**
   * A researcher pressed Capture.
   *
   * The only route in this system that creates a `screen` content record, and
   * it is reachable only by a worker executing a command a signed-in person
   * issued. That is the guarantee, stated as a fact about the call graph rather
   * than as a configuration default.
   */
  app.post("/sessions/:id/screen", validate("json", screenCaptureSchema), async (c) => {
    const context = c.get("worker");
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");

    const result = await createScreenFromCapture(context, {
      sessionId,
      leaseToken: body.leaseToken,
      commandId: body.commandId,
      mediaId: body.mediaId,
      screenName: body.screenName,
      description: body.description,
      stateLabel: body.stateLabel,
      url: body.url,
      pageTitle: body.pageTitle,
      viewportWidth: body.viewportWidth,
      viewportHeight: body.viewportHeight,
      deviceScaleFactor: body.deviceScaleFactor,
      imageWidth: body.imageWidth,
      imageHeight: body.imageHeight,
      browserName: body.browserName,
      browserVersion: body.browserVersion,
      userAgent: body.userAgent,
      // The authenticated worker's own name, never one it reported.
      workerName: context.worker.name,
      signals: body.signals as Record<string, unknown>,
    });

    return c.json({
      contentItemId: result.contentItemId,
      slug: result.slug,
      captureId: result.captureId,
      flowStepPosition: result.flowStepPosition,
    });
  });

  /** Cache a robots.txt the worker fetched, so siblings do not refetch it. */
  app.post("/robots", validate("json", robotsReportSchema), async (c) => {
    const context = c.get("worker");
    const body = c.req.valid("json");
    await context.db
      .insert(robotsCache)
      .values({
        origin: body.origin,
        body: body.body,
        httpStatus: body.httpStatus,
        fetchFailed: body.fetchFailed,
        crawlDelayMs: body.crawlDelayMs,
        sitemapUrls: body.sitemapUrls,
        fetchedAt: new Date(),
        expiresAt: new Date(body.expiresAt),
      })
      .onConflictDoUpdate({
        target: robotsCache.origin,
        set: {
          body: body.body,
          httpStatus: body.httpStatus,
          fetchFailed: body.fetchFailed,
          crawlDelayMs: body.crawlDelayMs,
          sitemapUrls: body.sitemapUrls,
          fetchedAt: new Date(),
          expiresAt: new Date(body.expiresAt),
        },
      });
    return c.json({ ok: true });
  });

  app.get("/robots", async (c) => {
    const context = c.get("worker");
    const origin = c.req.query("origin");
    if (!origin) throw new AppError(ErrorCode.BAD_REQUEST, "An origin is required.");
    const [row] = await context.db
      .select()
      .from(robotsCache)
      .where(and(eq(robotsCache.origin, origin), sql`${robotsCache.expiresAt} > now()`))
      .limit(1);
    return c.json({ rules: row ?? null });
  });

  /** Append to a job's log, for progress the worker alone can see. */
  app.post(
    "/jobs/:jobId/events",
    validate(
      "json",
      z.object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        code: z.string().min(1).max(80),
        message: z.string().max(2_000).optional(),
        itemId: z.string().uuid().optional(),
        data: z.record(z.string().max(60), z.unknown()).default({}),
      }),
    ),
    async (c) => {
      const context = c.get("worker");
      const body = c.req.valid("json");
      await appendJobEvent(context.db, {
        jobId: c.req.param("jobId"),
        itemId: body.itemId ?? null,
        level: body.level,
        code: body.code,
        message: body.message ?? null,
        data: body.data as Record<string, unknown>,
        actor: `worker:${context.worker.name}`,
      });
      return c.json({ ok: true });
    },
  );

  return app;
}

/**
 * Queue URLs discovered on a captured page.
 *
 * This is where §7's "never allow an ingestion job to unintentionally expand
 * indefinitely" is enforced at runtime. The worker has already applied the
 * guard and the crawl scope, but the *limits* are counted here, on the control
 * plane, because only it can see the job's true totals across all workers. A
 * worker cannot expand its own crawl by mis-reporting.
 */
async function enqueueDiscovered(
  context: WorkerContext,
  input: {
    readonly jobId: string;
    readonly parentItemId: string;
    readonly fromUrl: string;
    readonly urls: readonly string[];
    readonly depth: number;
    readonly config: ReturnType<typeof crawlJobConfigSchema.parse>;
  },
): Promise<{ queued: number; rejected: number; limitReached: string | null }> {
  const { config } = input;
  if (!config.crawlInternalLinks || input.urls.length === 0) {
    return { queued: 0, rejected: input.urls.length, limitReached: null };
  }

  const nextDepth = input.depth + 1;
  if (nextDepth > config.maxDepth) {
    return { queued: 0, rejected: input.urls.length, limitReached: "maxDepth" };
  }

  // Total item count for the job, counted authoritatively here.
  const [totals] = await context.db
    .select({ n: sql<number>`count(*)::int` })
    .from(crawlJobItems)
    .where(eq(crawlJobItems.jobId, input.jobId));
  const currentTotal = totals?.n ?? 0;

  if (currentTotal >= config.maxPagesTotal) {
    await appendJobEvent(context.db, {
      jobId: input.jobId,
      level: "warn",
      code: "job_limit_reached",
      message: `The total page limit (${config.maxPagesTotal}) was reached, so no further links were followed.`,
      data: { limit: "maxPagesTotal", value: config.maxPagesTotal },
    });
    return { queued: 0, rejected: input.urls.length, limitReached: "maxPagesTotal" };
  }

  // Per-host counts, so one large domain cannot consume the whole budget.
  const hostCounts = new Map<string, number>();
  const perHostRows = await context.db
    .select({ host: crawlJobItems.host, n: sql<number>`count(*)::int` })
    .from(crawlJobItems)
    .where(eq(crawlJobItems.jobId, input.jobId))
    .groupBy(crawlJobItems.host);
  for (const row of perHostRows) hostCounts.set(row.host, row.n);

  const remainingTotal = config.maxPagesTotal - currentTotal;
  const candidates: { url: string; host: string; hash: string }[] = [];
  let rejected = 0;

  for (const raw of input.urls) {
    if (candidates.length >= remainingTotal) {
      rejected += 1;
      continue;
    }
    const parsed = validateUrl(raw, { assumeHttps: true });
    if (!parsed.ok) {
      rejected += 1;
      continue;
    }
    const host = parsed.value.host;

    // Path filters (§7's include/exclude patterns).
    const path = `${parsed.value.path}${parsed.value.search}`;
    if (config.excludeUrlPatterns.some((pattern) => path.includes(pattern))) {
      rejected += 1;
      continue;
    }
    if (
      config.includeUrlPatterns.length > 0 &&
      !config.includeUrlPatterns.some((pattern) => path.includes(pattern))
    ) {
      rejected += 1;
      continue;
    }

    const used = hostCounts.get(host) ?? 0;
    if (used >= config.maxPagesPerDomain) {
      rejected += 1;
      continue;
    }
    hostCounts.set(host, used + 1);
    candidates.push({ url: parsed.value.normalized, host, hash: parsed.value.hash });
  }

  if (candidates.length === 0) {
    return { queued: 0, rejected, limitReached: rejected > 0 ? "filters" : null };
  }

  const { inserted } = await enqueueItems(
    context.db,
    candidates.map((candidate) => ({
      jobId: input.jobId,
      url: candidate.url,
      normalizedUrlHash: candidate.hash,
      host: candidate.host,
      depth: nextDepth,
      parentItemId: input.parentItemId,
      discoveredFromUrl: input.fromUrl,
      priority: config.priority,
      maxAttempts: config.maxAttempts,
    })),
  );

  if (inserted > 0) {
    await context.db
      .update(crawlJobs)
      .set({ acceptedCount: sql`${crawlJobs.acceptedCount} + ${inserted}` })
      .where(eq(crawlJobs.id, input.jobId));
  }

  return { queued: inserted, rejected, limitReached: null };
}
