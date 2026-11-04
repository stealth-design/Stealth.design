/**
 * The public read API (§18, §19).
 *
 * Unauthenticated, read-only, and the public frontend's only data source. It
 * returns published content and nothing else — enforced by the SQL filter in
 * `queries/public.ts` and again by the allowlist serialisers.
 *
 * Mounted in the CMS process for V1 so there is one deployable. The router is a
 * standalone Hono app with no dependency on the CMS's session handling, so
 * splitting it into its own service later is a deployment change rather than a
 * rewrite — and that is worth doing when public traffic is enough to want its
 * own scaling and its own blast radius.
 */
import { Hono } from "hono";
import { createPublicApi } from "@uxd/api";
import { apiHost } from "@/lib/api-host";
import { getEnv } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handler(request: Request): Promise<Response> {
  const [host, env] = await Promise.all([apiHost(), getEnv()]);

  const app = createPublicApi({
    baseContext: host.baseContext,
    allowedOrigins: [env.PUBLIC_FRONTEND_ORIGIN, env.CMS_BASE_URL],
  });

  app.onError(host.errorHandler);
  app.use("*", host.requestLogger);

  const root = new Hono().route("/api/public", app);
  return root.fetch(request);
}

export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
