import "server-only";
import { headers } from "next/headers";
import { createErrorHandler, requestLogger, securityHeaders } from "@uxd/api";
import type { BaseContext } from "@uxd/api";
import { uuidv7 } from "@uxd/shared";
import { getBaseContext, getEnv, getLogger } from "@/lib/server";

/**
 * Shared wiring for the mounted Hono routers.
 *
 * The three API surfaces — `/api/internal` for the capture worker,
 * `/api/public` for the public frontend, and `/api/admin` for programmatic
 * CMS access — are separate Hono apps with separate authentication, mounted at
 * separate paths (§19). They share only this: how a request context is built,
 * and how an error becomes a response.
 */
export interface ApiHost {
  readonly requestId: string;
  readonly baseContext: (requestId: string) => BaseContext;
  readonly errorHandler: ReturnType<typeof createErrorHandler>;
  readonly requestLogger: ReturnType<typeof requestLogger>;
  readonly securityHeaders: ReturnType<typeof securityHeaders>;
}

export async function apiHost(): Promise<ApiHost> {
  const [logger, env, headerList, base] = await Promise.all([
    getLogger(),
    getEnv(),
    headers(),
    getBaseContext(),
  ]);

  const requestId = headerList.get("x-request-id") ?? uuidv7();

  return {
    requestId,
    // The routers may build a context more than once for a single request, and
    // they must all carry the same id so the log lines correlate.
    baseContext: (id: string) => ({ ...base, requestId: id }),
    errorHandler: createErrorHandler({
      logger,
      // Operator-facing detail is exposed only in development. In production it
      // stays in the log, findable by the request id echoed in the response.
      exposeDetail: env.NODE_ENV !== "production",
    }),
    requestLogger: requestLogger(logger),
    securityHeaders: securityHeaders(),
  };
}
