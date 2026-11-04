/**
 * Put the ten shortlisted products into the discovery queue.
 *
 * Discovery only: this finds what pages each site has and fills the candidate
 * list. It creates no Screens and publishes nothing — the capture happens
 * afterwards, by hand, in the studio.
 *
 * Bounds, all explicit:
 *   maxDepth 1              the homepage and what it links to, one hop
 *   maxPagesPerDomain 20    a spread of the main nav, not the whole blog
 *   maxPagesTotal 160       the run's hard ceiling
 *   restrictToSubmittedDomains   external hosts are never followed
 *   respectRobots true      a site that says no is recorded as blocked
 *
 * Previews are on, which is the one reason this runs at level 2: a triage list
 * of 160 URLs is unusable without thumbnails — a researcher needs to see which
 * ones are product screens and which are blog posts, and a path alone does not
 * show that.
 *
 *   node scripts/discover-shortlist.mjs
 */
import { eq } from "drizzle-orm";
import { createDatabase, crawlJobs, discoveredPages, sources, users } from "@uxd/database";
import { createIngestionJob, validateUrlBatch } from "@uxd/api";
import { createStorage } from "@uxd/media";
import { createHeuristicProvider } from "@uxd/classification";
import { createLogger } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const R = "[31m";
const X = "[0m";

const SHORTLIST = [
  "https://linear.app",
  "https://stripe.com",
  "https://www.airbnb.com",
  "https://www.notion.so",
  "https://www.figma.com",
  "https://www.raycast.com",
  "https://www.vercel.com",
  "https://www.framer.com",
  "https://www.arc.net",
  "https://www.superlist.com",
];

/**
 * A subset and its own budget, for topping up a starved site.
 *
 * `maxPagesTotal` is a whole-run ceiling, so a run over several domains spends
 * it in whatever order the queue happens to drain — and a site crawled last
 * can come away with only its homepage while an earlier one takes twenty. That
 * is the limit doing its job, not a defect, but the remedy is a second run
 * scoped to the sites that lost.
 *
 *   node scripts/discover-shortlist.mjs --sites=raycast.com,superlist.com --total=70
 */
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const only = arg("sites");
const SITES = only
  ? SHORTLIST.filter((url) => only.split(",").some((frag) => url.includes(frag.trim())))
  : SHORTLIST;
const MAX_TOTAL = Number(arg("total") ?? 160);
const MAX_PER_DOMAIN = Number(arg("perDomain") ?? 20);

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ service: "discover", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-discover-shortlist" });
const db = handle.db;

const [actor] = await db
  .select({ id: users.id, email: users.email, name: users.name, role: users.role })
  .from(users)
  .where(eq(users.role, "admin"))
  .limit(1);

if (!actor) {
  console.error("No admin user. Run `npm run db:seed` first.");
  process.exit(1);
}

const context = {
  db,
  storage: createStorage({
    driver: "local",
    localRoot: env.STORAGE_LOCAL_ROOT ?? ".data/media",
    localPublicBaseUrl: env.STORAGE_LOCAL_PUBLIC_BASE_URL ?? "/media",
  }),
  classifier: createHeuristicProvider(),
  logger,
  env,
  requestId: "discover-shortlist",
  ip: null,
  userAgent: "discover-shortlist",
  actor,
};

console.log(`${B}Discovering ${SITES.length} products${X}`);
console.log(
  `${D}depth 1 · ${MAX_PER_DOMAIN} pages per domain · ${MAX_TOTAL} total · previews on · robots respected${X}\n`,
);

// --- Validate -------------------------------------------------------------

const validation = await validateUrlBatch(db, SITES, { module: "web" });
const includeOverrides = {};
for (const row of validation.rows) {
  // `already_in_database` is included: these domains already have source
  // records, and discovery is an upsert — re-finding a URL refreshes the
  // candidate rather than stacking a second one.
  if (["valid", "already_in_database", "unreachable"].includes(row.outcome)) {
    includeOverrides[row.lineNumber] = true;
  }
  const tone =
    row.outcome === "valid" ? G : row.outcome === "already_in_database" ? D : Y;
  console.log(`  ${tone}${row.outcome.padEnd(22)}${X} ${row.normalizedUrl ?? row.rawUrl}`);
}

// --- Queue ----------------------------------------------------------------

const job = await createIngestionJob(context, {
  name: `Shortlist discovery — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  config: {
    module: "web",
    // Every one of these builds its page in the browser; a plain fetch returns
    // a shell with no title and no links to follow.
    maxCaptureLevel: 2,
    capturePreview: true,
    previewProfile: "desktop_1440",

    crawlInternalLinks: true,
    maxDepth: 1,
    maxPagesPerDomain: MAX_PER_DOMAIN,
    maxPagesTotal: MAX_TOTAL,
    restrictToSubmittedDomains: true,
    includeSubdomains: false,

    respectRobots: true,
    requestsPerMinutePerDomain: 20,
    concurrencyPerDomain: 1,
    navigationTimeoutMs: 30_000,
    itemTimeoutMs: 90_000,
    maxAttempts: 2,
  },
  validation,
  includeOverrides,
  notes: "Ten shortlisted products. Discovery only — screens are captured by hand afterwards.",
  startNow: true,
});

console.log(`\n${B}Job ${job.reference}${X} ${D}${job.queuedCount} URL(s) queued${X}`);
console.log(`${D}${env.CMS_BASE_URL}/crawl-jobs/${job.jobId}${X}\n`);

// --- Watch ----------------------------------------------------------------

const startedAt = Date.now();
const TIMEOUT_MS = 20 * 60_000;
let last = "";

for (;;) {
  const [row] = await db
    .select({
      status: crawlJobs.status,
      completed: crawlJobs.completedCount,
      failed: crawlJobs.failedCount,
      blocked: crawlJobs.blockedCount,
      skipped: crawlJobs.skippedCount,
      running: crawlJobs.runningCount,
      queued: crawlJobs.queuedCount,
      discovered: crawlJobs.discoveredCount,
    })
    .from(crawlJobs)
    .where(eq(crawlJobs.id, job.jobId))
    .limit(1);

  const line =
    `  ${G}${row.completed} found${X} · ${row.running} in flight · ${row.queued} queued · ` +
    `${R}${row.failed} failed${X} · ${Y}${row.blocked} blocked${X} · ` +
    `${Math.round((Date.now() - startedAt) / 1000)}s`;
  if (line !== last) {
    process.stdout.write(`\r${" ".repeat(110)}\r${line}`);
    last = line;
  }

  if (!["queued", "running"].includes(row.status)) break;
  if (Date.now() - startedAt > TIMEOUT_MS) {
    console.log(`\n${Y}Still running after 20 minutes. Leaving it to finish in the background.${X}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 2_000));
}

// --- What is now waiting to be triaged ------------------------------------

const perSource = await db
  .select({
    name: sources.name,
    domain: sources.domain,
    candidates: db.$count(
      discoveredPages,
      eq(discoveredPages.sourceId, sources.id),
    ),
  })
  .from(sources);

const rows = await db
  .select({
    source: sources.name,
    path: discoveredPages.path,
    title: discoveredPages.title,
    words: discoveredPages.wordCount,
  })
  .from(discoveredPages)
  .leftJoin(sources, eq(sources.id, discoveredPages.sourceId))
  .orderBy(sources.name, discoveredPages.path);

console.log(`\n\n${B}In the triage queue${X}`);
const bySource = new Map();
for (const row of rows) {
  const list = bySource.get(row.source ?? "—") ?? [];
  list.push(row);
  bySource.set(row.source ?? "—", list);
}
for (const [source, list] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(3)}  ${source}`);
}

console.log(
  `\n${B}${rows.length} candidate(s) waiting.${X}\n` +
    `${D}${env.CMS_BASE_URL}/discovered — pick one and press Capture screen.${X}\n`,
);

await handle.close();
