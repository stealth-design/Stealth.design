/**
 * Clear the library so it can be rebuilt by hand.
 *
 * Everything currently in `content_items` was created by the old pipeline — a
 * crawler decided it existed — or by acceptance runs. None of it was chosen by
 * a person, which is the only way content comes into being now. So this removes
 * it, along with the discovery queue, the sessions and the jobs that produced
 * it, and leaves the parts that are genuinely authored: the taxonomy, the
 * settings, the users, and the sources for the products still being studied.
 *
 * Media files are deliberately NOT touched. Deleting bytes off disk is the one
 * irreversible step here, and it deserves its own decision rather than being
 * swept along with rows that can be re-created by re-capturing. The script
 * reports how much is left orphaned.
 *
 *   node scripts/reset-library.mjs --dry-run
 *   node scripts/reset-library.mjs
 */
import { inArray, notInArray, sql } from "drizzle-orm";
import {
  captureSessions,
  collectionItems,
  collections,
  contentItems,
  crawlJobs,
  createDatabase,
  discoveredPages,
  mediaAssets,
  sources,
  taxonomyTerms,
} from "@uxd/database";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const X = "[0m";

/**
 * The products worth keeping a source record for.
 *
 * Their rights position, health history and crawl settings live on the source
 * and are worth preserving across a library reset. Every other source in the
 * database is a one-page artefact of a crawl experiment.
 */
const KEEP_DOMAINS = [
  "linear.app",
  "stripe.com",
  "www.airbnb.com",
  "www.airbnb.co.in",
  "www.notion.so",
  "www.notion.com",
  "www.figma.com",
  "www.raycast.com",
  "www.vercel.com",
  "vercel.com",
  "www.framer.com",
  "arc.net",
  "www.superlist.com",
];

const dryRun = process.argv.includes("--dry-run");

loadEnvFile();
const env = loadCmsEnv();
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-reset-library" });
const db = handle.db;

const count = async (table, where) => {
  const [row] = await db.select({ n: sql`count(*)::int` }).from(table).where(where);
  return row?.n ?? 0;
};

console.log(`${B}Resetting the library${X}${dryRun ? ` ${Y}(dry run — nothing is written)${X}` : ""}`);
console.log(`${D}${env.DATABASE_URL.replace(/:[^:@]*@/, ":***@")}${X}\n`);

// --- What will go ---------------------------------------------------------

const doomedSources = await db
  .select({ id: sources.id, name: sources.name, domain: sources.domain })
  .from(sources)
  .where(notInArray(sources.domain, KEEP_DOMAINS));

const before = {
  content: await count(contentItems),
  discovered: await count(discoveredPages),
  sessions: await count(captureSessions),
  jobs: await count(crawlJobs),
  collectionItems: await count(collectionItems),
  media: await count(mediaAssets),
  terms: await count(taxonomyTerms),
};

console.log(`${B}Removing${X}`);
console.log(`  ${before.content} content record(s) — every page, screen and flow`);
console.log(`  ${before.discovered} discovered page(s) — the candidate queue`);
console.log(`  ${before.sessions} capture session(s)`);
console.log(`  ${before.jobs} crawl job(s), with their items and logs`);
console.log(`  ${before.collectionItems} collection membership(s)`);
console.log(`  ${doomedSources.length} source(s) with no product behind them`);

console.log(`\n${B}Keeping${X}`);
console.log(`  ${before.terms} taxonomy term(s) — the vocabulary is authored, not crawled`);
console.log(`  ${KEEP_DOMAINS.length} source domain(s) for the products being studied`);
console.log(`  users, settings, audit log`);
console.log(
  `  ${D}${before.media} media asset(s) stay on disk — orphaned, and deletable separately${X}`,
);

if (dryRun) {
  console.log(`\n${Y}Dry run. Re-run without --dry-run to apply.${X}\n`);
  await handle.close();
  process.exit(0);
}

// --- Do it ----------------------------------------------------------------
//
// Order matters, and `content_items.source_id` is why: it is ON DELETE RESTRICT
// precisely so a source cannot be removed while records still point at it. So
// content goes first, then the sources it was holding down.

console.log(`\n${B}Applying${X}`);

await db.delete(discoveredPages);
console.log(`  ${G}cleared${X} the discovery queue`);

await db.delete(captureSessions);
console.log(`  ${G}cleared${X} capture sessions`);

// Cascades to collection_items, taxonomy_assignments, media_usages, captures
// and the per-kind detail tables.
await db.delete(contentItems);
console.log(`  ${G}deleted${X} every content record`);

await db.delete(crawlJobs);
console.log(`  ${G}deleted${X} crawl jobs, items and logs`);

if (doomedSources.length > 0) {
  await db.delete(sources).where(
    inArray(
      sources.id,
      doomedSources.map((s) => s.id),
    ),
  );
  console.log(`  ${G}deleted${X} ${doomedSources.length} experiment source(s)`);
}

// Counters that were derived from what we just removed. Left alone they would
// report a library that no longer exists — and every "43 pages" on a taxonomy
// term would be a lie the UI has no way to notice.
await db.execute(sql`update ${sources} set content_count = 0`);
await db.execute(sql`update ${taxonomyTerms} set usage_count = 0`);
await db.execute(sql`update ${collections} set item_count = 0`);
console.log(`  ${G}reset${X} the derived counters`);

const after = {
  content: await count(contentItems),
  discovered: await count(discoveredPages),
  sources: await count(sources),
  media: await count(mediaAssets),
};

console.log(`\n${B}Now${X}`);
console.log(`  ${after.content} content records · ${after.discovered} candidates · ${after.sources} sources`);
console.log(
  `  ${D}${after.media} media assets are now unused. \`node scripts/sweep-media.mjs\` would remove them.${X}\n`,
);

await handle.close();
