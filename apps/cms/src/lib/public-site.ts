import "server-only";
import { refresh } from "next/cache";
import { after } from "next/server";
import { getEnv } from "@/lib/server";

/**
 * Refresh this screen, and tell the public site to refresh too.
 *
 * A drop-in for `refresh()` in the actions that change something the public
 * can see — publishing, featuring, tags, logos, a website being taken down.
 * The public site caches pages for a minute; this makes the change show the
 * moment it is saved.
 *
 * Fire-and-forget, after the response: the person saving does not wait on the
 * public site, and a public site that is down or not configured never fails a
 * save. Configured with PUBLIC_FRONTEND_ORIGIN and
 * PUBLIC_SITE_REVALIDATE_SECRET; without the secret it does nothing.
 */
export function refreshAll(): void {
  refresh();
  after(async () => {
    try {
      const env = await getEnv();
      if (!env.PUBLIC_SITE_REVALIDATE_SECRET) return;
      await fetch(`${env.PUBLIC_FRONTEND_ORIGIN.replace(/\/$/, "")}/api/revalidate`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.PUBLIC_SITE_REVALIDATE_SECRET}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The public site catches up on its own within a minute anyway.
    }
  });
}
