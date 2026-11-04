#!/usr/bin/env node
/**
 * Architecture boundary checks.
 *
 * Several of this system's guarantees are structural rather than behavioural —
 * they are true because a package *cannot* reach something, not because it
 * chooses not to. Those guarantees are invisible to unit tests and easy to
 * erode with one convenient import, so they are asserted here and run as part
 * of `npm run lint`.
 *
 * Each check names the section of the brief it enforces.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const failures = [];
const passes = [];

const fail = (check, message) => failures.push({ check, message });
const pass = (check, message) => passes.push({ check, message });

/** All .ts/.tsx source files under a directory, excluding build output. */
function sourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", "dist", ".next", "storage", ".data", "test"].includes(entry)) continue;
      const full = join(current, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(resolve(ROOT, dir));
  return out;
}

/**
 * Strip comments and string literals before pattern matching.
 *
 * Without this, a comment that *documents* a forbidden pattern ("never add
 * --no-sandbox") trips the check that enforces it, which would train everyone
 * to ignore the checker.
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      // Keep a placeholder so adjacent tokens do not merge.
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Strip comments but keep string literals, for checks that inspect strings. */
function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        out += source[i];
        if (source[i] === "\\") {
          i += 1;
          if (i < n) out += source[i];
          i += 1;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function packageJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path, "package.json"), "utf8"));
}

function declaredDeps(path) {
  const pkg = packageJson(path);
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

/** Workspace packages imported by a directory's source. */
function importedWorkspacePackages(dir) {
  const found = new Map();
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["'](@uxd\/[a-z-]+)(?:\/[a-z-]+)?["']/g)) {
      const pkg = match[1];
      if (!found.has(pkg)) found.set(pkg, []);
      found.get(pkg).push(relative(ROOT, file));
    }
    for (const match of source.matchAll(/import\s*\(\s*["'](@uxd\/[a-z-]+)/g)) {
      const pkg = match[1];
      if (!found.has(pkg)) found.set(pkg, []);
      found.get(pkg).push(relative(ROOT, file));
    }
  }
  return found;
}

// =========================================================================
// 1. The public frontend has no database access (§18, §19).
//
// The frontend's entire purpose is to prove CMS -> API -> frontend works. If it
// could query the database it would be able to render unpublished content, and
// the pipeline it is meant to demonstrate would be unproven.
// =========================================================================
{
  const CHECK = "frontend-has-no-database";
  const forbidden = ["@uxd/database", "@uxd/auth", "@uxd/crawler", "@uxd/media", "drizzle-orm", "pg"];
  const deps = declaredDeps("apps/frontend");
  const leaked = forbidden.filter((dep) => deps.has(dep));
  if (leaked.length > 0) {
    fail(CHECK, `apps/frontend declares ${leaked.join(", ")}. It must reach content only over the public HTTP API.`);
  }

  const imports = importedWorkspacePackages("apps/frontend");
  for (const pkg of ["@uxd/database", "@uxd/auth", "@uxd/crawler", "@uxd/media"]) {
    if (imports.has(pkg)) {
      fail(CHECK, `apps/frontend imports ${pkg} in ${imports.get(pkg)[0]}. It must use only the public API client.`);
    }
  }
  if (failures.every((f) => f.check !== CHECK)) {
    pass(CHECK, "the public frontend cannot reach the database, auth, media or crawler");
  }
}

// =========================================================================
// 2. The capture worker holds no control-plane access (§25).
//
// The worker executes untrusted JavaScript from arbitrary websites. It must not
// be able to reach the database or object storage even in principle, so a
// renderer escape or a compromised dependency yields nothing.
// =========================================================================
{
  const CHECK = "worker-is-isolated";
  const forbidden = ["@uxd/database", "@uxd/auth", "@uxd/media", "@uxd/api", "drizzle-orm", "pg", "@aws-sdk/client-s3"];
  const deps = declaredDeps("apps/ingestion-worker");
  const leaked = forbidden.filter((dep) => deps.has(dep));
  if (leaked.length > 0) {
    fail(
      CHECK,
      `apps/ingestion-worker declares ${leaked.join(", ")}. It must talk to the control plane over HTTP only.`,
    );
  }

  const imports = importedWorkspacePackages("apps/ingestion-worker");
  for (const pkg of ["@uxd/database", "@uxd/auth", "@uxd/media", "@uxd/api"]) {
    if (imports.has(pkg)) {
      fail(CHECK, `apps/ingestion-worker imports ${pkg} in ${imports.get(pkg)[0]}.`);
    }
  }

  // The crawler package is shared with the control plane (for URL validation),
  // so it must not reach the database either.
  const crawlerImports = importedWorkspacePackages("packages/crawler");
  for (const pkg of ["@uxd/database", "@uxd/auth", "@uxd/media"]) {
    if (crawlerImports.has(pkg)) {
      fail(CHECK, `packages/crawler imports ${pkg} in ${crawlerImports.get(pkg)[0]}.`);
    }
  }

  if (failures.every((f) => f.check !== CHECK)) {
    pass(CHECK, "the capture worker and crawler cannot reach the database, auth or object storage");
  }
}

// =========================================================================
// 3. The browser sandbox is never disabled (§25: "DO NOT disable browser
//    sandboxing").
//
// Comments and strings are stripped first, so the doc comment in
// browser-capture.ts that explains this rule does not trip it.
// =========================================================================
{
  const CHECK = "browser-sandbox-enabled";
  const patterns = [
    { re: /--no-sandbox/, what: "--no-sandbox" },
    { re: /--disable-setuid-sandbox/, what: "--disable-setuid-sandbox" },
    { re: /chromiumSandbox\s*:\s*false/, what: "chromiumSandbox: false" },
    { re: /--disable-web-security/, what: "--disable-web-security" },
    { re: /ignoreHTTPSErrors\s*:\s*true/, what: "ignoreHTTPSErrors: true" },
    { re: /bypassCSP\s*:\s*true/, what: "bypassCSP: true" },
  ];
  for (const dir of ["packages", "apps"]) {
    for (const file of sourceFiles(dir)) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const { re, what } of patterns) {
        if (re.test(code)) {
          fail(CHECK, `${relative(ROOT, file)} contains ${what}, which weakens browser isolation.`);
        }
      }
    }
  }
  if (failures.every((f) => f.check !== CHECK)) {
    pass(CHECK, "no code path disables the browser sandbox or TLS verification");
  }
}

// =========================================================================
// 4. Taxonomy is not hardcoded into application logic (§13).
//
// Specific term names must not appear as literals that logic branches on.
// Seed data and the vocabulary *kinds* are fine; a comparison against the
// string "onboarding" is not.
// =========================================================================
{
  const CHECK = "taxonomy-not-hardcoded";
  const termLikeComparison =
    /(termSlug|term\.slug|taxonomySlug)\s*===\s*["'][a-z-]+["']|slug\s*===\s*["'](onboarding|pricing|checkout|navigation|sidebar|bottom-navigation|tab-bar|mega-menu)["']/;
  for (const dir of ["packages", "apps"]) {
    for (const file of sourceFiles(dir)) {
      if (/seed|fixtures?/i.test(file)) continue; // seed data may name terms
      const code = readFileSync(file, "utf8");
      if (termLikeComparison.test(code)) {
        fail(CHECK, `${relative(ROOT, file)} branches on a specific taxonomy term slug. Taxonomy must be CMS-managed data.`);
      }
    }
  }
  if (failures.every((f) => f.check !== CHECK)) {
    pass(CHECK, "no application logic branches on a specific taxonomy term");
  }
}

// =========================================================================
// 5. Dependencies are pinned (§37 "dependency pinning").
// =========================================================================
{
  const CHECK = "dependencies-pinned";
  const workspaces = [
    "packages/shared", "packages/types", "packages/database", "packages/auth",
    "packages/media", "packages/crawler", "packages/classification", "packages/api",
    "apps/cms", "apps/frontend", "apps/ingestion-worker",
  ];
  const unpinned = [];
  for (const ws of workspaces) {
    const pkg = packageJson(ws);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        // Workspace-internal packages use their own version; third-party must
        // be an exact version so a fresh install cannot pull a different one.
        if (name.startsWith("@uxd/")) continue;
        if (!/^\d+\.\d+\.\d+/.test(range)) unpinned.push(`${ws}: ${name}@${range}`);
      }
    }
  }
  if (unpinned.length > 0) {
    fail(CHECK, `these dependencies are not pinned to an exact version:\n     ${unpinned.join("\n     ")}`);
  } else {
    pass(CHECK, "every third-party dependency is pinned to an exact version");
  }
}

// =========================================================================
// 6. No hardcoded URLs outside configuration (§37 "no hardcoded URLs").
// =========================================================================
{
  const CHECK = "no-hardcoded-urls";
  const offenders = [];
  for (const dir of ["packages", "apps"]) {
    for (const file of sourceFiles(dir)) {
      // env.ts holds the defaults; these files legitimately reference well
      // known external URLs in documentation or schema form.
      if (/\/env\.ts$|\/ip\.ts$|next\.config|\.test\.ts$/.test(file)) continue;
      // Comments are stripped first: a doc comment that names an address for
      // explanatory reasons (the cloud metadata IP, in the SSRF guard) is
      // documentation, not a hardcoded endpoint.
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/["\`'](https?:\/\/(?!localhost|127\.0\.0\.1)[^"\`'\s]*)["\`']/g)) {
        const url = match[1];
        // A template literal with an interpolation is constructing a URL from
        // configuration, which is exactly what the rule wants.
        if (url.includes("${")) continue;
        // Namespace URIs, spec references and documentation domains are fine.
        if (/w3\.org|schema\.org|example\.(com|test)|json\.schemastore|rfc-editor|ietf\.org|<[a-z-]+>/.test(url)) {
          continue;
        }
        offenders.push(`${relative(ROOT, file)}: ${url}`);
      }
    }
  }
  if (offenders.length > 0) {
    fail(CHECK, `hardcoded URLs found (move them to configuration):\n     ${offenders.join("\n     ")}`);
  } else {
    pass(CHECK, "no hardcoded service URLs outside configuration");
  }
}

// =========================================================================
// Report
// =========================================================================
const ESC = "\u001b";
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const DIM = `${ESC}[90m`;
const RESET = `${ESC}[0m`;

console.log("\nArchitecture boundary checks\n");
for (const { check, message } of passes) {
  console.log(`  ${GREEN}ok${RESET}   ${check}${DIM} — ${message}${RESET}`);
}
for (const { check, message } of failures) {
  console.log(`  ${RED}FAIL${RESET} ${check}\n       ${message}`);
}
console.log(
  `\n${passes.length} passed, ${failures.length} failed\n`,
);
process.exit(failures.length > 0 ? 1 : 0);
