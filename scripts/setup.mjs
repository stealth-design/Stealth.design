#!/usr/bin/env node
/**
 * First-run setup.
 *
 *   npm install && npm run setup
 *
 * Creates `.env` and `.env.worker` from the examples with real generated
 * secrets, installs the browser Chromium build, builds the packages, applies
 * the migrations and seeds a base vocabulary plus an admin user.
 *
 * Two things it will not do. It never overwrites an existing env file, because
 * a developer's local configuration is not the setup script's to discard. And
 * it generates secrets rather than copying the placeholders, because a
 * placeholder secret that works locally is a placeholder secret that reaches a
 * deployment.
 *
 * Every step is idempotent: running it again on a working checkout is safe.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ESC = "\u001b";
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

let step = 0;
function heading(text) {
  step += 1;
  process.stdout.write(`\n${BOLD}${step}. ${text}${RESET}\n`);
}
const ok = (text, detail) =>
  process.stdout.write(`   ${GREEN}✓${RESET} ${text}${detail ? ` ${DIM}${detail}${RESET}` : ""}\n`);
const note = (text) => process.stdout.write(`   ${DIM}${text}${RESET}\n`);
const warn = (text) => process.stdout.write(`   ${YELLOW}!${RESET} ${text}\n`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...options.env },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output.slice(-4000)}`));
    });
  });
}

/** A URL-safe secret comfortably past the 32-character minimum. */
const secret = () => randomBytes(48).toString("base64url");

/** Is something already listening there? */
function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(700);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

// =========================================================================

process.stdout.write(`${BOLD}Design research platform — setup${RESET}\n`);

// --- 1. Environment files ------------------------------------------------
heading("Environment files");

const workerToken = secret();

for (const [target, example] of [
  [".env", ".env.example"],
  [".env.worker", ".env.worker.example"],
]) {
  const targetPath = join(ROOT, target);
  const examplePath = join(ROOT, example);

  if (existsSync(targetPath)) {
    ok(`${target} already exists`, "left alone");
    continue;
  }
  if (!existsSync(examplePath)) {
    warn(`${example} is missing; cannot create ${target}`);
    continue;
  }

  copyFileSync(examplePath, targetPath);
  let contents = readFileSync(targetPath, "utf8");

  if (target === ".env") {
    // Each secret is distinct: reusing one value for the session key and the
    // worker token would mean a leaked worker token also forges sessions.
    contents = contents
      .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret()}`)
      .replace(/^WORKER_SHARED_SECRET=.*$/m, `WORKER_SHARED_SECRET=${workerToken}`);
  } else {
    // The worker's token must match the CMS's, so it is written from the same
    // generated value rather than generated again.
    contents = contents.replace(/^WORKER_TOKEN=.*$/m, `WORKER_TOKEN=${workerToken}`);
  }

  writeFileSync(targetPath, contents);
  ok(`created ${target}`, "with generated secrets");
}

note("The worker's env holds a control-plane URL and a token — no database or storage credentials.");

// --- 2. Browser ----------------------------------------------------------
heading("Chromium for capture");
try {
  const output = await run("npx", ["playwright", "install", "chromium"], { quiet: true });
  ok("Chromium installed", output.includes("is already installed") ? "already present" : undefined);
} catch (error) {
  warn(`Chromium install failed. Capture will not work until it succeeds.`);
  note(`Run it yourself: npx playwright install chromium`);
  note(String(error.message).split("\n")[0]);
}

// --- 3. Build ------------------------------------------------------------
heading("Building packages");
await run("npx", ["tsc", "-b", "tsconfig.build.json"], { quiet: true });
ok("packages built", "dist/ with declarations");

// --- 4. Database ---------------------------------------------------------
heading("Database");

const dbAlreadyRunning = await portInUse(5432);
let server;

if (dbAlreadyRunning) {
  ok("something is already listening on 127.0.0.1:5432", "using it");
} else {
  note("Starting the embedded Postgres (PGlite) server…");
  server = spawn("npm", ["run", "db:serve"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  server.unref();

  const deadline = Date.now() + 45_000;
  let up = false;
  while (Date.now() < deadline) {
    if (await portInUse(5432)) {
      up = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!up) {
    warn("The database server did not start within 45 seconds.");
    note("Run `npm run db:serve` in its own terminal, then re-run `npm run setup`.");
    process.exit(1);
  }
  ok("database server started", "127.0.0.1:5432");
}

try {
  await run("npm", ["run", "db:migrate"], { quiet: true });
  ok("migrations applied");

  await run("npm", ["run", "db:seed"], { quiet: true });
  ok("seeded", "base vocabulary, settings, admin user");
} catch (error) {
  warn("Database setup failed.");
  process.stdout.write(`${RED}${error.message}${RESET}\n`);
  server?.kill();
  process.exit(1);
}

// The server was started only to finish setup; the developer runs it
// themselves from here, in a terminal where they can see its output.
if (server) {
  server.kill();
  note("Stopped the temporary database server.");
}

// =========================================================================

process.stdout.write(`\n${GREEN}${BOLD}Ready.${RESET}\n\n`);
process.stdout.write(`${BOLD}Start everything:${RESET}\n`);
process.stdout.write(`   npm run dev\n\n`);
process.stdout.write(`${BOLD}Or one at a time, in four terminals:${RESET}\n`);
process.stdout.write(`   npm run db:serve        ${DIM}# embedded Postgres on 5432${RESET}\n`);
process.stdout.write(`   npm run dev:cms         ${DIM}# the CMS on http://localhost:3000${RESET}\n`);
process.stdout.write(`   npm run dev:worker      ${DIM}# the capture worker${RESET}\n`);
process.stdout.write(`   npm run dev:frontend    ${DIM}# the public site on http://localhost:3001${RESET}\n\n`);
process.stdout.write(`${BOLD}Sign in:${RESET}\n`);
process.stdout.write(`   http://localhost:3000/login\n`);
process.stdout.write(`   admin@localhost / change-me-in-development\n`);
process.stdout.write(`   ${YELLOW}Change that password before the app is reachable by anyone else.${RESET}\n\n`);
process.stdout.write(`${BOLD}Then:${RESET} paste a URL into Ingestion, start the job, and watch it\n`);
process.stdout.write(`through Crawl jobs → Reviews → Published.\n\n`);
process.stdout.write(`${DIM}docs/local-development.md has the longer version.${RESET}\n`);
