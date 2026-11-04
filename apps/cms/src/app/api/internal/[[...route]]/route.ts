/**
 * The capture worker's control-plane API.
 *
 * Mounted here, inside the CMS process, because the control plane is the thing
 * that owns the database and the object store. The worker is the isolated half
 * of that arrangement (§25): it runs untrusted page JavaScript in its own
 * container, holds no credentials beyond a scoped bearer token, and reaches
 * everything through these routes.
 *
 * `force-dynamic` and `runtime: nodejs` are both required: this handler talks
 * to Postgres and to `sharp`, neither of which works on the edge runtime, and
 * nothing here is ever cacheable.
 */
import { Hono } from "hono";
import { createInternalApi } from "@uxd/api";
import { apiHost } from "@/lib/api-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Screenshot uploads can be several megabytes, and a full-page capture of a
// long article is routinely larger than Next's default body assumption.
export const maxDuration = 120;

async function handler(request: Request): Promise<Response> {
  const host = await apiHost();
  const app = createInternalApi({ baseContext: host.baseContext });

  app.onError(host.errorHandler);
  app.use("*", host.requestLogger);
  app.use("*", host.securityHeaders);

  // Hono matches against the full pathname, so the router is mounted under its
  // base path on a root app rather than being called directly. Without this
  // every route would be compared to "/api/internal/..." and miss.
  const root = new Hono().route("/api/internal", app);
  return root.fetch(request);
}

export const GET = handler;
export const POST = handler;
