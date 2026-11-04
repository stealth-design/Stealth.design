/** Duration helpers. Everything in this codebase stores durations in ms. */

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const seconds = (n: number) => n * SECOND;
export const minutes = (n: number) => n * MINUTE;
export const hours = (n: number) => n * HOUR;
export const days = (n: number) => n * DAY;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Compact human duration: 950ms, 4.2s, 3m 12s, 1h 04m. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  return `${h}h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** Deadline helper: an AbortSignal plus a check for "did we run out of time". */
export function deadline(ms: number): { signal: AbortSignal; expired: () => boolean; clear: () => void } {
  const controller = new AbortController();
  const at = Date.now() + ms;
  const timer = setTimeout(() => controller.abort(new Error(`Deadline exceeded after ${ms}ms`)), ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    expired: () => Date.now() >= at,
    clear: () => clearTimeout(timer),
  };
}
