/**
 * One website, one product: merge duplicate products and fill in site keys.
 *
 * Duplicates came from products being matched by exact host, so a page on
 * app.notion.com started a second Notion beside www.notion.com. This folds
 * each website's products into one (see `consolidateProducts`), moving every
 * screen, capture, flow and tag onto the one kept. Nothing captured is lost.
 *
 *   node scripts/consolidate-products.mjs --dry-run   show what would happen
 *   node scripts/consolidate-products.mjs             do it
 */
import { eq } from "drizzle-orm";
import { createDatabase, users } from "@uxd/database";
import { consolidateProducts } from "@uxd/api";
import { createStorage } from "@uxd/media";
import { createHeuristicProvider } from "@uxd/classification";
import { createLogger } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

const dryRun = process.argv.includes("--dry-run");

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ service: "consolidate", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-consolidate-products" });
const db = handle.db;

const [actor] = await db
  .select({ id: users.id, email: users.email, name: users.name, role: users.role })
  .from(users)
  .where(eq(users.role, "admin"))
  .limit(1);
if (!actor) throw new Error("No admin user to attribute the merge to.");

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
  requestId: "consolidate-products",
  ip: null,
  userAgent: "consolidate-products",
  actor,
};

try {
  const result = await consolidateProducts(context, { dryRun });
  console.log(dryRun ? "Dry run — nothing changed.\n" : "Done.\n");
  if (result.merged.length === 0) console.log("No duplicate products.");
  for (const group of result.merged) {
    console.log(`${group.site}: keeping ${group.kept}; ${dryRun ? "would absorb" : "absorbed"} ${group.absorbed.join(", ")}`);
  }
  console.log(`\nSite keys ${dryRun ? "to fill in" : "filled in"}: ${result.backfilled}`);
} finally {
  await handle.close();
}
