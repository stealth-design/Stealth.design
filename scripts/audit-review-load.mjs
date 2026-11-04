/**
 * How much human work does the pipeline actually create?
 *
 * The audit brief's stated success condition is that "a human can efficiently
 * operate the content pipeline". That is not a code property, so no test can
 * assert it — but it is measurable, and the measurements are all in the
 * database. This script asks the questions an operations lead would ask before
 * hiring a content team:
 *
 *   1. How many decisions does one captured URL generate?
 *   2. Is the confidence score separable — can high-confidence suggestions be
 *      bulk-accepted, leaving a human to look only at the tail? If confidence
 *      carries no information, every suggestion needs individual attention and
 *      the review queue's page size becomes the operator's throughput limit.
 *   3. When the classifier and a human have both labelled the same item, do
 *      they agree? This is the only precision figure available without paying
 *      someone to label a holdout set.
 *   4. What does the workload look like at 100, 500 and 1000 items?
 *
 * Read-only. Safe against a development database with real data in it.
 *
 *   node scripts/audit-review-load.mjs
 */
import { Client } from "pg";

process.loadEnvFile(".env");

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const R = "[31m";
const X = "[0m";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

/** @param {string} sql @param {unknown[]} [params] */
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const heading = (text) => console.log(`\n${B}${text}${X}`);
const note = (text) => console.log(`  ${D}${text}${X}`);

console.log(`${B}Review workload — what the pipeline asks a human to do${X}`);

// --- 1. Decisions per item ------------------------------------------------

heading("1. Decisions per captured item");

const [totals] = await q(`
  select
    (select count(*)::int from content_items) as items,
    (select count(*)::int from content_items where classification_model is not null) as classified,
    (select count(*)::int from taxonomy_assignments where review_status = 'pending') as pending,
    (select count(*)::int from classification_suggestions where review_status = 'pending') as pending_fields
`);

const perItem = totals.classified > 0 ? totals.pending / totals.classified : 0;
console.log(
  `  ${totals.items} content items · ${totals.classified} classified · ${totals.pending} taxonomy decisions pending`,
);
console.log(`  ${B}${perItem.toFixed(1)}${X} pending decisions per classified item`);
if (totals.pending_fields === 0) {
  note("0 field suggestions. The heuristic provider returns none, so the");
  note("`classification_suggestions` table is unreachable without an LLM key —");
  note("half the review workflow has never executed.");
}

const spread = await q(`
  select n, count(*)::int items from (
    select content_item_id, count(*)::int n
      from taxonomy_assignments
     where review_status = 'pending' and content_item_id is not null
     group by 1
  ) t group by 1 order by n
`);
if (spread.length > 0) {
  note("");
  note("decisions per item -> how many items");
  for (const row of spread) {
    console.log(`    ${String(row.n).padStart(3)} | ${"#".repeat(Math.min(40, row.items))} ${row.items}`);
  }
}

// --- 2. Is confidence separable? ------------------------------------------

heading("2. Is the confidence score usable for triage?");

const bands = await q(`
  select width_bucket(confidence, 0, 1, 10) as band, count(*)::int n
    from taxonomy_assignments
   where review_status = 'pending' and confidence is not null
   group by 1 order by 1
`);

if (bands.length === 0) {
  console.log(`  ${Y}No pending suggestions carry a confidence score.${X}`);
} else {
  const max = Math.max(...bands.map((b) => b.n));
  for (const band of bands) {
    const lo = ((band.band - 1) / 10).toFixed(1);
    const hi = (band.band / 10).toFixed(1);
    const bar = "=".repeat(Math.max(1, Math.round((band.n / max) * 44)));
    console.log(`  ${lo}-${hi}  ${bar} ${band.n}`);
  }

  const [distinct] = await q(`
    select count(distinct confidence)::int d, min(confidence) lo, max(confidence) hi
      from taxonomy_assignments where review_status = 'pending' and confidence is not null
  `);
  note("");
  note(`${distinct.d} distinct confidence values, spanning ${distinct.lo} to ${distinct.hi}.`);
  if (distinct.d <= 8) {
    console.log(`  ${Y}Only ${distinct.d} distinct values.${X} The score is a small set of rule`);
    console.log(`  weights, not a calibrated probability. It is usable for coarse`);
    console.log(`  sorting, but a numeric auto-accept threshold would be arbitrary.`);
  }
}

// --- 3. Do the classifier and a human agree? ------------------------------

heading("3. Classifier vs human, where both have labelled the same item");

const [overlap] = await q(`
  with human as (
    select content_item_id, term_id from taxonomy_assignments
     where origin in ('human_added','human_verified') and review_status = 'accepted'
       and content_item_id is not null
  ), ai as (
    select content_item_id, term_id from taxonomy_assignments
     where origin = 'ai_suggested' and content_item_id is not null
  )
  select
    (select count(distinct content_item_id)::int from human) as human_items,
    (select count(distinct content_item_id)::int from ai) as ai_items,
    (select count(distinct h.content_item_id)::int
       from human h join ai a on a.content_item_id = h.content_item_id) as both_items,
    (select count(*)::int from human h join ai a
       on a.content_item_id = h.content_item_id and a.term_id = h.term_id) as agreements
`);

console.log(`  ${overlap.human_items} items carry human labels · ${overlap.ai_items} carry AI suggestions`);
if (overlap.both_items === 0) {
  console.log(`  ${R}No item has both.${X} Precision cannot be measured from this data: the`);
  console.log(`  human-labelled items are seed data and the AI-labelled ones are crawled,`);
  console.log(`  so the two sets never meet.`);
  console.log(`  ${B}Measuring classifier quality needs a deliberately double-labelled set.${X}`);
} else {
  const rate = ((overlap.agreements / overlap.both_items) * 100).toFixed(0);
  console.log(
    `  ${overlap.both_items} items have both · ${overlap.agreements} suggestions match a human choice (${rate}% per item)`,
  );
}

// --- 4. What this costs at scale ------------------------------------------

heading("4. Projected review workload");

const decisionSeconds = 8; // Generous for accept/reject on a familiar taxonomy.
note(`Assuming ${decisionSeconds}s per individual decision, and that bulk-accept`);
note("clears a whole page of 40 in one action.");
console.log("");
console.log(`  ${"items".padStart(7)}  ${"decisions".padStart(10)}  ${"one-by-one".padStart(12)}  ${"bulk pages".padStart(11)}`);
for (const items of [100, 500, 1_000]) {
  const decisions = Math.round(items * perItem);
  const solo = (decisions * decisionSeconds) / 3600;
  const pages = Math.ceil(decisions / 40);
  console.log(
    `  ${String(items).padStart(7)}  ${String(decisions).padStart(10)}  ${(solo.toFixed(1) + "h").padStart(12)}  ${String(pages).padStart(11)}`,
  );
}

// --- 5. Where content is sitting ------------------------------------------

heading("5. Where content is sitting");

const byStatus = await q(`
  select status, count(*)::int n from content_items group by 1 order by n desc
`);
for (const row of byStatus) {
  console.log(`  ${row.status.padEnd(16)} ${String(row.n).padStart(4)}`);
}

const [unclassified] = await q(`
  select count(*)::int n from content_items
   where classification_model is null and status not in ('published','archived')
`);
if (unclassified.n > 0) {
  console.log("");
  console.log(`  ${Y}${unclassified.n} unpublished items were never classified.${X}`);
  note("Either capture ran with autoClassify off, or classification failed");
  note("quietly. Neither appears in the CMS as a state needing attention.");
}

const [orphans] = await q(`
  select count(*)::int n from content_items c
   where c.status = 'published'
     and not exists (select 1 from taxonomy_assignments a
                      where a.content_item_id = c.id and a.review_status = 'accepted')
`);
console.log("");
if (orphans.n > 0) {
  console.log(`  ${R}${orphans.n} published items carry no accepted taxonomy.${X}`);
  note("They are live but unreachable by any facet or filter on the frontend.");
} else {
  console.log(`  ${G}Every published item carries at least one accepted term.${X}`);
}

await client.end();
console.log("");
