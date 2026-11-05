/**
 * One-off: give every website a clean public address from its name.
 *
 *   node scripts/clean-website-slugs.mjs            dry run: prints the changes
 *   node scripts/clean-website-slugs.mjs --apply    makes them
 *
 * Websites were created with a random ending (gladia-io-9jma) so slugs could
 * never clash. Now the address is /websites/<slug>, so the slug is the name,
 * slugified: gladia. When two names would clash, the second takes -2. Live
 * websites (with published screens) are named first, so they get the clean
 * one; then the rest, oldest first.
 *
 * All in one transaction, in two passes (every row to a temporary slug, then
 * to its new one) so the unique index never sees a half-renamed set.
 * Uses whatever `.env` points at. Run `npm run build:packages` first.
 */
import { createDatabase } from "@uxd/database";
import { dedupeSlug, slugify } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
loadEnvFile();
const env = loadCmsEnv();
const handle = createDatabase({ url: env.DATABASE_URL, poolMax: 1, ssl: env.DATABASE_SSL, applicationName: "uxd-clean-slugs" });

const { rows } = await handle.db.execute(sql`
  select s.id, s.name, s.slug, s.site, s.deleted_at is not null as deleted,
    exists (select 1 from content_items ci where ci.source_id = s.id and ci.status = 'published') as live
  from sources s
  order by deleted, live desc, s.created_at`);

const taken = new Set();
const plan = rows.map((row) => {
  const base = slugify(row.name ?? "") || slugify(row.site ?? "") || "website";
  const next = dedupeSlug(base, taken);
  taken.add(next);
  return { ...row, next };
});
const changes = plan.filter((row) => row.next !== row.slug);

for (const row of plan.filter((r) => r.live)) console.log(`  live  /websites/${row.next.padEnd(22)} was ${row.slug}`);
const clashes = plan.filter((row) => /-\d+$/.test(row.next) && !/-\d+$/.test(slugify(row.name ?? "")));
if (clashes.length) console.log("\n  clashes (took a number):", clashes.map((r) => `${r.name} -> ${r.next}`).join(", "));
console.log(`\n${rows.length} websites, ${changes.length} to rename`);

if (APPLY && changes.length) {
  await handle.db.transaction(async (tx) => {
    for (const row of changes) await tx.execute(sql`update sources set slug = ${`tmp-${row.id}`} where id = ${row.id}`);
    for (const row of changes) await tx.execute(sql`update sources set slug = ${row.next}, updated_at = now() where id = ${row.id}`);
  });
  console.log("RENAMED");
} else if (!APPLY) {
  console.log("Dry run: nothing changed. Re-run with --apply.");
}
await handle.close();
