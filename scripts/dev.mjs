#!/usr/bin/env node
/**
 * Run the whole stack in one terminal.
 *
 *   npm run dev
 *
 * Four processes: the database, the CMS, the capture worker and the public
 * site. Their output is interleaved with a coloured prefix per process, which
 * is the point — the interesting moments in this system are the ones that span
 * processes ("the CMS queued a job, the worker leased it, the capture came
 * back") and those are invisible in four separate terminals.
 *
 * Ordering matters and is enforced rather than hoped for: the database has to
 * accept connections before the CMS starts, and the CMS has to be answering
 * before the worker tries to register with it. So each dependency is *waited
 * for*, not slept past.
 *
 * `npm run dev:cms` and friends still exist for when one process needs its own
 * terminal — a debugger attached, or a worker run with different limits.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const YELLOW = `${ESC}[33m`;

/** One colour per process, so a line's origin is readable at a glance. */
const PROCESSES = [
  {
    name: "db",
    colour: `${ESC}[35m`,
    command: "npm",
    args: ["run", "db:serve"],
    /** Ready when it is accepting TCP connections. */
    readyOn: { port: 5432 },
  },
  {
    name: "cms",
    colour: `${ESC}[36m`,
    command: "npm",
    args: ["run", "dev:cms"],
    dependsOn: "db",
    readyOn: { url: "http://localhost:3000/api/public/health" },
  },
  {
    name: "worker",
    colour: `${ESC}[33m`,
    command: "npm",
    args: ["run", "dev:worker"],
    // The worker verifies its browser and then registers with the CMS. Starting
    // it early is not harmful — it retries — but it fills the log with
    // connection failures that look like a problem and are not.
    dependsOn: "cms",
  },
  {
    name: "site",
    colour: `${ESC}[32m`,
    command: "npm",
    args: ["run", "dev:frontend"],
    dependsOn: "cms",
    readyOn: { port: 3001 },
  },
];

const width = Math.max(...PROCESSES.map((p) => p.name.length));
const children = new Map();
let shuttingDown = false;

function write(name, colour, chunk) {
  const prefix = `${colour}${name.padEnd(width)}${RESET} ${DIM}│${RESET} `;
  for (const line of String(chunk).split("\n")) {
    if (line.trim().length === 0) continue;
    process.stdout.write(`${prefix}${line}\n`);
  }
}

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(600);
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

async function urlAnswers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

async function waitUntilReady(readyOn, timeoutMs = 90_000) {
  if (!readyOn) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = readyOn.port ? await portOpen(readyOn.port) : await urlAnswers(readyOn.url);
    if (ready) return true;
    if (shuttingDown) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function start(process_) {
  const child = spawn(process_.command, process_.args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  child.stdout.on("data", (chunk) => write(process_.name, process_.colour, chunk));
  child.stderr.on("data", (chunk) => write(process_.name, process_.colour, chunk));

  child.on("exit", (code, signal) => {
    children.delete(process_.name);
    if (shuttingDown) return;
    write(
      process_.name,
      process_.colour,
      `exited (${signal ?? code}). The other processes are still running; restart with npm run dev:${process_.name === "site" ? "frontend" : process_.name}.`,
    );
  });

  children.set(process_.name, child);
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${DIM}Stopping…${RESET}\n`);
  for (const child of children.values()) child.kill(signal);
  // A grace period, then insist. A dev server that ignores SIGINT should not
  // leave a port held after the terminal has been handed back.
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(0);
  }, 4_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// =========================================================================

if (!existsSync(join(ROOT, ".env"))) {
  process.stdout.write(`${YELLOW}No .env found. Run ${BOLD}npm run setup${RESET}${YELLOW} first.${RESET}\n`);
  process.exit(1);
}

process.stdout.write(`${BOLD}Starting the stack${RESET} ${DIM}(ctrl-c to stop everything)${RESET}\n\n`);

/** Already answering on its port or URL? Then it is someone else's process. */
async function alreadyServing(readyOn) {
  if (!readyOn) return false;
  return readyOn.port ? portOpen(readyOn.port) : urlAnswers(readyOn.url);
}

for (const process_ of PROCESSES) {
  // Adopt a process that is already running rather than starting a second one.
  // Running `npm run db:serve` in its own terminal and then `npm run dev` is a
  // completely reasonable thing to do, and without this the second database
  // fails to bind and buries the log in a minified stack trace from a
  // dependency — which looks like a real failure and is not.
  if (await alreadyServing(process_.readyOn)) {
    write(process_.name, process_.colour, "already running elsewhere — using it");
    continue;
  }

  if (process_.dependsOn) {
    const dependency = PROCESSES.find((candidate) => candidate.name === process_.dependsOn);
    if (dependency?.readyOn) {
      const ready = await waitUntilReady(dependency.readyOn);
      if (!ready) {
        write(process_.name, process_.colour, `giving up: ${dependency.name} never became ready`);
        continue;
      }
    }
  }
  if (shuttingDown) break;
  start(process_);
}

if (children.size === 0) {
  process.stdout.write(`${DIM}Everything was already running. Nothing to do.${RESET}\n`);
}

// Announce the URLs once everything that serves HTTP is answering, so the
// links are only printed when they actually work.
void (async () => {
  if (await waitUntilReady({ url: "http://localhost:3000/api/public/health" })) {
    if (shuttingDown) return;
    process.stdout.write(
      `\n  ${BOLD}CMS${RESET}          http://localhost:3000` +
        `\n  ${BOLD}Public site${RESET}  http://localhost:3001` +
        `\n  ${BOLD}Public API${RESET}   http://localhost:3000/api/public\n\n`,
    );
  }
})();
