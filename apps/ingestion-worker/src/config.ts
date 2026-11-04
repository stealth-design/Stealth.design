/**
 * Worker runtime configuration.
 *
 * These are the worker's *own* ceilings, distinct from a job's configuration.
 * A job may ask for less than these but never more: `captureItem` takes the
 * minimum of the two on every limit. That means a compromised or buggy control
 * plane cannot instruct a worker to fetch a 2GB page or spend ten minutes on
 * one URL — the worker's own limits still apply.
 */
import type { WorkerEnv } from "@uxd/shared/env";

export interface WorkerRuntimeConfig {
  readonly name: string;
  readonly userAgent: string;
  readonly concurrency: number;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly maxPageBytes: number;
  readonly navTimeoutMs: number;
  readonly itemTimeoutMs: number;
  readonly maxRedirects: number;
  /** Operator blocklist, fetched from settings at startup. Empty for now. */
  readonly blockedDomains: readonly string[];
}

export function runtimeConfigFromEnv(env: WorkerEnv): WorkerRuntimeConfig {
  return {
    name: env.WORKER_NAME,
    userAgent: env.WORKER_CONTACT_URL
      ? env.WORKER_USER_AGENT.replace("set WORKER_CONTACT_URL", env.WORKER_CONTACT_URL)
      : env.WORKER_USER_AGENT,
    concurrency: env.WORKER_CONCURRENCY,
    batchSize: env.WORKER_BATCH_SIZE,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: env.WORKER_LEASE_SECONDS,
    maxPageBytes: env.WORKER_MAX_PAGE_BYTES,
    navTimeoutMs: env.WORKER_NAV_TIMEOUT_MS,
    itemTimeoutMs: env.WORKER_ITEM_TIMEOUT_MS,
    maxRedirects: env.WORKER_MAX_REDIRECTS,
    blockedDomains: [],
  };
}
