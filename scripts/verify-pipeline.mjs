#!/usr/bin/env node
/**
 * End-to-end pipeline check: CMS decision → public API → public site.
 *
 * The single most important property of this system is the one §"the CMS is
 * the source of truth" states: everything public originates from a CMS record a
 * person approved, and nothing public is maintained independently. That is not
 * a property a unit test can demonstrate, because it spans three processes.
 * So this script drives the real service layer with a real admin actor — the
 * same publish gate, transition map, audit writes and serialisers that run in
 * production — and then asks the public API and the public site whether the
 * record actually arrived.
 *
 * It also checks the reverse direction, which matters just as much: a rights
 * hold placed in the CMS must withdraw the record from the public API
 * immediately, without anyone remembering to unpublish it separately.
 *
 * Run it with all three processes up:
 *
 *   npm run db:serve      # terminal 1
 *   npm run dev:cms       # terminal 2
 *   npm run dev:frontend  # terminal 3
 *   node scripts/verify-pipeline.mjs
 *
 * It leaves the database as it found it: the record ends up published, which is
 * a state a developer can keep working from.
 *
 * ## A note on the site checks
 *
 * The public site caches its API reads for 60 seconds. A record published a
 * moment ago is therefore not necessarily on the front page yet, and that is
 * correct behaviour rather than a bug — so the site checks poll for up to two
 * minutes instead of asserting immediately. A cache-busting query string on the
 * *page* URL does not help: Next keys its data cache on the API request, not on
 * the page request.
 */
import { eq } from "drizzle-orm";
import { createDatabase, contentItems, taxonomyAssignments, taxonomyTerms, users } from "@uxd/database";
import {
  addAssignment,
  checkPublishability,
  publishContent,
  recordDecision,
  unpublishContent,
  updateRights,
} from "@uxd/api";
import { createStorage } from "@uxd/media";
import { createHeuristicProvider } from "@uxd/classification";
import { createLogger } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ name: "verify", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-verify" });

const [actor] = await handle.db
  .select({ id: users.id, email: users.email, name: users.name, role: users.role })
  .from(users)
  .where(eq(users.role, "admin"))
  .limit(1);

const context = {
  db: handle.db,
  storage: createStorage({
    driver: "local",
    localRoot: env.STORAGE_LOCAL_ROOT ?? ".data/media",
    localPublicBaseUrl: env.STORAGE_LOCAL_PUBLIC_BASE_URL ?? "/media",
  }),
  classifier: createHeuristicProvider(),
  logger,
  env,
  requestId: "verify-pipeline",
  ip: null,
  userAgent: "verify",
  actor,
};

let failures = 0;
let checks = 0;

const step = (label, ok, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const [record] = await handle.db
  .select({ id: contentItems.id, title: contentItems.title, status: contentItems.status, slug: contentItems.slug })
  .from(contentItems)
  .where(eq(contentItems.kind, "page"))
  .limit(1);

if (!record) {
  console.log("No page records — run a capture first.");
  await handle.close();

console.log(
  `\n${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} failed` : ""}\n`,
);
// Explicit, because `fetch` keeps sockets alive and the process would otherwise
// linger — and because a verification script that cannot fail is not one.
process.exit(failures > 0 ? 1 : 0);
  process.exit(0);
}

console.log(`\nRecord: ${record.title} (${record.status})\n`);

// A record left published by an earlier run is withdrawn first, so the run
// actually exercises the gate instead of reporting "already published" and
// skipping the interesting part.
if (record.status === "published") {
  await unpublishContent(context, record.id, "Verification run: re-testing the publish path.");
  step("withdrew the previously published record", true);
  record.status = "approved";
}

// --- 1. The gate refuses it while rights are unsettled -------------------
// Put the record into a state the gate must refuse, then confirm it does. This
// is the assertion that matters most on this screen: the gate is what stands
// between a crawler and a public page.
await updateRights(context, record.id, { rightsStatus: "pending_review" });
const before = await checkPublishability(handle.db, record.id);
step(
  "publish gate refuses a record whose rights are unsettled",
  before !== null && !before.result.allowed,
  before?.result.blockers.map((b) => b.code).join(", ") || "(allowed — should not be)",
);

// --- 2. Settle rights, approve, publish ---------------------------------
await updateRights(context, record.id, {
  rightsStatus: "reference_use",
  attribution: "Shown for reference.",
});
step("rights recorded", true, "reference_use");

// A record left restricted by an earlier run re-enters review first, because
// `restricted -> approved` is not a legal transition and should not be.
if (record.status === "restricted") {
  await recordDecision(context, {
    contentId: record.id,
    decision: "changes_requested",
    notes: "Rights question settled; returning to review.",
  });
  step("restricted record returned to review", true);
}

if (record.status !== "approved" && record.status !== "published") {
  await recordDecision(context, { contentId: record.id, decision: "approved" });
  step("approved", true);
}

const after = await checkPublishability(handle.db, record.id);
step(
  "publish gate now allows it",
  after?.result.allowed === true,
  after?.result.blockers.map((b) => b.message).join(" ") ?? "",
);

if (after?.result.allowed) await publishContent(context, record.id);

const [published] = await handle.db
  .select({ status: contentItems.status, slug: contentItems.slug, publishedAt: contentItems.publishedAt })
  .from(contentItems)
  .where(eq(contentItems.id, record.id))
  .limit(1);
step("record is published", published.status === "published", `slug=${published.slug}`);

// --- 3. A human-confirmed classification, so facets have something ------
const [term] = await handle.db
  .select({ id: taxonomyTerms.id, name: taxonomyTerms.name, slug: taxonomyTerms.slug })
  .from(taxonomyTerms)
  .where(eq(taxonomyTerms.kind, "page_type"))
  .limit(1);
if (term) {
  await addAssignment(context, { contentItemId: record.id, termId: term.id });
  step("human-added classification", true, `${term.name}`);
}

// --- 4. The public API serves it, with nothing internal -----------------
const apiBase = "http://localhost:3000/api/public";
const list = await (await fetch(`${apiBase}/content`)).json();
step("public API lists it", list.items.some((i) => i.id === record.id), `total=${list.total}`);

const forbidden = ["internalNotes", "reviewNotes", "rightsNotes", "storageKey", "crawlJobId", "createdBy", "approvedBy", "errorMessage"];
const leaked = forbidden.filter((f) => JSON.stringify(list).includes(`"${f}"`));
step("no internal fields in the response", leaked.length === 0, leaked.join(", "));

const detail = await (await fetch(`${apiBase}/content/${published.slug}`)).json();
step("public API serves the detail", detail.id === record.id, `${detail.media?.length ?? 0} media`);

const facets = await (await fetch(`${apiBase}/facets`)).json();
const facetTerms = facets.facets.flatMap((g) => g.terms.map((t) => t.term.slug));
step("facet appears for the confirmed term", term ? facetTerms.includes(term.slug) : true, facetTerms.join(", ") || "(none)");

// --- 5. The public site renders it --------------------------------------
/**
 * Poll a page until it contains what it should, or give up.
 *
 * Waits out the site's 60-second read cache rather than pretending it is not
 * there. Reports how long it took, because "appeared after 40s" and "appeared
 * immediately" mean different things about the cache and both are fine.
 */
async function pollSite(path, needles, timeoutMs = 120_000) {
  const started = Date.now();
  let lastStatus = 0;
  let missing = [...needles];
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`http://localhost:3001${path}`);
    lastStatus = response.status;
    const body = await response.text();
    missing = needles.filter((needle) => !body.includes(needle));
    if (response.status === 200 && missing.length === 0) {
      const waited = Math.round((Date.now() - started) / 1000);
      step(`site ${path}`, true, waited > 1 ? `after ${waited}s (read cache)` : "200");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  step(`site ${path}`, false, `${lastStatus}, still missing: ${missing.join(", ")}`);
  return false;
}

for (const [path, needles] of [
  ["/browse", [record.title]],
  ["/patterns", term ? [term.name] : []],
  [`/entry/${published.slug}`, [record.title, "Captured from"]],
]) {
  await pollSite(path, needles);
}

// --- 6. A rights hold withdraws it immediately --------------------------
await updateRights(context, record.id, { rightsStatus: "restricted" });
const held = await (await fetch(`${apiBase}/content/${published.slug}`)).json();
step("a rights hold withdraws it from the public API", held.error?.code === "NOT_FOUND", JSON.stringify(held).slice(0, 60));

const [afterHold] = await handle.db
  .select({ status: contentItems.status })
  .from(contentItems)
  .where(eq(contentItems.id, record.id))
  .limit(1);
step("status moved to restricted", afterHold.status === "restricted", afterHold.status);

// --- 7. Restore, so the database is left usable -------------------------
// `restricted -> approved` is not a legal transition, and correctly so: a
// record withheld for a rights question re-enters review rather than jumping
// back to approved. So the restore follows the same path a person would.
await updateRights(context, record.id, { rightsStatus: "reference_use" });
await recordDecision(context, {
  contentId: record.id,
  decision: "changes_requested",
  notes: "Verification run: restoring the record to a usable state.",
});
await recordDecision(context, { contentId: record.id, decision: "approved" });
await publishContent(context, record.id);
const [restored] = await handle.db
  .select({ status: contentItems.status })
  .from(contentItems)
  .where(eq(contentItems.id, record.id))
  .limit(1);
step("restored to published", restored.status === "published");

await handle.close();

console.log(
  `\n${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} failed` : ""}\n`,
);
// Explicit, because `fetch` keeps sockets alive and the process would otherwise
// linger — and because a verification script that cannot fail is not one.
process.exit(failures > 0 ? 1 : 0);
