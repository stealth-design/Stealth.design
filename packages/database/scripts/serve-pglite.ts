/**
 * Local development database.
 *
 * Serves an embedded PGlite (real Postgres compiled to WASM) over the Postgres
 * wire protocol on TCP, so every app in the monorepo connects with an ordinary
 * `postgres://` DATABASE_URL and the exact same `pg` driver it uses in
 * production. There is no SQL dialect drift between dev and prod, and no
 * Docker/Postgres install required to run this repo.
 *
 * In production this script is not used: point DATABASE_URL at a real
 * Postgres server (Neon, RDS, Supabase, self-hosted) and nothing else changes.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dataDir = resolve(process.env.PGLITE_DATA_DIR ?? ".data/pglite");
const port = Number(process.env.PGLITE_PORT ?? 5432);
const host = process.env.PGLITE_HOST ?? "127.0.0.1";

mkdirSync(dataDir, { recursive: true });

const db = await PGlite.create({ dataDir });
const server = new PGLiteSocketServer({
  db,
  port,
  host,
  // The CMS, migration runner and test suite each hold a pool; queries are
  // serialised internally by PGlite's query queue.
  maxConnections: 20,
});

await server.start();
process.stdout.write(
  `[db] PGlite listening on postgres://postgres@${host}:${port}/postgres  (dataDir: ${dataDir})\n`,
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[db] ${signal} received, stopping\n`);
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
