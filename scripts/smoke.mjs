#!/usr/bin/env node
/**
 * HTTP smoke test.
 *
 * Signs in with a real session and asks every CMS screen and API surface for a
 * response, asserting the status code and that a few load-bearing strings are
 * present. It is not a substitute for the unit tests — it is the check that the
 * wiring is intact: routes mounted, session resolved, queries executable,
 * templates rendering, media served.
 *
 * Run it against a live dev server:
 *
 *   npm run db:serve            # terminal 1
 *   npm run dev:cms             # terminal 2
 *   node scripts/smoke.mjs      # terminal 3
 *
 * It mints its own session directly in the database rather than driving the
 * sign-in form, because the point is to exercise the screens, not the login
 * flow (which `packages/auth` tests cover).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// --- Environment ----------------------------------------------------------

function loadEnv() {
  let directory = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

// --- Reporting ------------------------------------------------------------

const results = [];
let failures = 0;

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? "\u001b[32mok\u001b[0m  " : "\u001b[31mFAIL\u001b[0m";
  process.stdout.write(`  ${mark} ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ""}\n`);
}

function section(title) {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

// --- Session --------------------------------------------------------------

async function mintSession() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select id, email from users where role = 'admin' and deleted_at is null order by created_at limit 1",
    );
    if (rows.length === 0) {
      throw new Error("No admin user. Run `npm run db:seed` first.");
    }
    const token = randomBytes(32).toString("base64url");
    const id = createHash("sha256").update(token).digest("hex");
    await client.query(
      `insert into sessions (id, user_id, expires_at, last_used_at)
       values ($1, $2, now() + interval '1 hour', now())`,
      [id, rows[0].id],
    );
    return { token, sessionId: id, email: rows[0].email };
  } finally {
    await client.end();
  }
}

async function revokeSession(sessionId) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query("delete from sessions where id = $1", [sessionId]);
  await client.end();
}

// --- Checks ---------------------------------------------------------------

async function get(path, { token, expect = 200, contains = [], absent = [] } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: token ? { cookie: `uxd_session=${token}` } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    record(`GET ${path}`, false, `request failed: ${error.message}`);
    return null;
  }

  if (response.status !== expect) {
    record(`GET ${path}`, false, `expected ${expect}, got ${response.status}`);
    // Still read the body so a 500's message can be surfaced.
    const body = await response.text().catch(() => "");
    if (body.length > 0 && response.status >= 500) {
      const hint = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 200);
      process.stdout.write(`       \u001b[90m${hint}\u001b[0m\n`);
    }
    return null;
  }

  const body = expect === 200 ? await response.text() : "";

  const missing = contains.filter((needle) => !body.includes(needle));
  const leaked = absent.filter((needle) => body.includes(needle));

  if (missing.length > 0 || leaked.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (leaked.length > 0) parts.push(`LEAKED: ${leaked.join(", ")}`);
    record(`GET ${path}`, false, parts.join(" · "));
    return body;
  }

  record(`GET ${path}`, true, `${response.status} · ${(body.length / 1024).toFixed(0)}kb`);
  return body;
}

async function getJson(path, { expect = 200 } = {}) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== expect) {
      record(`GET ${path}`, false, `expected ${expect}, got ${response.status}`);
      return null;
    }
    const json = await response.json();
    record(`GET ${path}`, true, `${response.status}`);
    return json;
  } catch (error) {
    record(`GET ${path}`, false, error.message);
    return null;
  }
}

async function main() {
  process.stdout.write(`Smoke test against ${BASE_URL}\n`);

  let session;
  try {
    session = await mintSession();
  } catch (error) {
    process.stderr.write(`\nCould not mint a session: ${error.message}\n`);
    process.exit(1);
  }
  const { token } = session;

  // --- Unauthenticated behaviour -----------------------------------
  section("Authentication");
  await get("/login", { contains: ['name="email"', 'name="password"'] });
  await get("/", { expect: 307 });
  await get("/content", { expect: 307 });
  await get("/settings", { expect: 307 });

  // --- Screens ------------------------------------------------------
  section("CMS screens");
  await get("/", {
    token,
    contains: ["Dashboard", "Review queue", "Crawl jobs", "Needs attention"],
  });
  await get("/ingestion", {
    token,
    contains: ["Submit URLs", "Validate URLs", "Nothing is fetched yet"],
  });
  await get("/crawl-jobs", { token, contains: ["Crawl jobs"] });
  await get("/content", { token, contains: ["Content"] });
  await get("/media", { token, contains: ["Media", "Accepted formats"] });
  await get("/media?view=list", { token, contains: ["Media"] });
  await get("/reviews", { token, contains: ["Reviews"] });
  await get("/taxonomy", { token, contains: ["Taxonomy"] });
  await get("/taxonomy/suggestions", { token, contains: ["Classification suggestions"] });
  await get("/sources", { token, contains: ["Sources"] });
  await get("/published", { token, contains: ["Published"] });
  await get("/attention", { token, contains: ["attention"] });
  await get("/collections", { token, contains: ["Collections"] });
  await get("/flows", { token, contains: ["Flows"] });
  await get("/patterns", { token, contains: ["Patterns"] });
  await get("/settings", { token, contains: ["Settings"] });
  await get("/audit", { token, contains: ["Audit"] });

  // --- Detail pages, discovered from the lists ---------------------
  section("Detail pages");
  const jobList = await get("/crawl-jobs", { token });
  const jobHref = jobList?.match(/\/crawl-jobs\/[0-9a-f-]{36}/)?.[0];
  if (jobHref) {
    await get(jobHref, { token, contains: ["Configuration", "Provenance", "robots.txt"] });
    await get(`${jobHref}?tab=urls`, { token, contains: ["Everything that was submitted"] });
    await get(`${jobHref}?tab=log`, { token, contains: ["Job log"] });
  } else {
    record("crawl job detail", true, "skipped — no jobs yet");
  }

  const contentList = await get("/content", { token });
  const contentHref = contentList?.match(/\/content\/[0-9a-f-]{36}/)?.[0];
  if (contentHref) {
    await get(contentHref, {
      token,
      contains: ["Provenance", "Capture history", "Classification", "Rights", "Audit history"],
    });
  } else {
    record("content detail", true, "skipped — no content yet");
  }

  // Each of these lists links to its own detail route; follow the first link
  // rather than hardcoding an id, so the probe works on any database.
  for (const [list, label, expected] of [
    ["/sources", "source detail", ["Rights", "Capture policy", "What we hold"]],
    ["/patterns", "pattern detail", ["Attached to", "Vocabulary"]],
    ["/collections", "collection detail", ["Items, in curated order"]],
    ["/flows", "flow detail", ["Steps, in order"]],
  ]) {
    const body = await get(list, { token });
    const href = body?.match(new RegExp(`${list}/[0-9a-f-]{36}`))?.[0];
    if (href) {
      await get(href, { token, contains: expected });
    } else {
      record(label, true, "skipped — nothing to open yet");
    }
  }

  const mediaList = await get("/media", { token });
  const mediaHref = mediaList?.match(/\/media\/[0-9a-f-]{36}/)?.[0];
  if (mediaHref) {
    const body = await get(mediaHref, {
      token,
      contains: ["Provenance", "sha256", "Origin domain", "Capture method"],
    });
    // The stored file must actually serve, with the right type and a
    // Content-Disposition that does not let it execute in our origin.
    const src = body?.match(/src="(http:\/\/localhost:3000\/media\/[^"]+)"/)?.[1];
    if (src) {
      const response = await fetch(src, { headers: { cookie: `uxd_session=${token}` } });
      const ok =
        response.status === 200 &&
        (response.headers.get("content-type") ?? "").startsWith("image/") &&
        response.headers.get("x-content-type-options") === "nosniff";
      record(
        "stored media serves with safe headers",
        ok,
        `${response.status} · ${response.headers.get("content-type")} · csp=${response.headers.get("content-security-policy")?.slice(0, 24)}`,
      );

      // The same file must NOT be readable without a session.
      const anon = await fetch(src, { redirect: "manual" });
      record("media requires a session", anon.status === 401, `anonymous got ${anon.status}`);
    }
  } else {
    record("media detail", true, "skipped — no media yet");
  }

  // --- Public API (§19) --------------------------------------------
  section("Public API");
  const root = await getJson("/api/public");
  record(
    "public API describes itself",
    Boolean(root?.endpoints?.content),
    root ? `v${root.version}` : "no body",
  );
  await getJson("/api/public/health");

  const list = await getJson("/api/public/content");
  record(
    "public content list has an envelope",
    list !== null && Array.isArray(list.items) && typeof list.total === "number",
    list ? `${list.total} published` : "no body",
  );

  // The critical assertion: nothing internal in a public response.
  if (list) {
    const serialised = JSON.stringify(list);
    const forbidden = [
      "internalNotes",
      "reviewNotes",
      "rightsNotes",
      "storageKey",
      "crawlJobId",
      "captureId",
      "errorMessage",
      "createdBy",
      "approvedBy",
      "passwordHash",
      "leaseToken",
      "robotsStatus",
    ];
    const found = forbidden.filter((field) => serialised.includes(`"${field}"`));
    record("public API leaks no internal fields", found.length === 0, found.join(", ") || undefined);
  }

  await getJson("/api/public/sources");

  // --- Public media (the route that serves screenshots) -------------
  //
  // The public API advertises media URLs, so there has to be a route that
  // honours them — and it must apply the same publish gate, or the gate is
  // decorative. Checked here rather than only in the pipeline verification
  // because a broken media route makes the entire public site serve blank
  // tiles while every JSON response still looks correct.
  const withMedia = list?.items?.find((item) => item.primaryMedia?.thumbnailUrl);
  if (withMedia) {
    const thumb = withMedia.primaryMedia.thumbnailUrl;
    const response = await fetch(thumb);
    record(
      "published media serves publicly",
      response.status === 200 &&
        (response.headers.get("content-type") ?? "").startsWith("image/") &&
        response.headers.get("x-content-type-options") === "nosniff" &&
        response.headers.get("content-disposition") === "inline",
      `${response.status} · ${response.headers.get("content-type")}`,
    );

    // The same bytes must still be refused by the session-gated CMS route,
    // which is a different policy on the same storage.
    const key = thumb.split("/api/public/media/")[1];
    if (key) {
      const gated = await fetch(`${BASE_URL}/media/${key}`, { redirect: "manual" });
      record(
        "the CMS media route still requires a session",
        gated.status === 401,
        `anonymous got ${gated.status}`,
      );
    }

    // A key we never wrote must not be readable, or the route is a file
    // reader over the storage root.
    const forged = await fetch(`${BASE_URL}/api/public/media/media/2020/01/does-not-exist.png`);
    record("public media refuses an unknown key", forged.status === 404, `got ${forged.status}`);

    const traversal = await fetch(
      `${BASE_URL}/api/public/media/..%2F..%2F..%2F.env`,
      { redirect: "manual" },
    );
    record(
      "public media refuses a traversal attempt",
      traversal.status === 404 || traversal.status === 400,
      `got ${traversal.status}`,
    );
  } else {
    record("public media checks", true, "skipped — nothing published with an image");
  }
  await getJson("/api/public/facets");
  await getJson("/api/public/collections");
  await getJson("/api/public/content/does-not-exist", { expect: 404 });

  // --- Internal API (§25) ------------------------------------------
  section("Internal API");
  const leaseBody = JSON.stringify({ workerName: "smoke", limit: 1, leaseSeconds: 300 });
  const leaseHeaders = { "content-type": "application/json" };

  const noAuth = await fetch(`${BASE_URL}/api/internal/jobs/lease`, {
    method: "POST",
    headers: leaseHeaders,
    body: leaseBody,
  });
  record("internal API refuses an unauthenticated caller", noAuth.status === 401, `got ${noAuth.status}`);

  const badToken = await fetch(`${BASE_URL}/api/internal/jobs/lease`, {
    method: "POST",
    headers: { ...leaseHeaders, authorization: "Bearer not-a-real-token-but-long-enough-to-try" },
    body: leaseBody,
  });
  record("internal API refuses a wrong token", badToken.status === 401, `got ${badToken.status}`);

  const secret = process.env.WORKER_SHARED_SECRET;
  if (secret) {
    const authed = await fetch(`${BASE_URL}/api/internal/jobs/lease`, {
      method: "POST",
      headers: { ...leaseHeaders, authorization: `Bearer ${secret}`, "x-worker-name": "smoke" },
      body: leaseBody,
    });
    const json = await authed.json().catch(() => null);
    record(
      "internal API accepts the worker credential",
      authed.status === 200 && Array.isArray(json?.items),
      `${authed.status} · leased ${json?.items?.length ?? "?"}`,
    );

    // A session cookie must not be accepted as a worker credential.
    const cookieOnly = await fetch(`${BASE_URL}/api/internal/jobs/lease`, {
      method: "POST",
      headers: { ...leaseHeaders, cookie: `uxd_session=${token}` },
      body: leaseBody,
    });
    record(
      "a CMS session cannot act as a worker",
      cookieOnly.status === 401,
      `got ${cookieOnly.status}`,
    );
  } else {
    record("internal API authenticated call", true, "skipped — no WORKER_SHARED_SECRET");
  }

  // --- Report -------------------------------------------------------
  await revokeSession(session.sessionId);

  const passed = results.length - failures;
  process.stdout.write(
    `\n${passed}/${results.length} checks passed${failures > 0 ? `, \u001b[31m${failures} failed\u001b[0m` : ""}\n`,
  );
  process.exit(failures > 0 ? 1 : 0);
}

await main();
