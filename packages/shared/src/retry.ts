/**
 * Retry with exponential backoff and full jitter.
 *
 * Full jitter (random between 0 and the computed ceiling) rather than fixed
 * backoff, because a crawl job retrying 200 failed items would otherwise
 * re-hit the same origin in synchronised waves.
 */
import { sleep } from "./time.js";

export interface RetryOptions<E = unknown> {
  /** Total attempts including the first. */
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly signal?: AbortSignal;
  readonly isRetryable?: (error: E, attempt: number) => boolean;
  readonly onRetry?: (error: E, attempt: number, delayMs: number) => void;
}

/** Delay before attempt `attempt` (1-indexed), with full jitter applied. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(Math.random() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = options.isRetryable ? options.isRetryable(error, attempt) : true;
      if (!retryable || attempt === attempts) throw error;
      const delayMs = backoffDelay(attempt, baseMs, maxMs);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

/**
 * Bounded-concurrency map. Used wherever we fan out over a list that could be
 * thousands of items long (URL validation, bulk publish, thumbnail generation)
 * and must not open thousands of sockets or sharp instances at once.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
