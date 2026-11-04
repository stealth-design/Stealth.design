/**
 * Render check for the authenticated CMS routes.
 *
 * Signs in through the real `signIn` to get a session cookie, then fetches each
 * new page and asserts it renders. A typecheck cannot catch a runtime error
 * inside a server component, and these are the screens this whole change is
 * about.
 */
import { eq } from "drizzle-orm";
import { createDatabase, captureSessions, contentItems, discoveredPages } from "@uxd/database";
import { SESSION_COOKIE_NAME, signIn } from "@uxd/auth";
import { createLogger, hours } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

loadEnvFile();
const env = loadCmsEnv();
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-render-check" });
const db = handle.db;
const logger = createLogger({ service: "render-check", level: "error", format: "pretty" });

// `signIn` throws on failure rather than returning a flag — the failure is
// deliberately uniform so the form cannot be used to enumerate accounts.
const result = await signIn(
  db,
  { ttlMs: hours(env.SESSION_TTL_HOURS), cookieSecure: false, logger },
  {
    email: process.env.SEED_ADMIN_EMAIL ?? "admin@localhost",
    password: process.env.SEED_ADMIN_PASSWORD ?? "change-me-in-development",
    ip: "127.0.0.1",
    userAgent: "render-check",
  },
);

const cookie = `${SESSION_COOKIE_NAME}=${result.token}`;
const base = env.CMS_BASE_URL.replace(/\/$/, "");

const [candidate] = await db.select({ id: discoveredPages.id }).from(discoveredPages).limit(1);
const [screen] = await db
  .select({ id: contentItems.id })
  .from(contentItems)
  .where(eq(contentItems.kind, "screen"))
  .limit(1);
const [flow] = await db
  .select({ id: contentItems.id })
  .from(contentItems)
  .where(eq(contentItems.kind, "flow"))
  .limit(1);
const [session] = await db.select({ id: captureSessions.id }).from(captureSessions).limit(1);

const routes = [
  "/discovered",
  "/discovered?status=captured,ignored",
  candidate ? `/discovered/${candidate.id}` : null,
  "/screens",
  screen ? `/screens/${screen.id}` : null,
  "/flows",
  flow ? `/flows/${flow.id}` : null,
  session ? `/studio/${session.id}` : null,
  "/sources",
  "/ingestion",
  "/crawl-jobs",
  "/reviews",
  "/account",
  "/",
].filter(Boolean);

let failed = 0;
for (const route of routes) {
  const response = await fetch(`${base}${route}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const body = response.ok ? await response.text() : "";
  const broken = body.includes("Application error") || body.includes("__next_error__");
  const ok = response.status === 200 && !broken;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${route.padEnd(42)} ${response.status}${broken ? " (error boundary)" : ""}`);
}

console.log(`\n${routes.length - failed}/${routes.length} routes rendered`);
await handle.close();
process.exit(failed === 0 ? 0 : 1);
