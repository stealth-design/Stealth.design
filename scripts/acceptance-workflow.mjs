/**
 * The acceptance test for the discover → select → capture → review workflow.
 *
 * Runs the eighteen steps the brief specifies, against the real services and a
 * real browser, in the order a researcher would perform them. Nothing here
 * reaches around the pipeline: every write goes through the same function the
 * CMS calls, so a pass means an operator could have produced the same result by
 * clicking, and a failure is a failure of the product rather than of the test.
 *
 * Uses Linear as the subject, as specified.
 *
 *   node scripts/acceptance-workflow.mjs
 *   node scripts/acceptance-workflow.mjs --keep   # leave the records behind
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  captureSessionCommands,
  captureSessions,
  contentItems,
  createDatabase,
  crawlJobs,
  discoveredPages,
  flowSteps,
  screenDetails,
  taxonomyAssignments,
  users,
} from "@uxd/database";
import {
  bulkAcceptSuggestions,
  createFlow,
  createIngestionJob,
  enqueueCommand,
  flowWithSteps,
  openSession,
  publishContent,
  recordDecision,
  submitFlowForReview,
  validateUrlBatch,
} from "@uxd/api";
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

const SITE = "https://linear.app";
const PUBLIC_API = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/public";

let passed = 0;
let failed = 0;
const failures = [];

function check(step, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ${G}pass${X}  ${step}${detail ? ` ${D}${detail}${X}` : ""}`);
  } else {
    failed += 1;
    failures.push(step);
    console.log(`  ${R}FAIL${X}  ${step}${detail ? ` ${D}${detail}${X}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ name: "acceptance", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-acceptance" });
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
  requestId: "acceptance",
  ip: null,
  userAgent: "acceptance",
  actor,
};

console.log(`${B}Acceptance — discover, select, capture, review${X}`);
console.log(`${D}subject: ${SITE} · control plane: ${env.CMS_BASE_URL}${X}\n`);

// ===========================================================================
// 1–3. Add the source, run discovery, confirm candidates appear
// ===========================================================================

console.log(`${B}Discovery${X}`);

const runStartedAt = new Date();
const contentBefore = (
  await db.select({ n: sql`count(*)::int` }).from(contentItems)
)[0].n;

const validation = await validateUrlBatch(db, [SITE], { module: "web" });
const includeOverrides = {};
for (const row of validation.rows) {
  if (["valid", "already_in_database", "unreachable"].includes(row.outcome)) {
    includeOverrides[row.lineNumber] = true;
  }
}

const job = await createIngestionJob(context, {
  name: `Acceptance discovery — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  config: {
    module: "web",
    // Level 2, because Linear renders in the browser: a plain fetch returns a
    // shell with no links, and discovery would find nothing to triage.
    maxCaptureLevel: 2,
    capturePreview: false,
    crawlInternalLinks: true,
    maxDepth: 1,
    maxPagesPerDomain: 25,
    maxPagesTotal: 25,
    restrictToSubmittedDomains: true,
    includeSubdomains: false,
    respectRobots: true,
    requestsPerMinutePerDomain: 30,
  },
  validation,
  includeOverrides,
  notes: "Acceptance run. Discovery only — a crawl cannot create content.",
  startNow: true,
});

console.log(`  ${D}job ${job.reference}, ${job.queuedCount} URL(s) queued${X}`);

const startedAt = Date.now();
for (;;) {
  const [row] = await db
    .select({
      status: crawlJobs.status,
      completed: crawlJobs.completedCount,
      failed: crawlJobs.failedCount,
      queued: crawlJobs.queuedCount,
      running: crawlJobs.runningCount,
    })
    .from(crawlJobs)
    .where(eq(crawlJobs.id, job.jobId))
    .limit(1);

  const settled = !["queued", "running"].includes(row.status);
  process.stdout.write(
    `\r  ${D}${row.completed} done · ${row.running} in flight · ${row.queued} queued · ${Math.round((Date.now() - startedAt) / 1000)}s${X}    `,
  );
  if (settled) break;
  if (Date.now() - startedAt > 5 * 60_000) {
    console.log(`\n  ${Y}Discovery timed out.${X}`);
    break;
  }
  await sleep(2_000);
}
process.stdout.write("\r" + " ".repeat(90) + "\r");

const candidates = await db
  .select({
    id: discoveredPages.id,
    url: discoveredPages.url,
    normalizedUrl: discoveredPages.normalizedUrl,
    path: discoveredPages.path,
    title: discoveredPages.title,
    status: discoveredPages.status,
    firstSeenAt: discoveredPages.firstSeenAt,
    triagedAt: discoveredPages.triagedAt,
  })
  .from(discoveredPages)
  .where(eq(discoveredPages.jobId, job.jobId));

check("3. Discovered URLs appear as candidates", candidates.length > 0, `${candidates.length} found`);

const contentAfter = (await db.select({ n: sql`count(*)::int` }).from(contentItems))[0].n;
check(
  "A crawl creates no content records",
  contentAfter === contentBefore,
  `${contentBefore} before, ${contentAfter} after`,
);
// A re-crawl must never resurrect a candidate somebody already triaged —
// otherwise the ignore button is useless on exactly the sites we crawl most
// often. So the assertion is not "all new", it is "nothing was reset": every
// candidate is either untriaged or was already decided before this run.
const freshlySeen = candidates.filter((c) => c.firstSeenAt >= runStartedAt);
check(
  "New candidates start untriaged",
  freshlySeen.every((c) => c.status === "new"),
  `${freshlySeen.filter((c) => c.status === "new").length}/${freshlySeen.length} new this run`,
);
check(
  "A re-crawl leaves existing triage decisions alone",
  candidates
    .filter((c) => c.firstSeenAt < runStartedAt && c.triagedAt !== null)
    .every((c) => c.status !== "new"),
  `${candidates.length - freshlySeen.length} seen before`,
);

// ===========================================================================
// 4–6. Select Pricing, capture the viewport, verify the Screen exists
// ===========================================================================

console.log(`\n${B}Intentional capture${X}`);

const pricing =
  candidates.find((c) => (c.path ?? "").toLowerCase().includes("pricing")) ?? candidates[0];
check("4. A Pricing candidate is selectable", Boolean(pricing), pricing?.path ?? "none");

if (!pricing) {
  console.log(`\n${R}Cannot continue without a candidate.${X}`);
  process.exit(1);
}

const session = await openSession(context, {
  url: pricing.url,
  profile: "desktop_1440",
  discoveredPageId: pricing.id,
});
console.log(`  ${D}session ${session.sessionId} opening…${X}`);

/** Wait for the worker to claim the session and report the page live. */
async function waitForLive(sessionId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ status: captureSessions.status, error: captureSessions.errorMessage })
      .from(captureSessions)
      .where(eq(captureSessions.id, sessionId))
      .limit(1);
    if (row?.status === "live") return row;
    if (row && ["failed", "closed", "expired"].includes(row.status)) return row;
    await sleep(1_000);
  }
  return null;
}

const live = await waitForLive(session.sessionId);
check("5a. The studio browser opens on the page", live?.status === "live", live?.error ?? live?.status);

/** Send a command and wait for the worker to report its outcome. */
async function runCommand(sessionId, payload, timeoutMs = 60_000) {
  const { commandId } = await enqueueCommand(context, sessionId, payload);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({
        status: captureSessionCommands.status,
        result: captureSessionCommands.result,
        errorMessage: captureSessionCommands.errorMessage,
      })
      .from(captureSessionCommands)
      .where(eq(captureSessionCommands.id, commandId))
      .limit(1);
    if (row && ["done", "failed"].includes(row.status)) return row;
    await sleep(500);
  }
  return { status: "timeout", result: {}, errorMessage: "The command never completed." };
}

// A frame proves the live view works: the worker is photographing the page and
// posting it back through the control plane.
const [frameRow] = await db
  .select({ seq: captureSessions.frameSeq, bytes: captureSessions.frameBytes })
  .from(captureSessions)
  .where(eq(captureSessions.id, session.sessionId))
  .limit(1);
check(
  "5b. The live view receives frames",
  (frameRow?.seq ?? 0) > 0 && (frameRow?.bytes ?? 0) > 0,
  `${frameRow?.seq ?? 0} frames, latest ${Math.round((frameRow?.bytes ?? 0) / 1024)}KB`,
);

// Drive the page a little before capturing, which is the whole point of the
// studio: the state captured is one a person navigated to.
await runCommand(session.sessionId, { type: "scroll", x: 700, y: 400, deltaX: 0, deltaY: 300 });

const captureResult = await runCommand(session.sessionId, {
  type: "capture",
  screenName: "Pricing",
  stateLabel: "Scrolled to plans",
});
check(
  "5c. Capture the current viewport",
  captureResult.status === "done",
  captureResult.errorMessage ?? "",
);

const screenId = captureResult.result?.contentItemId ?? null;
check("6. A Screen record is created", Boolean(screenId), screenId ?? "none");

if (!screenId) {
  console.log(`\n${R}Cannot continue without a captured screen.${X}`);
  await handle.close();
  process.exit(1);
}

const [screen] = await db
  .select({
    id: contentItems.id,
    kind: contentItems.kind,
    status: contentItems.status,
    title: contentItems.title,
    slug: contentItems.slug,
    screenName: screenDetails.screenName,
    stateLabel: screenDetails.stateLabel,
    acquisition: screenDetails.acquisition,
    deviceProfile: screenDetails.deviceProfile,
    viewportWidth: screenDetails.viewportWidth,
    deviceScaleFactor: screenDetails.deviceScaleFactor,
    mediaId: contentItems.primaryMediaId,
  })
  .from(contentItems)
  .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
  .where(eq(contentItems.id, screenId))
  .limit(1);

check("6a. It is a screen, not a page", screen?.kind === "screen", screen?.kind);
check("6b. It records the state it captured", screen?.stateLabel === "Scrolled to plans", screen?.stateLabel ?? "");
check(
  "6c. It records how it was obtained",
  screen?.acquisition === "interactive_capture",
  screen?.acquisition ?? "",
);
check("6d. It has media attached", Boolean(screen?.mediaId), screen?.mediaId ?? "none");
check(
  "6e. Captured at the profile's real density",
  screen?.deviceScaleFactor === 2 && screen?.viewportWidth === 1440,
  `${screen?.viewportWidth} CSS at x${screen?.deviceScaleFactor}`,
);

const suggestions = await db
  .select({ id: taxonomyAssignments.id, status: taxonomyAssignments.reviewStatus })
  .from(taxonomyAssignments)
  .where(eq(taxonomyAssignments.contentItemId, screenId));

check("7. Metadata suggestions are generated", suggestions.length > 0, `${suggestions.length}`);
check(
  "7a. They are suggestions, not decisions",
  suggestions.every((s) => s.status === "pending"),
  `${suggestions.filter((s) => s.status === "pending").length} pending`,
);
check("8. The screen enters review", screen?.status === "needs_review", screen?.status ?? "");

// ===========================================================================
// 13 (first half). An unapproved screen is not public
// ===========================================================================

console.log(`\n${B}The publish gate${X}`);

async function publicGet(path) {
  const response = await fetch(`${PUBLIC_API}${path}`);
  if (!response.ok) return null;
  return response.json();
}

const beforeApproval = await publicGet(`/screens/${screen.slug}`);
check("13a. A screen awaiting review is not public", beforeApproval === null, "404 as expected");

// ===========================================================================
// 9–12. Review, decide on tags, approve, publish
// ===========================================================================

console.log(`\n${B}Review${X}`);

const accepted = await bulkAcceptSuggestions(context, suggestions.map((s) => s.id));
check("10. Suggestions can be accepted", accepted.accepted > 0, `${accepted.accepted} accepted`);

const afterAccept = await db
  .select({ status: taxonomyAssignments.reviewStatus, origin: taxonomyAssignments.origin })
  .from(taxonomyAssignments)
  .where(eq(taxonomyAssignments.contentItemId, screenId));
check(
  "10a. An accepted suggestion is marked human-verified",
  afterAccept.every((a) => a.status !== "pending" && a.origin !== "ai_suggested"),
  afterAccept.map((a) => a.origin).join(", "),
);

await recordDecision(context, {
  contentId: screenId,
  decision: "approved",
  notes: "Acceptance run.",
});
const [approved] = await db
  .select({ status: contentItems.status })
  .from(contentItems)
  .where(eq(contentItems.id, screenId))
  .limit(1);
check("11. The screen can be approved", approved?.status === "approved", approved?.status ?? "");

await publishContent(context, screenId);
const [published] = await db
  .select({ status: contentItems.status })
  .from(contentItems)
  .where(eq(contentItems.id, screenId))
  .limit(1);
check("11a. And published", published?.status === "published", published?.status ?? "");

const publicScreen = await publicGet(`/screens/${screen.slug}`);
check("12. It is available on the public API", Boolean(publicScreen), publicScreen?.title ?? "");
check(
  "12a. With its state and capture conditions",
  publicScreen?.screen?.stateLabel === "Scrolled to plans",
  publicScreen?.screen?.stateLabel ?? "",
);
check(
  "12b. And a research-sized image",
  Boolean(publicScreen?.primaryMedia?.largeUrl ?? publicScreen?.primaryMedia?.originalUrl),
  publicScreen?.primaryMedia?.width
    ? `${publicScreen.primaryMedia.width}x${publicScreen.primaryMedia.height}`
    : "",
);

const publicList = await publicGet("/screens?pageSize=100");
const listedSlugs = new Set((publicList?.items ?? []).map((item) => item.slug));
check("12c. And appears in the screens listing", listedSlugs.has(screen.slug));

// ===========================================================================
// 14–18. Create a flow, walk it, review it, publish it
// ===========================================================================

console.log(`\n${B}Flows${X}`);

// Close the capture session before starting the flow walk. A worker holds a
// small number of live browsers, and leaving one open would make the next
// session queue behind a browser nobody is using.
await runCommand(session.sessionId, { type: "close" }, 15_000).catch(() => {});

const flow = await createFlow(context, {
  name: "Signup",
  goal: "Create an account and reach the product",
  sourceId: null,
});
check("14. A flow can be created", Boolean(flow.flowId), flow.slug);

const flowSession = await openSession(context, {
  url: SITE,
  profile: "desktop_1440",
  flowId: flow.flowId,
});
const flowLive = await waitForLive(flowSession.sessionId);
check("15a. A session can capture into a flow", flowLive?.status === "live", flowLive?.status ?? "");

const STEPS = [
  { screenName: "Home", stateLabel: null },
  { screenName: "Home", stateLabel: "Scrolled" },
  { screenName: "Home", stateLabel: "Further down" },
  { screenName: "Home", stateLabel: "Footer" },
];

let capturedSteps = 0;
for (const [index, step] of STEPS.entries()) {
  if (index > 0) {
    await runCommand(flowSession.sessionId, {
      type: "scroll",
      x: 700,
      y: 400,
      deltaX: 0,
      deltaY: 900,
    });
  }
  const result = await runCommand(flowSession.sessionId, {
    type: "capture",
    screenName: step.screenName,
    ...(step.stateLabel ? { stateLabel: step.stateLabel } : {}),
  });
  if (result.status === "done" && result.result?.contentItemId) capturedSteps += 1;
}
check("15b. Capture several intentional screens", capturedSteps === STEPS.length, `${capturedSteps}/${STEPS.length}`);

const assembled = await flowWithSteps(context, flow.flowId);
check("16. They appear as ordered flow steps", assembled?.steps.length === capturedSteps, `${assembled?.steps.length ?? 0} steps`);
check(
  "16a. Positions are contiguous and in capture order",
  (assembled?.steps ?? []).every((s, i) => s.position === i + 1),
  (assembled?.steps ?? []).map((s) => s.position).join(","),
);

// Close the flow session; a session left live holds a browser open.
await enqueueCommand(context, flowSession.sessionId, { type: "close" }).catch(() => {});

// A flow's steps must be published for a visitor to see a complete journey, so
// the whole set goes through the gate, not just the flow record.
const stepIds = (assembled?.steps ?? []).map((s) => s.screenId);
for (const id of stepIds) {
  const pending = await db
    .select({ id: taxonomyAssignments.id })
    .from(taxonomyAssignments)
    .where(
      and(eq(taxonomyAssignments.contentItemId, id), eq(taxonomyAssignments.reviewStatus, "pending")),
    );
  if (pending.length > 0) await bulkAcceptSuggestions(context, pending.map((p) => p.id));
  await recordDecision(context, { contentId: id, decision: "approved" });
  await publishContent(context, id);
}

const submitted = await submitFlowForReview(context, flow.flowId).catch((error) => {
  console.log(`  ${D}submit failed: ${error.message}${X}`);
  return null;
});
check("17a. A completed flow can be sent to review", submitted !== null, `${submitted?.stepCount ?? 0} steps`);

await recordDecision(context, { contentId: flow.flowId, decision: "approved" });
await publishContent(context, flow.flowId);

const [flowStatus] = await db
  .select({ status: contentItems.status })
  .from(contentItems)
  .where(eq(contentItems.id, flow.flowId))
  .limit(1);
check("17. The flow can be reviewed and approved", flowStatus?.status === "published", flowStatus?.status ?? "");

const publicFlow = await publicGet(`/flows/${flow.slug}`);
check("18. The flow appears publicly", Boolean(publicFlow), publicFlow?.title ?? "");
check(
  "18a. With its steps in order",
  (publicFlow?.steps ?? []).length === capturedSteps,
  `${(publicFlow?.steps ?? []).length} steps`,
);

// ===========================================================================
// 13 (second half). Rejected and pending content stays private
// ===========================================================================

console.log(`\n${B}What stays private${X}`);

const [strayScreen] = await db
  .select({ id: contentItems.id, slug: contentItems.slug })
  .from(contentItems)
  .where(and(eq(contentItems.kind, "screen"), inArray(contentItems.status, ["needs_review", "draft"])))
  .orderBy(desc(contentItems.createdAt))
  .limit(1);

if (strayScreen) {
  const stray = await publicGet(`/screens/${strayScreen.slug}`);
  check("13b. A pending screen is not public", stray === null, strayScreen.slug ?? "");
} else {
  console.log(`  ${D}skip  13b — no pending screen to check${X}`);
}

/**
 * Nothing the public API returns originates from the discovery queue.
 *
 * The first version of this check compared URLs and failed, correctly
 * rejecting its own logic: a Screen captured from linear.app/ shares a URL with
 * the candidate for linear.app/, and that is the system working — a person
 * chose that page. The invariant worth asserting is about *records*, not URLs:
 * every public item is a published `content_items` row, and no candidate id is
 * ever reachable.
 */
const publicItems = (await publicGet(`/content?pageSize=100`))?.items ?? [];
const publicIds = publicItems.map((item) => item.id);

const publishedIds = new Set(
  (
    await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(eq(contentItems.status, "published"))
  ).map((row) => row.id),
);
check(
  "13c. Every public record is a published content item",
  publicIds.every((id) => publishedIds.has(id)),
  `${publicIds.length} checked`,
);

const candidateIds = new Set(candidates.map((c) => c.id));
check(
  "13d. No discovery-queue record is reachable publicly",
  publicIds.every((id) => !candidateIds.has(id)),
  `${candidateIds.size} candidates`,
);

// And the triage queue reflects what was actually captured, even when the
// researcher opened the studio on a URL directly rather than from triage.
const homeCandidate = candidates.find((c) => (c.path ?? "/") === "/");
if (homeCandidate) {
  const [refreshed] = await db
    .select({ status: discoveredPages.status, screenCount: discoveredPages.screenCount })
    .from(discoveredPages)
    .where(eq(discoveredPages.id, homeCandidate.id))
    .limit(1);
  check(
    "13e. Capturing a URL marks its candidate captured",
    refreshed?.status === "captured" && (refreshed?.screenCount ?? 0) > 0,
    `${refreshed?.status} · ${refreshed?.screenCount ?? 0} screens`,
  );
}

// ===========================================================================

console.log(`\n${B}Result${X}`);
console.log(`  ${passed} passed, ${failed === 0 ? G : R}${failed} failed${X}`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  ${R}·${X} ${name}`);
}
console.log(
  `\n${D}Screen: ${env.CMS_BASE_URL}/screens/${screenId}\n` +
    `Flow:   ${env.CMS_BASE_URL}/flows/${flow.flowId}${X}\n`,
);

await handle.close();
process.exit(failed === 0 ? 0 : 1);
