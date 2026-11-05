/**
 * Environment configuration.
 *
 * Each runtime gets its own schema, and each schema is a closed contract:
 *
 *   - `cmsEnvSchema`      — the control plane. Holds the database URL, the
 *                           session secret, object-storage credentials, and
 *                           the model API key.
 *   - `workerEnvSchema`   — the capture worker. Holds a control-plane URL and
 *                           a worker token, and NOTHING else. It has no
 *                           database URL, no storage credentials and no
 *                           session secret, because it never talks to those
 *                           systems (§25).
 *   - `frontendEnvSchema` — the public site. Holds one public API base URL.
 *
 * The worker loader additionally *fails to start* if a forbidden variable is
 * present in its environment at all. That turns "the worker must not have
 * application secrets" from a convention into a startup assertion: handing the
 * worker a copied-and-pasted full `.env` is a crash, not a silent expansion of
 * its blast radius.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { LOG_LEVELS } from "./logger.js";

const nodeEnv = z.enum(["development", "test", "production"]).default("development");

const baseEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  UXD_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  UXD_LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
});

// --- Control plane (CMS) --------------------------------------------------

export const cmsEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgres:// URL"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(["disable", "require", "no-verify"]).default("disable"),

  /** Signs session cookies. Rotating it logs everyone out. */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  /** Set false only for local http:// development. */
  SESSION_COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /** Shared secret the ingestion worker presents to /api/internal/*. */
  WORKER_SHARED_SECRET: z.string().min(32, "WORKER_SHARED_SECRET must be at least 32 characters"),

  /** Object storage. `local` writes under .data/media for development only. */
  STORAGE_DRIVER: z.enum(["local", "s3", "blob"]).default("local"),
  /** Vercel Blob: set automatically when a Blob store is connected to the project. */
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  /** Vercel Blob: whether the store was created private (the default) or public. */
  STORAGE_BLOB_ACCESS: z.enum(["private", "public"]).default("private"),
  STORAGE_LOCAL_ROOT: z.string().default(".data/media"),
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_REGION: z.string().default("auto"),
  STORAGE_S3_ENDPOINT: z.string().url().optional(),
  STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Public base URL for served media (CDN domain), if the bucket is public. */
  STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
  STORAGE_S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /** Origin the CMS is served from, for absolute links and cookie scoping. */
  CMS_BASE_URL: z.string().url().default("http://localhost:3000"),
  /** Origin allowed to call the public API cross-origin (the frontend). */
  PUBLIC_FRONTEND_ORIGIN: z.string().url().default("http://localhost:3001"),

  /** AI classification. Absent means classification runs in heuristic-only
   * mode; it is never required for the pipeline to work. */
  CLASSIFICATION_PROVIDER: z.enum(["none", "heuristic", "anthropic"]).default("heuristic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model used for classification suggestions. Opus 5 by default; an
   * operator may trade capability for cost on high-volume classification. */
  CLASSIFICATION_MODEL: z.string().default("claude-opus-5"),

  /** Cap on a single media upload, in megabytes. */
  MEDIA_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(64),
});
export type CmsEnv = z.infer<typeof cmsEnvSchema>;

// --- Capture worker -------------------------------------------------------

export const workerEnvSchema = baseEnvSchema.extend({
  /** Control-plane base URL. The only host the worker is allowed to call
   * besides the sites it is told to capture. */
  CONTROL_PLANE_URL: z.string().url().default("http://localhost:3000"),
  /** Bearer token for /api/internal/*. Must match WORKER_SHARED_SECRET. */
  WORKER_TOKEN: z.string().min(32, "WORKER_TOKEN must be at least 32 characters"),
  /** Stable identity for this worker instance in logs and the CMS. */
  WORKER_NAME: z.string().default("worker-local"),

  /** Concurrent browser contexts. Each costs roughly 150-350MB. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** How many items to lease per poll. */
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(4),
  /** Idle poll interval, ms. */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  /** Lease duration. A crashed worker's items become re-leasable after this. */
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),

  /** Hard ceilings. Per-job config may lower these but never raise them. */
  WORKER_MAX_PAGE_BYTES: z.coerce.number().int().min(1024).default(15 * 1024 * 1024),
  WORKER_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).default(25 * 1024 * 1024),
  WORKER_NAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(30_000),
  WORKER_ITEM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  WORKER_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  /** Memory ceiling for the browser process group, MB. Enforced by the
   * container in production; advisory in local development. */
  WORKER_MEMORY_LIMIT_MB: z.coerce.number().int().min(256).default(2048),

  /**
   * Scratch directory for the browser's own temporary files.
   *
   * Named `CRAWLEE_*` because the brief specified Crawlee for crawl
   * orchestration and the variable predates the decision not to use it — see
   * `docs/known-limitations.md`. Kept under this name so an existing
   * deployment's configuration does not need editing; nothing reads Crawlee
   * any more, and this is simply where Playwright's per-item scratch goes.
   *
   * Must be disposable: it is wiped between items and nothing durable belongs
   * in it.
   */
  CRAWLEE_STORAGE_DIR: z.string().default("./storage"),
  /** User agent presented to crawled sites. Identifies us honestly. */
  WORKER_USER_AGENT: z
    .string()
    .default(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 uxdisrupt-research/0.1 (+contact: set WORKER_CONTACT_URL)",
    ),
  WORKER_CONTACT_URL: z.string().url().optional(),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Variables that must never be readable by the capture worker.
 *
 * The worker executes untrusted JavaScript from arbitrary websites. If any of
 * these were in its environment, a browser sandbox escape or a compromised npm
 * dependency would hand an attacker the database and the object store.
 */
export const WORKER_FORBIDDEN_ENV_KEYS: readonly string[] = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "WORKER_SHARED_SECRET",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

// --- Public frontend ------------------------------------------------------

export const frontendEnvSchema = baseEnvSchema.extend({
  /** Base URL of the public read API. The frontend has no other data source
   * and no database access whatsoever. */
  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:3000/api/public"),
  /** Where media is served from, when the bucket is public/CDN-fronted. */
  PUBLIC_MEDIA_BASE_URL: z.string().url().optional(),
});
export type FrontendEnv = z.infer<typeof frontendEnvSchema>;

// --- Loading --------------------------------------------------------------

export class EnvError extends Error {
  readonly issues: readonly string[];
  constructor(surface: string, issues: readonly string[]) {
    super(
      `Invalid environment for "${surface}":\n${issues.map((i) => `  - ${i}`).join("\n")}\n\n` +
        `See .env.example for the expected variables.`,
    );
    this.name = "EnvError";
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.join(".") || "(root)";
    return `${path}: ${i.message}`;
  });
}

/**
 * Load a `.env` file if present.
 *
 * Searches the working directory and then walks up to the repository root,
 * because an app in `apps/cms` runs with its own directory as the cwd while the
 * one `.env` for local development lives at the monorepo root. Without this,
 * every app would need its own copy of the same file.
 *
 * A missing `.env` is normal — in production the variables come from the
 * platform — so this never throws. A malformed one surfaces as a validation
 * failure against the schema, which produces a far better message than a parse
 * error would.
 */
export function loadEnvFile(filename = ".env"): string | null {
  const found = findUpwards(filename);
  if (!found) return null;
  try {
    process.loadEnvFile(found);
    return found;
  } catch {
    return null;
  }
}

/** Walk up from the current directory looking for a file. */
function findUpwards(filename: string): string | null {
  let directory = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * The repository root, identified by the file every process already looks for.
 *
 * Used to anchor relative paths in configuration. `.env` is the marker because
 * it is the one file guaranteed to sit at the root of a working checkout — a
 * `package.json` search would stop at the nearest workspace, which is exactly
 * the wrong answer here.
 */
export function repoRoot(): string {
  const envFile = findUpwards(".env") ?? findUpwards("package-lock.json");
  return envFile ? dirname(envFile) : resolve(process.cwd());
}

function parse<T extends z.ZodType>(surface: string, schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) throw new EnvError(surface, formatIssues(result.error));
  return result.data;
}

export function loadCmsEnv(source: NodeJS.ProcessEnv = process.env): CmsEnv {
  const env = parse("cms", cmsEnvSchema, source);
  if (env.STORAGE_DRIVER === "s3") {
    const missing = (
      [
        ["STORAGE_S3_BUCKET", env.STORAGE_S3_BUCKET],
        ["STORAGE_S3_ACCESS_KEY_ID", env.STORAGE_S3_ACCESS_KEY_ID],
        ["STORAGE_S3_SECRET_ACCESS_KEY", env.STORAGE_S3_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => `${k}: required when STORAGE_DRIVER=s3`);
    if (missing.length > 0) throw new EnvError("cms", missing);
  }
  if (env.STORAGE_DRIVER === "blob" && !env.BLOB_READ_WRITE_TOKEN) {
    throw new EnvError("cms", ["BLOB_READ_WRITE_TOKEN: required when STORAGE_DRIVER=blob (connect a Blob store to the project)"]);
  }
  if (env.CLASSIFICATION_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
    throw new EnvError("cms", ["ANTHROPIC_API_KEY: required when CLASSIFICATION_PROVIDER=anthropic"]);
  }
  // A *relative* STORAGE_LOCAL_ROOT resolves against the current working
  // directory, which differs per process: the CMS runs in `apps/cms`, a
  // workspace script runs in its own package, a one-off script runs wherever
  // it was invoked. The result is several `.data` directories that each hold
  // some of the media, and a library that appears to lose files depending on
  // which process wrote them — with no error anywhere, because every write
  // succeeds and every read finds nothing.
  //
  // Anchoring to the repository root makes every process agree. An absolute
  // path is left exactly as given, which is what a deployment would use.
  const localRoot = isAbsolute(env.STORAGE_LOCAL_ROOT)
    ? env.STORAGE_LOCAL_ROOT
    : join(repoRoot(), env.STORAGE_LOCAL_ROOT);

  if (env.NODE_ENV === "production") {
    const problems: string[] = [];
    if (env.STORAGE_DRIVER === "local") {
      problems.push("STORAGE_DRIVER: 'local' is a development driver; use 'blob' or 's3' in production");
    }
    if (!env.SESSION_COOKIE_SECURE) {
      problems.push("SESSION_COOKIE_SECURE: must be true in production");
    }
    if (env.SESSION_SECRET === env.WORKER_SHARED_SECRET) {
      problems.push("SESSION_SECRET and WORKER_SHARED_SECRET must be different values");
    }
    if (problems.length > 0) throw new EnvError("cms", problems);
  }
  return { ...env, STORAGE_LOCAL_ROOT: localRoot };
}

/**
 * Load the worker environment, asserting that no control-plane secret is
 * reachable from this process.
 */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const leaked = WORKER_FORBIDDEN_ENV_KEYS.filter((key) => {
    const value = source[key];
    return typeof value === "string" && value.length > 0;
  });
  if (leaked.length > 0) {
    throw new EnvError("worker", [
      `The capture worker was started with control-plane secrets in its environment: ${leaked.join(", ")}.`,
      "The worker runs untrusted page JavaScript and must never hold these.",
      "Give it only CONTROL_PLANE_URL and WORKER_TOKEN (see .env.worker.example).",
    ]);
  }
  return parse("worker", workerEnvSchema, source);
}

export function loadFrontendEnv(source: NodeJS.ProcessEnv = process.env): FrontendEnv {
  return parse("frontend", frontendEnvSchema, source);
}
