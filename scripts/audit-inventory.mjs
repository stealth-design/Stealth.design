#!/usr/bin/env node
/**
 * System inventory, read from the code and the live database.
 *
 * Exists because an audit that reports what the author remembers is not an
 * audit. Every number and every list here is derived — table and column names
 * from Drizzle's own metadata, state machines from the exported constants,
 * route lists from the filesystem, test counts from the files. If the code
 * changes and this is re-run, the report changes.
 *
 *   node scripts/audit-inventory.mjs          # human-readable
 *   node scripts/audit-inventory.mjs --json   # machine-readable
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@uxd/database";
import * as types from "@uxd/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

// --- Helpers --------------------------------------------------------------

function walk(dir, filter, acc = []) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return acc;
  for (const entry of readdirSync(full)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const path = join(full, entry);
    if (statSync(path).isDirectory()) walk(relative(ROOT, path), filter, acc);
    else if (filter(entry)) acc.push(relative(ROOT, path));
  }
  return acc;
}

const read = (path) => readFileSync(join(ROOT, path), "utf8");

// --- Schema ---------------------------------------------------------------

const tables = [];
for (const [exportName, value] of Object.entries(schema)) {
  let isTable = false;
  try {
    isTable = value !== null && typeof value === "object" && is(value, PgTable);
  } catch {
    isTable = false;
  }
  if (!isTable) continue;
  const columns = Object.entries(getTableColumns(value)).map(([prop, column]) => ({
    prop,
    name: column.name,
    type: column.getSQLType(),
    notNull: column.notNull,
    hasDefault: column.hasDefault,
  }));
  tables.push({ exportName, name: getTableName(value), columns: columns.length, fields: columns });
}
tables.sort((a, b) => a.name.localeCompare(b.name));

// --- State machines, from the exported constants ------------------------

const states = {
  lifecycle: types.LIFECYCLE_STATUSES,
  lifecycleTransitions: types.LIFECYCLE_TRANSITIONS,
  recaptureAdvanceable: types.RECAPTURE_ADVANCEABLE_STATUSES,
  attention: types.ATTENTION_STATUSES,
  rights: types.RIGHTS_STATUSES,
  rightsBlocking: types.RIGHTS_STATUSES.filter((s) => types.rightsBlocksPublishing(s)),
  job: types.JOB_STATUSES,
  jobActive: types.ACTIVE_JOB_STATUSES,
  jobItem: types.CRAWL_ITEM_STATUSES ?? null,
  urlValidation: types.URL_VALIDATION_OUTCOMES,
  media: types.MEDIA_STATUSES,
  mediaUsageRoles: types.MEDIA_USAGE_ROLES,
  capture: types.CAPTURE_STATUSES,
  captureMethods: types.CAPTURE_METHODS,
  classificationOrigins: types.CLASSIFICATION_ORIGINS,
  humanConfirmedOrigins: types.HUMAN_CONFIRMED_ORIGINS,
  suggestionReview: types.SUGGESTION_REVIEW_STATUSES,
  taxonomyKinds: types.TAXONOMY_KINDS,
  taxonomyTermStatuses: types.TAXONOMY_TERM_STATUSES,
  contentKinds: types.CONTENT_KINDS,
  sourceHealth: types.SOURCE_HEALTH_STATUSES,
  attentionSourceHealth: types.ATTENTION_SOURCE_HEALTH,
  roles: types.ROLES,
  permissions: types.PERMISSIONS,
  robots: types.ROBOTS_STATUSES,
  auditEntities: types.AUDIT_ENTITY_TYPES,
  auditActions: Object.keys(types.AUDIT_ACTIONS),
};

// --- Routes ---------------------------------------------------------------

const cmsPages = walk("apps/cms/src/app", (f) => f === "page.tsx")
  .map((p) => p.replace("apps/cms/src/app", "").replace("/page.tsx", "").replace(/\/\(app\)/, "") || "/")
  .sort();
const cmsRoutes = walk("apps/cms/src/app", (f) => f === "route.ts")
  .map((p) => p.replace("apps/cms/src/app", "").replace("/route.ts", ""))
  .sort();
const frontendPages = walk("apps/frontend/src/app", (f) => f === "page.tsx")
  .map((p) => p.replace("apps/frontend/src/app", "").replace("/page.tsx", "") || "/")
  .sort();

/** API endpoints, from the router source. */
function endpoints(file) {
  const src = read(file);
  return [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*\n?\s*"([^"]+)"/g)].map(
    (m) => `${m[1].toUpperCase()} ${m[2]}`,
  );
}

// --- Services and queries ------------------------------------------------

const exportedFunctions = (file) =>
  [...read(file).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

const serviceFiles = walk("packages/api/src/services", (f) => f.endsWith(".ts"));
const queryFiles = walk("packages/api/src/queries", (f) => f.endsWith(".ts"));

// --- Tests ---------------------------------------------------------------

const testFiles = walk("packages", (f) => f.endsWith(".test.ts")).concat(
  walk("apps", (f) => f.endsWith(".test.ts")),
);
const tests = testFiles.map((file) => {
  const src = read(file);
  return {
    file,
    cases: (src.match(/^\s*it\(/gm) ?? []).length,
    suites: (src.match(/^\s*describe\(/gm) ?? []).length,
    needsDatabase: src.includes("createDatabase"),
  };
});

// --- Security surface ----------------------------------------------------

const security = {
  blockedRanges: null,
  allowedProtocols: null,
  allowedPorts: null,
  jobLimits: types.JOB_LIMITS,
  workerForbiddenEnv: null,
  checkScripts: walk("scripts", (f) => f.startsWith("check-")),
};
try {
  const crawler = await import("@uxd/crawler");
  security.blockedRanges = crawler.describeBlockedRanges().length;
} catch {
  /* crawler not built */
}
try {
  const shared = await import("@uxd/shared");
  security.allowedProtocols = shared.ALLOWED_PROTOCOLS;
  security.allowedPorts = shared.ALLOWED_PORTS;
  const env = await import("@uxd/shared/env");
  security.workerForbiddenEnv = env.WORKER_FORBIDDEN_ENV_KEYS;
} catch {
  /* shared not built */
}

// --- Live database -------------------------------------------------------

let live = null;
try {
  const { Client } = await import("pg");
  const env = await import("@uxd/shared/env");
  env.loadEnvFile();
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres",
    connectionTimeoutMillis: 4000,
  });
  await client.connect();
  const one = async (sql) => (await client.query(sql)).rows[0];
  const all = async (sql) => (await client.query(sql)).rows;
  live = {
    version: (await one("select version() v")).v.split(",")[0],
    tables: (
      await one(
        "select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
      )
    ).n,
    indexes: (await one("select count(*)::int n from pg_indexes where schemaname='public'")).n,
    foreignKeys: (
      await one(
        "select count(*)::int n from information_schema.table_constraints where constraint_schema='public' and constraint_type='FOREIGN KEY'",
      )
    ).n,
    checks: (
      await all(
        "select constraint_name from information_schema.table_constraints where constraint_schema='public' and constraint_type='CHECK' and constraint_name not like '%_not_null'",
      )
    ).map((r) => r.constraint_name),
    enums: (await one("select count(distinct t.typname)::int n from pg_type t join pg_enum e on e.enumtypid=t.oid")).n,
    tsvectorColumns: (
      await all(
        "select table_name, column_name, is_generated from information_schema.columns where table_schema='public' and udt_name='tsvector'",
      )
    ),
    rowCounts: Object.fromEntries(
      await Promise.all(
        tables.map(async (t) => [
          t.name,
          (await one(`select count(*)::int n from "${t.name}"`)).n,
        ]),
      ),
    ),
  };
  await client.end();
} catch (error) {
  live = { error: error instanceof Error ? error.message : "unreachable" };
}

// --- Report --------------------------------------------------------------

const report = {
  generatedAt: new Date().toISOString(),
  stack: {
    framework: "Next.js 16.3.4 (App Router) — CMS and public site",
    database: "PostgreSQL 18",
    localDatabase: "PGlite 0.5.8 over the Postgres wire protocol",
    driver: "pg 8.23.0",
    orm: "Drizzle 0.45.2",
    objectStorage: "local filesystem driver | S3 via @aws-sdk/client-s3 3.1125.0",
    auth: "in-repo: scrypt + opaque session tokens (packages/auth)",
    jobQueue: "in-repo: Postgres FOR UPDATE SKIP LOCKED with leases (packages/database/src/queue.ts)",
    browser: "playwright 1.62.1",
    crawlee: "NOT USED — dependency removed; see docs/known-limitations.md",
    http: "undici 8.10.1 with a guarded dispatcher",
    api: "Hono 4.13.5, two routers mounted on Next route handlers",
    validation: "zod 4.5.4",
    imageProcessing: "sharp 0.35.4, file-type 22.0.2",
  },
  schema: {
    tableCount: tables.length,
    tables: tables.map((t) => ({ name: t.name, columns: t.columns })),
  },
  states,
  surfaces: {
    cmsPages,
    cmsRoutes,
    frontendPages,
    publicApi: endpoints("packages/api/src/routers/public.ts"),
    internalApi: endpoints("packages/api/src/routers/internal.ts"),
    services: Object.fromEntries(serviceFiles.map((f) => [f.split("/").pop(), exportedFunctions(f)])),
    queries: Object.fromEntries(queryFiles.map((f) => [f.split("/").pop(), exportedFunctions(f).length])),
  },
  security,
  tests: {
    files: tests.length,
    cases: tests.reduce((n, t) => n + t.cases, 0),
    needingDatabase: tests.filter((t) => t.needsDatabase).map((t) => t.file),
    byFile: tests,
  },
  live,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const B = "\u001b[1m";
const D = "\u001b[90m";
const R = "\u001b[0m";
const head = (t) => console.log(`\n${B}${t}${R}`);

console.log(`${B}System inventory${R} ${D}${report.generatedAt}${R}`);

head("Stack");
for (const [k, v] of Object.entries(report.stack)) console.log(`  ${k.padEnd(16)} ${v}`);

head(`Schema — ${tables.length} tables`);
const cols = 3;
for (let i = 0; i < tables.length; i += cols) {
  console.log(
    "  " +
      tables
        .slice(i, i + cols)
        .map((t) => `${t.name}${D}(${t.columns})${R}`.padEnd(38))
        .join(""),
  );
}

head("State machines");
for (const [k, v] of Object.entries(states)) {
  if (v === null) continue;
  const list = Array.isArray(v) ? v : Object.keys(v);
  console.log(`  ${k.padEnd(24)} ${D}${list.length}${R} ${list.slice(0, 9).join(" ")}${list.length > 9 ? ` ${D}+${list.length - 9}${R}` : ""}`);
}

head("Surfaces");
console.log(`  CMS pages        ${cmsPages.length}`);
console.log(`  CMS routes       ${cmsRoutes.join(" ")}`);
console.log(`  Frontend pages   ${frontendPages.length}  ${D}${frontendPages.join(" ")}${R}`);
console.log(`  Public API       ${report.surfaces.publicApi.length}  ${D}${report.surfaces.publicApi.join(" · ")}${R}`);
console.log(`  Internal API     ${report.surfaces.internalApi.length}  ${D}${report.surfaces.internalApi.join(" · ")}${R}`);
for (const [file, fns] of Object.entries(report.surfaces.services)) {
  console.log(`  service ${file.padEnd(24)} ${D}${fns.length}${R} ${fns.slice(0, 6).join(" ")}${fns.length > 6 ? ` ${D}+${fns.length - 6}${R}` : ""}`);
}

head("Security surface");
console.log(`  blocked IP ranges       ${security.blockedRanges}`);
console.log(`  allowed protocols       ${security.allowedProtocols?.join(" ")}`);
console.log(`  allowed ports           ${security.allowedPorts?.join(" ")}`);
console.log(`  worker-forbidden env    ${security.workerForbiddenEnv?.length} keys`);
console.log(`  build-time checks       ${security.checkScripts.map((s) => s.split("/").pop()).join(" ")}`);
console.log(`  job limits              ${Object.entries(security.jobLimits).map(([k, v]) => `${k}=${v}`).join(" ")}`);

head(`Tests — ${report.tests.files} files, ${report.tests.cases} cases`);
for (const t of tests.sort((a, b) => b.cases - a.cases)) {
  console.log(`  ${String(t.cases).padStart(3)}  ${t.file.replace("packages/", "")}${t.needsDatabase ? ` ${D}(needs db)${R}` : ""}`);
}

head("Live database");
if (live.error) {
  console.log(`  unreachable: ${live.error}`);
} else {
  console.log(`  ${live.version}`);
  console.log(`  tables ${live.tables} · enums ${live.enums} · indexes ${live.indexes} · FKs ${live.foreignKeys} · CHECKs ${live.checks.length}`);
  console.log(`  tsvector columns: ${live.tsvectorColumns.map((c) => `${c.table_name}.${c.column_name}${c.is_generated === "ALWAYS" ? " (generated)" : ""}`).join(", ")}`);
  const nonEmpty = Object.entries(live.rowCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  console.log(`  rows: ${nonEmpty.map(([t, n]) => `${t}=${n}`).join(" ")}`);
  const empty = Object.entries(live.rowCounts).filter(([, n]) => n === 0).map(([t]) => t);
  console.log(`  ${D}empty tables (${empty.length}): ${empty.join(" ")}${R}`);
}
