import "server-only";
import { createPublicApiClient, type PublicApiClient } from "@uxd/api/client";

/**
 * The frontend's only data source.
 *
 * §"The CMS is the source of truth. Everything shown publicly must originate
 * from CMS-controlled records. The public frontend must NEVER independently
 * create or maintain content." This module is where that is made structural
 * rather than aspirational: it is the single place the app obtains data, it
 * speaks HTTP to the public read API, and there is no write method on the
 * client to call.
 *
 * The import is `@uxd/api/client` — a dependency-free subpath that duplicates
 * the response shapes rather than importing them — so nothing here can
 * transitively reach Drizzle, the database schema, the storage driver or the
 * crawler. `scripts/check-boundaries.mjs` fails the build if this app ever
 * gains one of those dependencies.
 *
 * Configuration is one environment variable. There is nothing else to
 * configure, because there is nothing else this app can talk to.
 */
export const api: PublicApiClient = createPublicApiClient({
  baseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/public",
  // Cached briefly rather than not at all. A design library changes when
  // someone publishes something, not continuously, and a minute of staleness
  // on a public page costs nothing while removing a per-request round trip.
  revalidate: 60,
  userAgent: "uxdisrupt-frontend/0.1",
});
