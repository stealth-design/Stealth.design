/**
 * One-off: give every website its square icon as its logo.
 *
 *   node scripts/refresh-logos.mjs
 *
 * For each website whose logo was not chosen by a person (origin null, icon
 * or header), read its home page for the icons it publishes and use the best
 * square one. A header wordmark with no icon to replace it is cleared, so
 * the site shows its initial instead of its name written out. Logos uploaded
 * by hand (origin manual) are never touched.
 *
 * Uses the same code as the CMS's "Find logo", against whatever `.env`
 * points at. Run `npm run build:packages` first.
 */
import { createDatabase } from "@uxd/database";
import { createStorage } from "@uxd/media";
import { createLogger, uuidv7 } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";
import { findWebsiteIcon } from "@uxd/api";
import { sql } from "drizzle-orm";

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ service: "refresh-logos", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, poolMax: 4, ssl: env.DATABASE_SSL, applicationName: "uxd-refresh-logos" });
const storage = createStorage({
  driver: env.STORAGE_DRIVER,
  localRoot: env.STORAGE_LOCAL_ROOT,
  localPublicBaseUrl: `${env.CMS_BASE_URL.replace(/\/$/, "")}/media`,
  s3:
    env.STORAGE_DRIVER === "s3"
      ? {
          bucket: env.STORAGE_S3_BUCKET,
          region: env.STORAGE_S3_REGION,
          endpoint: env.STORAGE_S3_ENDPOINT,
          accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
          secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
          forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
          publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
        }
      : undefined,
  blob:
    env.STORAGE_DRIVER === "blob" && env.BLOB_READ_WRITE_TOKEN
      ? { token: env.BLOB_READ_WRITE_TOKEN, access: env.STORAGE_BLOB_ACCESS }
      : undefined,
  logger,
});
const context = { db: handle.db, storage, classifier: null, logger, env, requestId: uuidv7(), ip: null, userAgent: "refresh-logos" };

const { rows } = await handle.db.execute(sql`
  select s.id, s.name, s.logo_origin as origin,
    exists (select 1 from content_items ci where ci.source_id = s.id and ci.status = 'published') as live
  from sources s
  where s.deleted_at is null and (s.logo_origin is null or s.logo_origin in ('icon', 'header'))
  order by live desc, s.name`);

const tally = { icon: 0, cleared: 0, unchanged: 0, failed: 0 };
const queue = [...rows];
async function work() {
  for (let row = queue.shift(); row; row = queue.shift()) {
    let outcome;
    try {
      const found = await findWebsiteIcon(context, row.id);
      if (found) {
        await handle.db.execute(sql`update sources set logo_media_id = ${found.mediaId}, logo_origin = 'icon', updated_at = now() where id = ${row.id} and coalesce(logo_origin, '') <> 'manual'`);
        outcome = "icon";
      } else if (row.origin === "header") {
        await handle.db.execute(sql`update sources set logo_media_id = null, logo_origin = null, updated_at = now() where id = ${row.id} and logo_origin = 'header'`);
        outcome = "cleared";
      } else {
        outcome = "unchanged";
      }
    } catch (error) {
      outcome = "failed";
      logger.warn("Could not refresh", { name: row.name, error: String(error?.message ?? error) });
    }
    tally[outcome] += 1;
    if (row.live) console.log(`  live  ${row.name.padEnd(20)} ${row.origin ?? "none"} -> ${outcome}`);
  }
}
await Promise.all(Array.from({ length: 6 }, work));
console.log(`\n${rows.length} websites: ${tally.icon} got an icon, ${tally.cleared} wordmarks cleared, ${tally.unchanged} still without, ${tally.failed} failed`);
await handle.close();
