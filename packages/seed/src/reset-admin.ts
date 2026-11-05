/**
 * Development recovery: make sure the admin can sign in.
 *
 * The seed only uses SEED_ADMIN_PASSWORD when it first creates the admin; an
 * existing account is left alone. This script sets the password on the
 * account at SEED_ADMIN_EMAIL (creating it if missing), reactivates it, and
 * clears any lockout and open sessions.
 *
 * Password: SEED_ADMIN_PASSWORD if it passes the strength check, otherwise a
 * freshly generated one, printed once to the terminal.
 *
 * Refuses to run with NODE_ENV=production, like the seed.
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { hashPassword, validatePasswordStrength } from "@uxd/auth";
import { createLogger, uuidv7 } from "@uxd/shared";
import { loadEnvFile } from "@uxd/shared/env";
import { createDatabase, sessions, users } from "@uxd/database";

loadEnvFile();

const logger = createLogger({ service: "reset-admin", level: "info", format: "pretty" });

if (process.env.NODE_ENV === "production") {
  logger.error("Refusing to run with NODE_ENV=production. This is a development recovery tool.");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  logger.error("DATABASE_URL is not set. Start the dev database with `npm run db:serve`.");
  process.exit(1);
}

async function main(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@localhost").toLowerCase();

  let password = process.env.SEED_ADMIN_PASSWORD ?? "";
  let generated = false;
  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    if (password) {
      logger.warn("SEED_ADMIN_PASSWORD is not usable; generating one instead.", {
        reason: strength.message,
      });
    }
    password = randomBytes(18).toString("base64url");
    generated = true;
  }

  const handle = createDatabase({ url: url!, poolMax: 1, applicationName: "uxd-reset-admin" });
  try {
    const passwordHash = await hashPassword(password);
    const now = new Date();

    const existing = await handle.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      await handle.db
        .update(users)
        .set({
          passwordHash,
          passwordChangedAt: now,
          role: "admin",
          status: "active",
          failedLoginCount: 0,
          lockedUntil: null,
          deletedAt: null,
          updatedAt: now,
        })
        .where(sql`${users.id} = ${userId}`);
      await handle.db.delete(sessions).where(sql`${sessions.userId} = ${userId}`);
      logger.info("Admin password reset", { email });
    } else {
      userId = uuidv7();
      await handle.db.insert(users).values({
        id: userId,
        email,
        name: process.env.SEED_ADMIN_NAME ?? "Local Admin",
        role: "admin",
        status: "active",
        passwordHash,
        passwordChangedAt: now,
      });
      logger.info("Admin user created", { email });
    }

    // Printed directly rather than through the logger, which redacts anything
    // that looks like a credential.
    process.stdout.write(
      `\n  Sign in as: ${email}\n` +
        (generated
          ? `  Password:   ${password}\n  (generated; change it after signing in)\n\n`
          : `  Password:   the value of SEED_ADMIN_PASSWORD\n\n`),
    );
  } catch (error) {
    logger.error("Reset failed", { error });
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

await main();
