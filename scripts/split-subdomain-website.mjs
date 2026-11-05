/**
 * One-off: make a subdomain its own website and move its screens to it.
 *
 *   node scripts/split-subdomain-website.mjs weave.figma.com            dry run
 *   node scripts/split-subdomain-website.mjs weave.figma.com --apply    do it
 *
 * Creates the website the same way the CMS's "Add website" now does for a
 * subdomain (weave.figma.com becomes "Figma Weave"), then moves every screen
 * captured on that subdomain from the parent website to it, with its
 * captures, media, tags and registry rows. Then looks up its square icon.
 * One transaction for the move. Uses whatever `.env` points at; run
 * `npm run build:packages` first.
 */
import { createDatabase } from "@uxd/database";
import { createStorage } from "@uxd/media";
import { createLogger, uuidv7, validateUrl } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";
import { prefillWebsiteLogo, resolveSourceForUrl } from "@uxd/api";
import { sql } from "drizzle-orm";

const host = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!host || host.startsWith("--")) throw new Error("Usage: split-subdomain-website.mjs <subdomain host> [--apply]");

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ service: "split-subdomain", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, poolMax: 2, ssl: env.DATABASE_SSL, applicationName: "uxd-split-subdomain" });
const db = handle.db;

const parsed = validateUrl(`https://${host}/`, { assumeHttps: true });
if (!parsed.ok) throw new Error(parsed.error.message);

// The screens to move: on this host, under some other website.
const { rows: screens } = await db.execute(sql`
  select ci.id, ci.title, ci.status, ci.source_id, s.name as parent
  from content_items ci join sources s on s.id = ci.source_id
  where ci.deleted_at is null
    and (ci.source_url ilike ${`https://${host}/%`} or ci.source_url ilike ${`http://${host}/%`}
         or ci.source_url = ${`https://${host}`})
    and coalesce(s.site, '') <> ${host}`);
console.log(`Screens on ${host} filed elsewhere: ${screens.length}`);
for (const s of screens) console.log(`  ${s.title} (${s.status}) under ${s.parent}`);
if (!screens.length) {
  await handle.close();
  process.exit(0);
}

if (!APPLY) {
  console.log("Dry run: nothing changed. Re-run with --apply.");
  await handle.close();
  process.exit(0);
}

const ids = screens.map((s) => s.id);
const parentId = screens[0].source_id;
let websiteId;
await db.transaction(async (tx) => {
  const resolved = await resolveSourceForUrl(tx, parsed.value, { ownSubdomain: true });
  websiteId = resolved.sourceId;
  // Listed like its parent was.
  await tx.execute(sql`
    update sources n set status = p.status, health = p.health, updated_at = now()
    from sources p where n.id = ${websiteId} and p.id = ${parentId}`);
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  await tx.execute(sql`update content_items set source_id = ${websiteId} where id in (${idList})`);
  await tx.execute(sql`update captures set source_id = ${websiteId} where content_item_id in (${idList})`);
  await tx.execute(sql`update media_assets set source_id = ${websiteId}
    where id in (select media_id from media_usages where content_item_id in (${idList}))`);
  await tx.execute(sql`update taxonomy_assignments set source_id = ${websiteId}
    where content_item_id in (${idList}) and source_id is not null`);
  await tx.execute(sql`update url_registry set source_id = ${websiteId} where content_item_id in (${idList})`);
  await tx.execute(sql`update classification_suggestions set source_id = ${websiteId}
    where content_item_id in (${idList}) and source_id is not null`);
});

const [website] = (await db.execute(sql`select name, slug, site, domain, status from sources where id = ${websiteId}`)).rows;
console.log(`MOVED ${ids.length} screen(s) to ${website.name} (/websites/${website.slug}, ${website.site}, ${website.status})`);

const storage = createStorage({
  driver: env.STORAGE_DRIVER,
  localRoot: env.STORAGE_LOCAL_ROOT,
  localPublicBaseUrl: `${env.CMS_BASE_URL.replace(/\/$/, "")}/media`,
  blob: env.STORAGE_DRIVER === "blob" && env.BLOB_READ_WRITE_TOKEN
    ? { token: env.BLOB_READ_WRITE_TOKEN, access: env.STORAGE_BLOB_ACCESS }
    : undefined,
  logger,
});
const context = { db, storage, classifier: null, logger, env, requestId: uuidv7(), ip: null, userAgent: "split-subdomain" };
const logo = await prefillWebsiteLogo(context, websiteId).catch((error) => {
  console.log("Logo lookup failed:", String(error?.message ?? error));
  return false;
});
console.log(logo ? "Found its icon." : "No square icon found; it shows its first letter.");
await handle.close();
