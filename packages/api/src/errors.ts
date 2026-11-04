/**
 * HTTP error handling.
 *
 * One handler for all three routers, so an error looks the same whichever
 * surface produced it. The response body is always the `AppError` public shape:
 * a stable machine `code`, a message written for a person, and field-level
 * `issues` when there are any.
 *
 * What never reaches the response: stack traces, SQL, the `detail` field, or
 * anything from `context`. Those go to the structured log with the request id,
 * so an operator reporting "I got a 500, request id abc" can be answered
 * precisely without the error itself having leaked internals to whoever
 * triggered it.
 */
import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError, type ZodType } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { AppError, ErrorCode, type Logger, toAppError, uuidv7 } from "@uxd/shared";

export interface ErrorHandlerDeps {
  readonly logger: Logger;
  /** Include `detail` in responses. Development only. */
  readonly exposeDetail?: boolean;
}

export function createErrorHandler(deps: ErrorHandlerDeps): ErrorHandler {
  return (error, c) => {
    const requestId = c.req.header("x-request-id") ?? c.get("requestId") ?? uuidv7();

    // Zod validation failures become a 422 with per-field messages, which is
    // what a form needs in order to point at the field that is wrong.
    if (error instanceof ZodError) {
      const appError = new AppError(ErrorCode.VALIDATION_FAILED, "Some of that input is not valid.", {
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      deps.logger.debug("Request validation failed", {
        requestId,
        path: c.req.path,
        issues: appError.issues,
      });
      return c.json(appError.toPublicJSON(), 422);
    }

    if (error instanceof HTTPException) {
      const status = error.status;
      const appError = new AppError(
        status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.BAD_REQUEST,
        error.message || "Request failed",
        { status },
      );
      return c.json(appError.toPublicJSON(), status);
    }

    const appError = toAppError(error);

    // 5xx is our bug; 4xx is the caller's. Log them at different levels so the
    // error stream is not swamped by ordinary 404s and permission denials.
    const isServerError = appError.status >= 500;
    const fields = {
      requestId,
      method: c.req.method,
      path: c.req.path,
      code: appError.code,
      status: appError.status,
      detail: appError.detail,
      ...appError.context,
    };
    if (isServerError) {
      deps.logger.error(appError.publicMessage, { ...fields, error });
    } else {
      deps.logger.warn(appError.publicMessage, fields);
    }

    const body = appError.toPublicJSON();
    return c.json(
      deps.exposeDetail && appError.detail
        ? { error: { ...body.error, detail: appError.detail, requestId } }
        : { error: { ...body.error, requestId } },
      appError.status as never,
    );
  };
}

/**
 * Attach a request id and log the outcome of every request.
 *
 * The id is echoed in the response header and included in the error body, so a
 * user-reported failure can be found in the logs by one exact match rather
 * than by guessing at a timestamp.
 */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? uuidv7();
    c.set("requestId", requestId);
    const startedAt = performance.now();

    await next();

    const durationMs = Math.round(performance.now() - startedAt);
    c.header("x-request-id", requestId);

    const fields = {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    };
    // Slow requests are worth noticing even when they succeed: a 4-second list
    // query is a missing index, and it will only get worse as the library grows.
    if (c.res.status >= 500) logger.error("Request failed", fields);
    else if (durationMs > 2_000) logger.warn("Slow request", fields);
    else logger.debug("Request", fields);
  };
}

/**
 * Simple in-process rate limiter.
 *
 * Protects the public API and the sign-in endpoint from a single noisy client.
 * In-process on purpose: it is one moving part with no Redis, and it degrades
 * gracefully — with several instances each enforces its own share, so the
 * effective limit scales with instance count. That is documented as a
 * limitation; a shared limiter is the fix when there is enough traffic for it
 * to matter.
 */
export function rateLimit(options: {
  readonly windowMs: number;
  readonly max: number;
  readonly keyFor?: (c: Context) => string;
  readonly logger?: Logger;
}): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Bounded cleanup, so a long-running process does not accumulate a key per
  // client address forever.
  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  };
  const timer = setInterval(sweep, Math.max(options.windowMs, 30_000));
  timer.unref?.();

  return async (c, next) => {
    const key =
      options.keyFor?.(c) ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("cf-connecting-ip") ??
      "unknown";

    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
    } else {
      entry.count += 1;
      if (entry.count > options.max) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        options.logger?.warn("Rate limit exceeded", { key, path: c.req.path, count: entry.count });
        c.header("retry-after", String(retryAfter));
        return c.json(
          {
            error: {
              code: ErrorCode.RATE_LIMITED,
              message: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
            },
          },
          429,
        );
      }
    }

    await next();
    return undefined;
  };
}

/**
 * Security headers.
 *
 * The CSP is deliberately strict for API responses, which return JSON and need
 * no script, style or frame capability at all. A JSON endpoint that a browser
 * can be tricked into rendering as HTML is a stored-XSS vector, and
 * `X-Content-Type-Options: nosniff` plus a `default-src 'none'` policy closes
 * it.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "strict-origin-when-cross-origin");
    c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
  };
}

/**
 * `zValidator`, but the failure reaches our error handler.
 *
 * `@hono/zod-validator` catches the `ZodError` itself and answers with its own
 * body — `{ success: false, error: <serialised ZodError> }` and a 400. Two
 * problems with that. It is a *different shape* from every other error this API
 * returns, so a client has to parse two envelopes; and it exposes Zod's
 * internal issue representation, which is more of the schema than a public API
 * should be describing.
 *
 * The hook rethrows instead, so `createErrorHandler` formats it like anything
 * else: a 422, `code: VALIDATION_FAILED`, and one `{ path, message }` per bad
 * field — which is what a caller actually needs in order to fix the request.
 *
 * Use this rather than `zValidator` directly. There is no reason to want the
 * other behaviour, and a wrapper is how that stays true as endpoints are added.
 */
export function validate<
  T extends ZodType,
  Target extends keyof ValidationTargets,
>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw result.error;
  });
}
