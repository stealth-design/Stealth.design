/**
 * Migration runner.
 *
 * Applies every pending migration in `migrations/` inside a transaction, using
 * Drizzle's journal to track what has run. Safe to run repeatedly and safe to
 * run concurrently — the advisory lock means two deploys starting at once do
 * not both try to apply the same migration.
 */
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@uxd/shared";
import { loadEnvFile } from "@uxd/shared/env";
import { createDatabase } from "../client.js";

loadEnvFile();

const logger = createLogger({
  service: "migrate",
  level: "info",
  format: process.env.UXD_LOG_FORMAT === "json" ? "json" : "pretty",
});

const url = process.env.DATABASE_URL;
if (!url) {
  logger.error("DATABASE_URL is not set. Start the dev database with `npm run db:serve`.");
  process.exit(1);
}

const migrationsFolder = resolve(import.meta.dirname, "../../migrations");
const handle = createDatabase({ url, poolMax: 1, applicationName: "uxd-migrate" });

// A fixed advisory lock id, so concurrent deploys serialise rather than race.
const LOCK_ID = 918_273_645;

try {
  await handle.db.execute(sql`select pg_advisory_lock(${LOCK_ID})`);
  logger.info("Applying migrations", { migrationsFolder });
  await migrate(handle.db, { migrationsFolder });
  logger.info("Migrations up to date");
} catch (error) {
  logger.error("Migration failed", { error });
  process.exitCode = 1;
} finally {
  try {
    await handle.db.execute(sql`select pg_advisory_unlock(${LOCK_ID})`);
  } catch {
    // The lock is released with the connection anyway.
  }
  await handle.close();
}
