/**
 * Take the old library down without destroying it.
 *
 * Everything in `content_items` today was produced by the previous pipeline —
 * a crawler decided it existed — or by acceptance runs. None of it was chosen
 * by a person, which is the only way content comes into being now.
 *
 * This archives it rather than deleting it. `published → archived` removes a
 * record from the public API and the public site immediately, and
 * `archived → draft | needs_review` is a permitted transition, so nothing here
 * is one-way. That matters: a delete is a decision you cannot inspect
 * afterwards, and "take it down" and "destroy it" are different requests.
 *
 * It runs through `bulkArchive`, so the lifecycle check, the permission check
 * and the audit row all happen exactly as they would if an operator had
 * selected everything in the CMS and pressed Archive.
 *
 *   node scripts/archive-legacy-library.mjs --dry-run
 *   node scripts/archive-legacy-library.mjs
 */
import { eq, isNull, sql } from "drizzle-orm";
import { contentItems, createDatabase, sources, users } from "@uxd/database";
import { bulkArchive } from "@uxd/api";
import { createStorage } from "@uxd/media";
import { createHeuristicProvider } from "@uxd/classification";
import { createLogger } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const X = "[0m";

const dryRun = process.argv.includes("--dry-run");

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ service: "archive", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-archive-legacy" });
const db = handle.db;

const [actor] = await db
  .select({ id: users.id, email: users.email, name: users.name, role: users.role })
  .from(users)
  .where(eq(users.role, "admin"))
  .limit(1);

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
  requestId: "archive-legacy",
  ip: null,
  userAgent: "archive-legacy",
  actor,
};

const live = await db
  .select({
    id: contentItems.id,
    kind: contentItems.kind,
    status: contentItems.status,
    title: contentItems.title,
    source: sources.name,
  })
  .from(contentItems)
  .leftJoin(sources, eq(sources.id, contentItems.sourceId))
  .where(sql`${contentItems.status} <> 'archived' and ${contentItems.deletedAt} is null`);

const byKind = new Map();
for (const row of live) {
  const key = `${row.kind} · ${row.status}`;
  byKind.set(key, (byKind.get(key) ?? 0) + 1);
}

console.log(`${B}Archiving the legacy library${X}${dryRun ? ` ${Y}(dry run)${X}` : ""}`);
console.log(`${D}archived records leave the public site and can be restored${X}\n`);
for (const [key, n] of [...byKind].sort()) {
  console.log(`  ${String(n).padStart(3)}  ${key}`);
}
console.log(`  ${String(live.length).padStart(3)}  ${B}total${X}`);

if (dryRun) {
  console.log(`\n${Y}Dry run. Re-run without --dry-run to apply.${X}\n`);
  await handle.close();
  process.exit(0);
}

// Batched, because `bulkApply` wraps each call in one transaction and one
// hundred records in a single transaction holds locks longer than it needs to.
const BATCH = 25;
let archived = 0;
const refused = [];

for (let i = 0; i < live.length; i += BATCH) {
  const batch = live.slice(i, i + BATCH).map((row) => row.id);
  const result = await bulkArchive(context, batch);
  archived += result.succeeded.length;
  for (const failure of result.failed) refused.push(failure);
  process.stdout.write(`\r  ${G}${archived}${X} archived…    `);
}

console.log(`\r  ${G}${archived}${X} archived            `);
if (refused.length > 0) {
  console.log(`  ${Y}${refused.length} refused${X}`);
  for (const failure of refused.slice(0, 5)) console.log(`    ${D}${failure.reason}${X}`);
}

// Counters derived from what just left the library. Left alone, every taxonomy
// term would keep reporting a usage count for records no longer in it.
await db.execute(sql`
  update ${sources} s set content_count = (
    select count(*)::int from ${contentItems} ci
     where ci.source_id = s.id and ci.deleted_at is null and ci.status <> 'archived')
`);
await db.execute(sql`
  with actual as (
    select t.id, (select count(*)::int from taxonomy_assignments a
                    join ${contentItems} ci on ci.id = a.content_item_id
                   where a.term_id = t.id and a.review_status = 'accepted'
                     and ci.deleted_at is null and ci.status <> 'archived') n
      from taxonomy_terms t
  )
  update taxonomy_terms t set usage_count = actual.n
    from actual where actual.id = t.id and t.usage_count <> actual.n
`);
console.log(`  ${G}recounted${X} source and taxonomy counters`);

const [remaining] = await db
  .select({ n: sql`count(*)::int` })
  .from(contentItems)
  .where(sql`${contentItems.status} = 'published' and ${contentItems.deletedAt} is null`);

console.log(`\n${B}Public library: ${remaining.n} record(s)${X}`);
console.log(
  `${D}Archived records are at ${env.CMS_BASE_URL}/content?status=archived and can be returned to draft.${X}\n`,
);

await handle.close();
