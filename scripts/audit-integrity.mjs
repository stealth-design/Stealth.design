#!/usr/bin/env node
/**
 * Data-integrity and provenance audit, run against the live database.
 *
 * Answers the questions Phase 6, 7, 8 and 13 of the audit brief ask, by
 * querying rather than by reading the schema and assuming it is honoured.
 * A column existing is not the same as a column being populated, and that
 * distinction is the whole point of this file: the inventory found five tables
 * that are modelled and empty, which no amount of schema reading would have
 * shown.
 *
 * Each check prints PASS, FAIL or NOTE. A NOTE is something true and worth
 * knowing that is not necessarily wrong.
 */
import { Client } from "pg";
import { loadEnvFile } from "@uxd/shared/env";

loadEnvFile();

const client = new Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres",
});
await client.connect();

const rows = async (sql, params) => (await client.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

let pass = 0;
let fail = 0;
let notes = 0;

const D = "\u001b[90m";
const G = "\u001b[32m";
const R = "\u001b[31m";
const Y = "\u001b[33m";
const B = "\u001b[1m";
const X = "\u001b[0m";

function check(label, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? `${G}PASS${X}` : `${R}FAIL${X}`} ${label}${detail ? `  ${D}${detail}${X}` : ""}`);
}
function note(label, detail) {
  notes += 1;
  console.log(`  ${Y}NOTE${X} ${label}${detail ? `  ${D}${detail}${X}` : ""}`);
}
const section = (t) => console.log(`\n${B}${t}${X}`);

// =========================================================================
section("Media storage — is it in object storage, not the database?");

const blobColumns = await rows(`
  select table_name, column_name, data_type
  from information_schema.columns
  where table_schema = 'public'
    and data_type in ('bytea', 'blob')
`);
check(
  "no binary columns anywhere in the schema",
  blobColumns.length === 0,
  blobColumns.map((c) => `${c.table_name}.${c.column_name}`).join(", ") || "0 bytea columns",
);

const keyless = await one(`
  select count(*)::int n from media_assets
  where storage_key is null or storage_key = ''
`);
check("every media asset has a storage key", keyless.n === 0, `${keyless.n} without one`);

const derivKeyless = await one(`
  select count(*)::int n from media_derivatives
  where storage_key is null or storage_key = ''
`);
check("every derivative has a storage key", derivKeyless.n === 0, `${derivKeyless.n} without one`);

// =========================================================================
section("Media deduplication — are identical captures stored once?");

const dupeHashes = await rows(`
  select sha256, count(*)::int n
  from media_assets
  where deleted_at is null
  group by sha256
  having count(*) > 1
`);
check(
  "no two live assets share a sha256",
  dupeHashes.length === 0,
  dupeHashes.length ? `${dupeHashes.length} duplicated hashes` : "all distinct",
);

const reuse = await one(`
  select
    count(*)::int assets,
    (select count(*)::int from media_usages) usages
  from media_assets where deleted_at is null
`);
note(
  "asset reuse",
  `${reuse.assets} assets serving ${reuse.usages} usages (${(reuse.usages / Math.max(1, reuse.assets)).toFixed(2)} per asset)`,
);

const noPerceptual = await one(`
  select count(*)::int n from media_assets
  where deleted_at is null and kind = 'image' and perceptual_hash is null
`);
check(
  "every live image has a perceptual hash",
  noPerceptual.n === 0,
  `${noPerceptual.n} missing — near-duplicate detection cannot see these`,
);

const noDerivatives = await rows(`
  select a.id, a.original_filename, a.mime_type
  from media_assets a
  where a.deleted_at is null
    and a.status = 'ready'
    and a.kind = 'image'
    and not exists (select 1 from media_derivatives d where d.media_id = a.id)
`);
check(
  "every ready image has at least one derivative",
  noDerivatives.length === 0,
  noDerivatives.length ? `${noDerivatives.length} without a thumbnail` : "all thumbnailed",
);

const orphans = await rows(`
  select a.id, a.original_filename, a.created_at
  from media_assets a
  where a.deleted_at is null
    and not exists (select 1 from media_usages u where u.media_id = a.id)
`);
if (orphans.length === 0) check("no orphaned media", true);
else note("orphaned media", `${orphans.length} assets attached to nothing — the Media screen's "unused" filter finds these`);

// =========================================================================
section("Provenance — can every asset answer where it came from?");

const PROVENANCE = [
  ["source_url", "which URL created it"],
  ["origin_domain", "which domain"],
  ["captured_at", "when it was captured"],
  ["capture_method", "how it was captured"],
  ["source_id", "which source it belongs to"],
];

for (const [column, question] of PROVENANCE) {
  const missing = await one(
    `select count(*)::int n from media_assets where deleted_at is null and ${column} is null`,
  );
  const total = await one("select count(*)::int n from media_assets where deleted_at is null");
  check(
    `${question} (${column})`,
    missing.n === 0,
    missing.n === 0 ? `all ${total.n}` : `${missing.n}/${total.n} missing`,
  );
}

// Viewport and capture id are only meaningful for browser captures.
const browserCaptured = await one(`
  select
    count(*)::int total,
    count(*) filter (where viewport_width is null or viewport_height is null)::int no_viewport,
    count(*) filter (where capture_id is null)::int no_capture,
    count(*) filter (where crawl_job_id is null)::int no_job
  from media_assets
  where deleted_at is null and capture_method = 'browser_render'
`);
check(
  "browser captures record a viewport",
  browserCaptured.no_viewport === 0,
  `${browserCaptured.no_viewport}/${browserCaptured.total} missing`,
);
if (browserCaptured.no_capture > 0) {
  note(
    "assets not linked to a capture row",
    `${browserCaptured.no_capture}/${browserCaptured.total} — cannot answer "which capture produced this"`,
  );
} else {
  check("browser captures link to a capture row", true, `all ${browserCaptured.total}`);
}
if (browserCaptured.no_job > 0) {
  note(
    "assets not linked to a crawl job",
    `${browserCaptured.no_job}/${browserCaptured.total} — cannot answer "which job produced this"`,
  );
} else {
  check("browser captures link to a crawl job", true, `all ${browserCaptured.total}`);
}

// =========================================================================
section("Referential integrity — do the relationships actually hold?");

const DANGLING = [
  ["content_items.source_id", "content_items", "source_id", "sources"],
  ["content_items.primary_media_id", "content_items", "primary_media_id", "media_assets"],
  ["content_items.experience_id", "content_items", "experience_id", "content_items"],
  ["media_usages.media_id", "media_usages", "media_id", "media_assets"],
  ["media_usages.content_item_id", "media_usages", "content_item_id", "content_items"],
  ["media_derivatives.media_id", "media_derivatives", "media_id", "media_assets"],
  ["page_details.content_item_id", "page_details", "content_item_id", "content_items"],
  ["flow_steps.flow_id", "flow_steps", "flow_id", "content_items"],
  ["flow_steps.content_item_id", "flow_steps", "content_item_id", "content_items"],
  ["taxonomy_assignments.term_id", "taxonomy_assignments", "term_id", "taxonomy_terms"],
  ["captures.content_item_id", "captures", "content_item_id", "content_items"],
  ["collection_items.collection_id", "collection_items", "collection_id", "collections"],
];

for (const [label, table, column, target] of DANGLING) {
  const dangling = await one(`
    select count(*)::int n from "${table}" t
    where t.${column} is not null
      and not exists (select 1 from "${target}" x where x.id = t.${column})
  `);
  check(`${label} → ${target}`, dangling.n === 0, dangling.n ? `${dangling.n} dangling` : "clean");
}

// A page-kind record with no detail row is a flattened concept, not a bug per
// se, but it means the spine/detail split is not being honoured.
const detailless = await rows(`
  select kind, count(*)::int n from content_items ci
  where deleted_at is null
    and not exists (select 1 from page_details d where d.content_item_id = ci.id)
    and not exists (select 1 from screen_details d where d.content_item_id = ci.id)
    and not exists (select 1 from flow_details d where d.content_item_id = ci.id)
    and not exists (select 1 from state_details d where d.content_item_id = ci.id)
    and not exists (select 1 from interaction_details d where d.content_item_id = ci.id)
    and not exists (select 1 from experience_details d where d.content_item_id = ci.id)
  group by kind
`);
check(
  "every content record has its kind's detail row",
  detailless.length === 0,
  detailless.map((r) => `${r.kind}=${r.n}`).join(" ") || "all present",
);

// =========================================================================
section("Publishing invariants — enforced, or merely intended?");

const badPublished = await rows(`
  select id, title, slug, published_at, rights_status from content_items
  where status = 'published'
    and (title is null or slug is null or published_at is null
         or rights_status in ('pending_review','restricted','removed','do_not_republish'))
`);
check(
  "no published record violates the publish gate",
  badPublished.length === 0,
  badPublished.length ? `${badPublished.length} violate it` : "clean",
);

const unattributed = await one(`
  select count(*)::int n from content_items
  where status in ('approved','published') and (approved_by is null or approved_at is null)
`);
check("every approved/published record names its approver", unattributed.n === 0, `${unattributed.n} unattributed`);

const publicWithoutMedia = await rows(`
  select kind, count(*)::int n from content_items ci
  where status = 'published'
    and kind in ('page','screen','website','app')
    and primary_media_id is null
  group by kind
`);
check(
  "no published page/screen lacks an image",
  publicWithoutMedia.length === 0,
  publicWithoutMedia.map((r) => `${r.kind}=${r.n}`).join(" ") || "all have one",
);

const publishedUnreviewedTaxonomy = await one(`
  select count(distinct ci.id)::int n
  from content_items ci
  join taxonomy_assignments ta on ta.content_item_id = ci.id
  where ci.status = 'published'
    and ta.origin = 'ai_suggested'
    and ta.review_status = 'pending'
`);
if (publishedUnreviewedTaxonomy.n > 0) {
  note(
    "published records carrying unreviewed suggestions",
    `${publishedUnreviewedTaxonomy.n} — correct, and they must not be publicly visible; the public query filters on origin`,
  );
} else {
  check("no published record carries an unreviewed suggestion", true);
}

// =========================================================================
section("Versioning — does the model support change over time?");

const captureCounts = await rows(`
  select c.content_item_id, count(*)::int versions
  from captures c
  group by c.content_item_id
  having count(*) > 1
`);
note(
  "records with more than one capture",
  captureCounts.length
    ? `${captureCounts.length} record(s), max ${Math.max(...captureCounts.map((c) => c.versions))} versions`
    : "none yet — versioning is modelled but unexercised in this dataset",
);

const capturesWithoutHash = await one(
  "select count(*)::int n from captures where status = 'succeeded' and content_hash is null",
);
check(
  "every successful capture records a content hash",
  capturesWithoutHash.n === 0,
  `${capturesWithoutHash.n} without one — change detection cannot compare these`,
);

const registryVsPages = await one(`
  select
    (select count(*)::int from page_details) pages,
    (select count(*)::int from url_registry) registry
`);
if (registryVsPages.registry < registryVsPages.pages) {
  note(
    "url_registry is behind page_details",
    `${registryVsPages.registry} registry vs ${registryVsPages.pages} pages — records written outside intakeCapture (the demo seed) bypass the registry, so duplicate detection cannot see their URLs`,
  );
} else {
  check("url_registry covers every captured page", true, `${registryVsPages.registry} entries`);
}

// =========================================================================
section("Counter drift — are maintained counts telling the truth?");

const sourceDrift = await rows(`
  select s.name, s.content_count recorded,
    (select count(*)::int from content_items ci where ci.source_id = s.id and ci.deleted_at is null) actual
  from sources s
  where s.deleted_at is null
`);
const driftedSources = sourceDrift.filter((r) => r.recorded !== r.actual);
check(
  "sources.content_count matches reality",
  driftedSources.length === 0,
  driftedSources.map((r) => `${r.name} ${r.recorded}≠${r.actual}`).join(" ") || `all ${sourceDrift.length} correct`,
);

// Accepted only, matching `recomputeTermUsage`. Counting pending suggestions
// here would make this check pass against a counter that lies to curators.
const termDrift = await rows(`
  select t.name, t.usage_count recorded,
    (select count(*)::int from taxonomy_assignments ta
      where ta.term_id = t.id and ta.review_status = 'accepted') actual
  from taxonomy_terms t
`);
const driftedTerms = termDrift.filter((r) => r.recorded !== r.actual);
check(
  "taxonomy_terms.usage_count matches reality",
  driftedTerms.length === 0,
  driftedTerms.length ? `${driftedTerms.length} of ${termDrift.length} drifted` : `all ${termDrift.length} correct`,
);

const collectionDrift = await rows(`
  select c.name, c.item_count recorded,
    (select count(*)::int from collection_items ci where ci.collection_id = c.id) actual
  from collections c where c.deleted_at is null
`);
const driftedCollections = collectionDrift.filter((r) => r.recorded !== r.actual);
check(
  "collections.item_count matches reality",
  driftedCollections.length === 0,
  driftedCollections.map((r) => `${r.name} ${r.recorded}≠${r.actual}`).join(" ") || "all correct",
);

const flowDrift = await rows(`
  select ci.title, f.step_count recorded,
    (select count(*)::int from flow_steps s where s.flow_id = f.content_item_id) actual
  from flow_details f join content_items ci on ci.id = f.content_item_id
`);
const driftedFlows = flowDrift.filter((r) => r.recorded !== r.actual);
check(
  "flow_details.step_count matches reality",
  driftedFlows.length === 0,
  driftedFlows.map((r) => `${r.title} ${r.recorded}≠${r.actual}`).join(" ") || "all correct",
);

// =========================================================================
section("Modelled but unexercised");

const EXPECTED_EMPTY_MEANING = {
  interaction_details: "Phase 5 interaction capture has never produced a record",
  state_details: "no state (hover, modal open, error) has been captured as its own record",
  classification_suggestions: "field-level AI suggestions (title, description) have never been produced — only term assignments",
  content_relations: "no typed relationship (variant-of, precedes, replaces) has ever been created",
  worker_tokens: "per-worker credentials unused; every worker authenticates with the shared secret",
};

for (const [table, meaning] of Object.entries(EXPECTED_EMPTY_MEANING)) {
  const count = await one(`select count(*)::int n from "${table}"`);
  if (count.n === 0) note(`${table} is empty`, meaning);
  else check(`${table} has data`, true, `${count.n} rows`);
}

// =========================================================================
console.log(`\n${B}${pass} passed, ${fail} failed, ${notes} notes${X}\n`);
await client.end();
process.exit(fail > 0 ? 1 : 0);
