/**
 * Drop and recreate the schema, then re-apply migrations.
 *
 * Development only. Refuses to run against NODE_ENV=production, and refuses
 * any DATABASE_URL that is not local unless UXD_ALLOW_REMOTE_RESET=yes is set —
 * because "reset the database" pointed at the wrong URL is the single most
 * expensive mistake this repo makes possible.
 */
import { sql } from "drizzle-orm";
import { createLogger } from "@uxd/shared";
import { loadEnvFile } from "@uxd/shared/env";
import { createDatabase } from "../client.js";

loadEnvFile();

const logger = createLogger({ service: "db-reset", level: "info", format: "pretty" });
const url = process.env.DATABASE_URL;

if (!url) {
  logger.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  logger.error("Refusing to reset the database with NODE_ENV=production.");
  process.exit(1);
}

const isLocal = /(@|\/\/)(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)[:/]/.test(url);
if (!isLocal && process.env.UXD_ALLOW_REMOTE_RESET !== "yes") {
  logger.error(
    "DATABASE_URL does not look local. Refusing to reset. " +
      "Set UXD_ALLOW_REMOTE_RESET=yes only if you are certain.",
    { host: new URL(url).host },
  );
  process.exit(1);
}

const handle = createDatabase({ url, poolMax: 1, applicationName: "uxd-reset" });

try {
  logger.warn("Dropping schema public", { host: new URL(url).host });
  await handle.db.execute(sql`drop schema public cascade`);
  await handle.db.execute(sql`create schema public`);
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  logger.info("Schema dropped. Run `npm run db:migrate` and `npm run db:seed`.");
} catch (error) {
  logger.error("Reset failed", { error });
  process.exitCode = 1;
} finally {
  await handle.close();
}
