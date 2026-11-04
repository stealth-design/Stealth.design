#!/usr/bin/env node
/**
 * The crawl experiment.
 *
 *   node scripts/experiments/run-crawl.mjs --profile=validate
 *   node scripts/experiments/run-crawl.mjs --profile=http
 *   node scripts/experiments/run-crawl.mjs --profile=browser --limit=20
 *
 * Drives the *real* pipeline — `validateUrlBatch`, `createIngestionJob`, the
 * Postgres queue, the worker, `recordDiscoveredPage` — against the dataset, and
 * records what actually happened per URL. Nothing here reimplements a step;
 * if the harness measures it, production does it.
 *
 * ## Bounds
 *
 * Every profile declares explicit limits, as Phase 2 of the audit requires:
 * domain scope, depth, page count, redirect count, runtime, response size and
 * rate limit. Discovery is off in every profile — `maxDepth: 0` and
 * `crawlInternalLinks: false` — so exactly the listed URLs are fetched.
 *
 * robots.txt is respected. A site that disallows us is recorded as blocked,
 * which is a legitimate measurement rather than something to work around.
 *
 * ## Output
 *
 * A JSON run file under `.data/experiments/` plus a summary table. The JSON is
 * what `analyse-crawl.mjs` reads; keeping them separate means the analysis can
 * be re-run and changed without re-crawling anyone's website.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import {
  captures,
  crawlJobItems,
  crawlJobUrls,
  crawlJobs,
  createDatabase,
  discoveredPages,
  mediaAssets,
  users,
} from "@uxd/database";
import { createIngestionJob, startJob, validateUrlBatch } from "@uxd/api";
import { createStorage } from "@uxd/media";
import { createHeuristicProvider } from "@uxd/classification";
import { createLogger } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile, repoRoot } from "@uxd/shared/env";
import { DATASET, MUST_BE_REFUSED } from "./dataset.mjs";

// --- Profiles -------------------------------------------------------------

/**
 * Each profile is a complete, bounded experiment.
 *
 * `validate` touches the network only for DNS. `http` is level-1 capture — a
 * guarded fetch and extraction, no browser. `browser` is level-2 — Chromium,
 * screenshots, the full pipeline. Running the last two over the same URLs is
 * what makes the cost comparison in Phase 17 an actual comparison.
 */
const PROFILES = {
  validate: {
    description: "Validation only. No page is fetched; DNS is the only network use.",
    captureLevel: 0,
    config: null,
  },
  http: {
    description: "Level-1 capture: guarded HTTP fetch and extraction. No browser.",
    captureLevel: 1,
    config: {
      module: "web",
      // Level 1 is a guarded HTTP fetch: no browser, no screenshots. Capping
      // it here is what makes the comparison against the browser profile a
      // comparison rather than two different jobs.
      maxCaptureLevel: 1,
      capturePreview: false,
      crawlInternalLinks: false,
      maxDepth: 0,
      maxPagesPerDomain: 1,
      maxPagesTotal: 120,
      maxAttempts: 1,
      requestsPerMinutePerDomain: 6,
      concurrencyPerDomain: 1,
      navigationTimeoutMs: 20_000,
      itemTimeoutMs: 45_000,
      respectRobots: true,
    },
  },
  browser: {
    description: "Level-2 capture: Chromium, screenshots, extraction, the full pipeline.",
    captureLevel: 2,
    config: {
      module: "web",
      maxCaptureLevel: 2,
      // A triage thumbnail, which is the only image a crawl produces now. The
      // research images this experiment used to measure are captured by hand
      // in the studio, so "how long does a browser capture take?" is measured
      // here on a render plus one viewport shot, not a full-page pair.
      capturePreview: true,
      previewProfile: "desktop_1440",
      crawlInternalLinks: false,
      maxDepth: 0,
      maxPagesPerDomain: 1,
      maxPagesTotal: 120,
      maxAttempts: 1,
      requestsPerMinutePerDomain: 6,
      concurrencyPerDomain: 1,
      navigationTimeoutMs: 30_000,
      itemTimeoutMs: 90_000,
      respectRobots: true,
    },
  },
};

// --- Arguments ------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const profileName = String(args.profile ?? "validate");
const profile = PROFILES[profileName];
if (!profile) {
  console.error(`Unknown profile "${profileName}". One of: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}
const limit = args.limit ? Number(args.limit) : undefined;
/** Overall wall-clock ceiling, so a stuck run ends rather than hangs. */
const runTimeoutMs = Number(args.timeout ?? 25 * 60 * 1000);

// --- Setup ----------------------------------------------------------------

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ service: "experiment", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-experiment" });

const [actor] = await handle.db
  .select({ id: users.id, email: users.email, name: users.name, role: users.role })
  .from(users)
  .where(eq(users.role, "admin"))
  .limit(1);
if (!actor) {
  console.error("No admin user. Run `npm run db:seed` first.");
  process.exit(1);
}

const context = {
  db: handle.db,
  storage: createStorage({
    driver: env.STORAGE_DRIVER,
    localRoot: env.STORAGE_LOCAL_ROOT,
    localPublicBaseUrl: "/media",
  }),
  classifier: createHeuristicProvider(),
  logger,
  env,
  requestId: `experiment-${Date.now()}`,
  ip: null,
  userAgent: "uxd-experiment",
  actor,
};

// `--only=<substring>` narrows the run to matching URLs. Added while verifying
// a single-URL fix: re-running all 87 to check one of them wastes ten minutes
// and, worse, re-crawls 86 sites that did not need visiting again.
const only = args.only ? String(args.only) : null;
const filtered = only ? DATASET.filter((e) => e.url.includes(only)) : DATASET;
if (only && filtered.length === 0) {
  console.error(`No dataset URL contains "${only}".`);
  process.exit(1);
}
const entries = limit ? filtered.slice(0, limit) : filtered;
const byUrl = new Map(entries.map((e) => [e.url, e]));

const D = "\u001b[90m";
const B = "\u001b[1m";
const G = "\u001b[32m";
const Y = "\u001b[33m";
const RED = "\u001b[31m";
const X = "\u001b[0m";

console.log(`${B}Crawl experiment — profile "${profileName}"${X}`);
console.log(`${D}${profile.description}${X}`);
console.log(`${D}${entries.length} URLs · ${new Set(entries.map((e) => hostOf(e.url))).size} hosts${X}\n`);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// =========================================================================
// Step 1 — validation
// =========================================================================

const started = Date.now();
process.stdout.write("Validating… ");
const validationStart = Date.now();
const validation = await validateUrlBatch(handle.db, entries.map((e) => e.url), {
  // The whole point of `expected-fail` entries is to see the guard refuse them,
  // so the reachability probe stays off: a DNS failure should be reported by
  // the capture attempt, not pre-empted here.
  checkReachability: false,
});
const validationMs = Date.now() - validationStart;
console.log(`${validationMs}ms`);

const byOutcome = {};
for (const row of validation.rows) {
  byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
}
console.log(
  `  ${Object.entries(byOutcome)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ")}\n`,
);

/** Per-URL record, filled in as the experiment proceeds. */
const results = new Map(
  validation.rows.map((row) => [
    row.rawUrl,
    {
      url: row.rawUrl,
      label: byUrl.get(row.rawUrl)?.label ?? null,
      scenarios: byUrl.get(row.rawUrl)?.scenarios ?? [],
      expectedFail: byUrl.get(row.rawUrl)?.scenarios.includes("expected-fail") ?? false,
      mustBeRefused: MUST_BE_REFUSED.has(row.rawUrl),
      host: row.host,
      normalizedUrl: row.normalizedUrl,
      validation: {
        outcome: row.outcome,
        reasonCode: row.reasonCode,
        reasonMessage: row.reasonMessage,
        included: row.included,
        existingCaptureCount: row.existingCaptureCount,
      },
      capture: null,
      content: null,
      media: [],
    },
  ]),
);

// --- The guard's own correctness, measured on the real path -------------

const refusalFailures = [];
for (const url of MUST_BE_REFUSED) {
  const row = results.get(url);
  if (!row) continue;
  const refused = row.validation.outcome === "blocked" || row.validation.outcome === "invalid";
  if (!refused) {
    refusalFailures.push({ url, outcome: row.validation.outcome });
  }
}
if (refusalFailures.length === 0) {
  console.log(`${G}✓${X} every URL that must be refused was refused ${D}(${MUST_BE_REFUSED.size})${X}\n`);
} else {
  console.log(`${RED}✗ ${refusalFailures.length} URL(s) that must be refused were NOT${X}`);
  for (const f of refusalFailures) console.log(`    ${f.url} → ${f.outcome}`);
  console.log("");
}

// =========================================================================
// Step 2 — the job, if this profile captures
// =========================================================================

let jobId = null;
let jobReference = null;

if (profile.config) {
  // Include everything the guard did not refuse, `already_in_database`
  // included: re-capturing a known URL is the intent of a measurement run.
  const includeOverrides = {};
  for (const row of validation.rows) {
    if (row.outcome === "valid" || row.outcome === "already_in_database" || row.outcome === "unreachable") {
      includeOverrides[row.lineNumber] = true;
    }
  }

  const job = await createIngestionJob(context, {
    name: `Experiment: ${profileName} @ ${new Date().toISOString().slice(0, 16)}`,
    config: profile.config,
    validation,
    includeOverrides,
    notes: `Audit Phase 2 crawl experiment. Profile "${profileName}". Discovery off, one page per host, robots respected.`,
    startNow: true,
  });
  jobId = job.jobId;
  jobReference = job.reference;

  console.log(`${B}Job ${job.reference}${X} ${D}queued ${job.queuedCount} of ${job.submittedCount}${X}`);
  console.log(`${D}Waiting for the worker. Ctrl-C is safe: items keep their leases and are reclaimed.${X}\n`);

  await startJob(context, jobId).catch(() => {});

  // --- Watch the queue ---------------------------------------------------
  const deadline = Date.now() + runTimeoutMs;
  let lastLine = "";
  while (Date.now() < deadline) {
    const [counts] = await handle.db
      .select({
        pending: sql`count(*) filter (where ${crawlJobItems.status} = 'pending')::int`,
        leased: sql`count(*) filter (where ${crawlJobItems.status} in ('leased','running'))::int`,
        succeeded: sql`count(*) filter (where ${crawlJobItems.status} = 'succeeded')::int`,
        failed: sql`count(*) filter (where ${crawlJobItems.status} = 'failed')::int`,
        dead: sql`count(*) filter (where ${crawlJobItems.status} = 'dead_letter')::int`,
        blocked: sql`count(*) filter (where ${crawlJobItems.status} = 'blocked')::int`,
        dupe: sql`count(*) filter (where ${crawlJobItems.status} = 'skipped_duplicate')::int`,
        total: sql`count(*)::int`,
      })
      .from(crawlJobItems)
      .where(eq(crawlJobItems.jobId, jobId));

    const done = counts.succeeded + counts.failed + counts.dead + counts.blocked + counts.dupe;
    const elapsed = Math.round((Date.now() - started) / 1000);
    const line = `  ${done}/${counts.total} done · ${counts.leased} in flight · ${counts.pending} pending · ${counts.succeeded} ok · ${counts.failed + counts.dead} failed · ${counts.blocked} blocked · ${elapsed}s`;
    if (line !== lastLine) {
      process.stdout.write(`\r${" ".repeat(lastLine.length)}\r${line}`);
      lastLine = line;
    }
    if (done >= counts.total) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("\n");
}

// =========================================================================
// Step 3 — collect what happened
// =========================================================================

if (jobId) {
  const items = await handle.db
    .select({
      url: crawlJobItems.url,
      status: crawlJobItems.status,
      attempts: crawlJobItems.attempts,
      errorCode: crawlJobItems.errorCode,
      errorMessage: crawlJobItems.errorMessage,
      startedAt: crawlJobItems.startedAt,
      finishedAt: crawlJobItems.finishedAt,
      httpStatus: crawlJobItems.httpStatus,
      id: crawlJobItems.id,
      captureId: crawlJobItems.captureId,
    })
    .from(crawlJobItems)
    .where(eq(crawlJobItems.jobId, jobId));

  // Items are keyed by their normalised URL, the dataset by the raw one.
  const byNormalized = new Map();
  for (const row of results.values()) {
    if (row.normalizedUrl) byNormalized.set(row.normalizedUrl, row);
  }

  for (const item of items) {
    const row = byNormalized.get(item.url) ?? results.get(item.url);
    if (!row) continue;
    row.queue = {
      status: item.status,
      attempts: item.attempts,
      errorCode: item.errorCode,
      errorMessage: item.errorMessage?.slice(0, 300) ?? null,
      httpStatus: item.httpStatus,
      durationMs:
        item.startedAt && item.finishedAt
          ? new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()
          : null,
    };
    row.itemId = item.id;
    row.captureId = item.captureId;
  }

  // --- Capture rows -----------------------------------------------------
  const captureIds = items.map((i) => i.captureId).filter(Boolean);
  if (captureIds.length > 0) {
    const captureRows = await handle.db
      .select()
      .from(captures)
      .where(inArray(captures.id, captureIds));
    const captureById = new Map(captureRows.map((c) => [c.id, c]));
    for (const row of results.values()) {
      const capture = row.captureId ? captureById.get(row.captureId) : null;
      if (!capture) continue;
      row.capture = {
        status: capture.status,
        method: capture.method,
        level: capture.captureLevel,
        httpStatus: capture.httpStatus,
        finalUrl: capture.finalUrl,
        redirectChain: capture.redirectChain,
        pageTitle: capture.pageTitle,
        pageWidth: capture.pageWidth,
        pageHeight: capture.pageHeight,
        viewportWidth: capture.viewportWidth,
        viewportHeight: capture.viewportHeight,
        browserName: capture.browserName,
        browserVersion: capture.browserVersion,
        workerName: capture.workerName,
        durationMs: capture.durationMs,
        loadTimeMs: capture.loadTimeMs,
        bytesTransferred: capture.bytesTransferred,
        resourceCount: capture.resourceCount,
        screenshotCount: capture.screenshotCount,
        mediaCount: capture.mediaCount,
        contentHash: capture.contentHash,
        changed: capture.changed,
        errorCode: capture.errorCode,
        errorMessage: capture.errorMessage?.slice(0, 300) ?? null,
      };
    }
  }

  // --- What the crawl produced -------------------------------------------
  //
  // Discovered pages, not content records. A crawl no longer creates content:
  // it fills the candidate queue, and a person decides what becomes a Screen.
  // This section used to join `content_items` and `page_details`, which now
  // return nothing for a crawl — so the extraction quality this experiment
  // measures is read from where the extraction actually lands.
  const itemIds = items.map((i) => i.id).filter(Boolean);
  if (itemIds.length > 0) {
    const candidateRows = await handle.db
      .select({
        jobItemId: discoveredPages.jobItemId,
        status: discoveredPages.status,
        title: discoveredPages.title,
        description: discoveredPages.description,
        h1: discoveredPages.h1,
        wordCount: discoveredPages.wordCount,
        langAttr: discoveredPages.langAttr,
        finalUrl: discoveredPages.finalUrl,
        httpStatus: discoveredPages.httpStatus,
        previewMediaId: discoveredPages.previewMediaId,
      })
      .from(discoveredPages)
      .where(inArray(discoveredPages.jobItemId, itemIds));
    const byItem = new Map(candidateRows.map((c) => [c.jobItemId, c]));

    const previewIds = candidateRows.map((c) => c.previewMediaId).filter(Boolean);
    const mediaRows =
      previewIds.length > 0
        ? await handle.db
            .select({
              id: mediaAssets.id,
              byteSize: mediaAssets.byteSize,
              width: mediaAssets.width,
              height: mediaAssets.height,
              mimeType: mediaAssets.mimeType,
              sha256: mediaAssets.sha256,
              deviceProfile: mediaAssets.deviceProfile,
              screenshotScope: mediaAssets.screenshotScope,
            })
            .from(mediaAssets)
            .where(inArray(mediaAssets.id, previewIds))
        : [];
    const mediaById = new Map(mediaRows.map((m) => [m.id, m]));

    for (const row of results.values()) {
      const candidate = row.itemId ? byItem.get(row.itemId) : null;
      if (candidate) {
        row.discovered = {
          status: candidate.status,
          title: candidate.title,
          description: candidate.description,
          h1: candidate.h1,
          wordCount: candidate.wordCount,
          langAttr: candidate.langAttr,
          finalUrl: candidate.finalUrl,
          httpStatus: candidate.httpStatus,
        };
      }
      const preview = candidate?.previewMediaId ? mediaById.get(candidate.previewMediaId) : null;
      row.media = preview ? [preview] : [];
    }
  }

  // --- Per-URL validation outcomes recorded on the job ------------------
  const urlRows = await handle.db
    .select({
      rawUrl: crawlJobUrls.rawUrl,
      outcome: crawlJobUrls.outcome,
      included: crawlJobUrls.included,
    })
    .from(crawlJobUrls)
    .where(eq(crawlJobUrls.jobId, jobId));
  for (const u of urlRows) {
    const row = results.get(u.rawUrl);
    if (row) row.recordedOnJob = { outcome: u.outcome, included: u.included };
  }
}

// =========================================================================
// Step 4 — write and summarise
// =========================================================================

const totalMs = Date.now() - started;
const run = {
  profile: profileName,
  profileDescription: profile.description,
  config: profile.config,
  startedAt: new Date(started).toISOString(),
  totalMs,
  validationMs,
  jobId,
  jobReference,
  urlCount: entries.length,
  hostCount: new Set(entries.map((e) => hostOf(e.url))).size,
  refusalFailures,
  results: [...results.values()],
};

const dir = join(repoRoot(), ".data", "experiments");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${profileName}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(run, null, 2));

console.log(`${B}Run complete${X} ${D}${Math.round(totalMs / 1000)}s${X}`);
console.log(`${D}${file.replace(repoRoot(), ".")}${X}`);

if (jobId) {
  const rows = [...results.values()].filter((r) => r.queue);
  const ok = rows.filter((r) => r.queue.status === "succeeded");
  const failed = rows.filter((r) => ["failed", "dead_letter"].includes(r.queue.status));
  const blocked = rows.filter((r) => r.queue.status === "blocked");
  const durations = ok.map((r) => r.capture?.durationMs).filter((d) => typeof d === "number");
  durations.sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;

  console.log(
    `\n  attempted ${rows.length} · ${G}succeeded ${ok.length}${X} · ${RED}failed ${failed.length}${X} · ${Y}blocked ${blocked.length}${X}`,
  );
  if (median !== null) {
    console.log(
      `  capture time  median ${median}ms · p90 ${durations[Math.floor(durations.length * 0.9)]}ms · max ${durations[durations.length - 1]}ms`,
    );
  }
  const bytes = ok.flatMap((r) => r.media.map((m) => m.byteSize)).reduce((a, b) => a + b, 0);
  if (bytes > 0) {
    console.log(
      `  media  ${ok.flatMap((r) => r.media).length} files · ${(bytes / 1024 / 1024).toFixed(1)}MB · ${(bytes / 1024 / Math.max(1, ok.length)).toFixed(0)}KB per page`,
    );
  }
  console.log(`\n${D}Analyse with: node scripts/experiments/analyse-crawl.mjs${X}`);
}

await handle.close();
process.exit(0);
