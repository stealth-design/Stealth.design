"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresh the current route on an interval.
 *
 * Used on the crawl-job page while a job is running. Polling rather than a
 * websocket: this is one screen an operator leaves open for a few minutes, a
 * few seconds of staleness costs nothing, and there is no connection state to
 * reconnect or reconcile after a deploy.
 *
 * It stops when the tab is hidden, so a forgotten background tab does not keep
 * a database connection busy indefinitely.
 */
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else {
        // Refresh immediately on return, so coming back to the tab shows the
        // current state rather than the state from when it was hidden.
        router.refresh();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, router]);

  return null;
}
