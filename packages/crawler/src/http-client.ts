/**
 * Guarded HTTP fetch — capture level 1 (§26).
 *
 * This is the cheap path. A plain HTTP request and an HTML parse produce the
 * title, description, OG image, favicon, canonical URL and content hash, in
 * milliseconds and a few megabytes of memory. A browser costs 150-350MB and
 * several seconds, so anything that does not need rendering must not pay for
 * one — which is the whole of §26.
 *
 * Every request is bounded in four independent ways, because a hostile or
 * merely broken server can be slow, enormous, or endlessly redirecting:
 *
 *   - `timeoutMs`      total wall-clock for the request
 *   - `maxBytes`       enforced *while reading*, not from Content-Length
 *   - `maxRedirects`   each hop re-validated by the guard
 *   - a per-connection dispatcher pinned to a validated address
 */
import { Readable } from "node:stream";
import { request } from "undici";
import {
  type Logger,
  type Result,
  AppError,
  ErrorCode,
  err,
  ok,
} from "@uxd/shared";
import {
  type GuardFailure,
  type GuardPolicy,
  type GuardedUrl,
  createGuardedDispatcher,
  guardRedirect,
  guardUrl,
} from "./url-guard.js";

export interface FetchGuardedOptions {
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly accept?: string;
  readonly guardPolicy?: GuardPolicy;
  readonly logger?: Logger;
  /** Send `Accept-Encoding: identity` to skip decompression entirely. */
  readonly noCompression?: boolean;
}

export interface FetchGuardedResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  readonly bodyBytes: Uint8Array;
  /** UTF-8 decoding of the body, when it is text. */
  readonly bodyText: string | null;
  readonly byteSize: number;
  readonly redirectChain: readonly { status: number; url: string }[];
  readonly durationMs: number;
  readonly guarded: GuardedUrl;
  /** True when the body hit `maxBytes` and was cut short. */
  readonly truncated: boolean;
}

const DEFAULTS = {
  timeoutMs: 20_000,
  maxBytes: 15 * 1024 * 1024,
  maxRedirects: 5,
} as const;

const TEXTUAL_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|rss\+xml|atom\+xml)|image\/svg)/i;

/**
 * Fetch a URL with SSRF protection and hard limits.
 *
 * Redirects are followed manually rather than by undici, so that every hop goes
 * back through `guardRedirect`. This is the step that is almost always missed:
 * a client configured to follow redirects will happily walk from a validated
 * public URL to `http://169.254.169.254/`, and the guard never sees it.
 */
export async function fetchGuarded(
  url: string,
  options: FetchGuardedOptions,
): Promise<Result<FetchGuardedResult, GuardFailure>> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;

  const initial = await guardUrl(url, options.guardPolicy ?? {});
  if (!initial.ok) return err(initial.error);

  let guarded = initial.value;
  // `fetchUrl`, not `normalized`. The normalised form drops a trailing
  // slash, which is a different resource to a server — requesting it earns a
  // 301 back to the slashed form, which re-normalises to the slashless one,
  // and the loop below runs until it hits the hop limit. See `ParsedUrl`.
  let currentUrl = guarded.parsed.fetchUrl;
  const redirectChain: { status: number; url: string }[] = [];
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return err({
        kind: "DNS_FAILED",
        errorCode: ErrorCode.CAPTURE_TIMEOUT,
        message: `The request took longer than ${Math.round(timeoutMs / 1000)}s and was abandoned.`,
        rule: "timeout",
        url: currentUrl,
      });
    }

    const dispatcher = createGuardedDispatcher(guarded, {
      connectTimeoutMs: Math.min(10_000, remaining),
      headersTimeoutMs: Math.min(15_000, remaining),
      bodyTimeoutMs: remaining,
    });

    try {
      const response = await request(currentUrl, {
        method: "GET",
        dispatcher,
        // undici's `request()` does not follow redirects unless the redirect
        // interceptor is installed, and it is not. Each 3xx is handled by the
        // loop above so every hop is re-guarded.
        headers: {
          "user-agent": options.userAgent,
          accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          ...(options.noCompression ? { "accept-encoding": "identity" } : {}),
        },
        signal: AbortSignal.timeout(remaining),
      });

      const status = response.statusCode;
      const headers = normaliseHeaders(response.headers);

      // --- Redirect ----------------------------------------------------
      if (status >= 300 && status < 400 && headers.location) {
        // Drain the body so the socket is not left half-read.
        await response.body.dump().catch(() => {});
        await dispatcher.close().catch(() => {});

        if (hop === maxRedirects) {
          return err({
            kind: "BLOCKED_BY_POLICY",
            errorCode: ErrorCode.URL_BLOCKED,
            message: `The page redirected more than ${maxRedirects} times, so we stopped following it.`,
            rule: "max-redirects",
            url: currentUrl,
          });
        }

        const nextGuard = await guardRedirect(headers.location, currentUrl, options.guardPolicy ?? {});
        if (!nextGuard.ok) {
          options.logger?.warn("Refused to follow a redirect", {
            from: currentUrl,
            to: headers.location,
            reason: nextGuard.error.message,
          });
          return err(nextGuard.error);
        }

        // The chain records what was actually requested, for the same reason.
        redirectChain.push({ status, url: nextGuard.value.parsed.fetchUrl });
        guarded = nextGuard.value;
        currentUrl = nextGuard.value.parsed.fetchUrl;
        continue;
      }

      // --- Body --------------------------------------------------------
      const contentType = headers["content-type"] ?? null;

      // Reject on the declared length before reading a byte, when it is
      // declared and already over the limit.
      const declaredLength = Number(headers["content-length"] ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body.dump().catch(() => {});
        await dispatcher.close().catch(() => {});
        return err({
          kind: "BLOCKED_BY_POLICY",
          errorCode: ErrorCode.RESPONSE_TOO_LARGE,
          message: `The page declared ${Math.round(declaredLength / 1_048_576)}MB, over our ${Math.round(maxBytes / 1_048_576)}MB limit.`,
          rule: "content-length",
          url: currentUrl,
        });
      }

      const { bytes, truncated } = await readBounded(response.body, maxBytes);
      await dispatcher.close().catch(() => {});

      const isTextual = contentType !== null && TEXTUAL_TYPES.test(contentType);
      return ok({
        requestedUrl: url,
        finalUrl: currentUrl,
        httpStatus: status,
        headers,
        contentType,
        bodyBytes: bytes,
        bodyText: isTextual ? decodeText(bytes, contentType) : null,
        byteSize: bytes.byteLength,
        redirectChain,
        durationMs: Math.round(performance.now() - startedAt),
        guarded,
        truncated,
      });
    } catch (error) {
      await dispatcher.close().catch(() => {});
      if (AppError.is(error)) throw error;
      const message = error instanceof Error ? error.message : "request failed";
      const isTimeout = /timeout|aborted|TimeoutError/i.test(message);
      return err({
        kind: "DNS_FAILED",
        errorCode: isTimeout ? ErrorCode.CAPTURE_TIMEOUT : ErrorCode.NAVIGATION_FAILED,
        message: isTimeout
          ? "The server did not respond in time."
          : `The request failed: ${message.slice(0, 160)}`,
        rule: isTimeout ? "timeout" : "transport",
        url: currentUrl,
      });
    }
  }

  return err({
    kind: "BLOCKED_BY_POLICY",
    errorCode: ErrorCode.URL_BLOCKED,
    message: `The page redirected more than ${maxRedirects} times, so we stopped following it.`,
    rule: "max-redirects",
    url: currentUrl,
  });
}

/**
 * Read a body, stopping at `maxBytes`.
 *
 * The limit is applied as chunks arrive rather than trusting Content-Length,
 * because Content-Length is a claim: it can be absent (chunked transfer),
 * wrong, or deliberately understated to slip past a pre-check.
 */
async function readBounded(
  body: Readable | AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    if (total + buf.byteLength > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      // Stop pulling. The dispatcher is closed by the caller, which tears the
      // socket down so a hostile server cannot keep streaming at us.
      break;
    }
    chunks.push(buf);
    total += buf.byteLength;
  }

  return { bytes: Buffer.concat(chunks), truncated };
}

function normaliseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Decode a body to text.
 *
 * Honours a `charset` in Content-Type when Node can decode it, and falls back
 * to UTF-8. A page declaring an encoding Node does not know is decoded as UTF-8
 * with replacement characters rather than failing the capture — mangled text in
 * one field is a better outcome than losing the screenshot.
 */
function decodeText(bytes: Uint8Array, contentType: string | null): string {
  const charset = contentType ? /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() : null;
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      // Unknown label — fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * HEAD-style reachability probe for the bulk validation screen (§5).
 *
 * Deliberately cheap and deliberately forgiving: this decides whether to show
 * "Unreachable" next to a pasted URL, and a false negative there would
 * discourage an operator from queueing a URL that is actually fine. Many sites
 * reject HEAD outright, so a 405 counts as reachable.
 */
export async function probeReachable(
  url: string,
  options: { userAgent: string; timeoutMs?: number; guardPolicy?: GuardPolicy },
): Promise<{ reachable: boolean; httpStatus: number | null; reason: string | null }> {
  const guarded = await guardUrl(url, options.guardPolicy ?? {});
  if (!guarded.ok) {
    return { reachable: false, httpStatus: null, reason: guarded.error.message };
  }

  const dispatcher = createGuardedDispatcher(guarded.value, { connectTimeoutMs: 5_000 });
  try {
    const response = await request(guarded.value.parsed.fetchUrl, {
      method: "HEAD",
      dispatcher,
      headers: { "user-agent": options.userAgent },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    await response.body.dump().catch(() => {});
    const status = response.statusCode;
    // 405 = HEAD not allowed, which still proves the host answered.
    const reachable = status < 500 || status === 503;
    return {
      reachable,
      httpStatus: status,
      reason: reachable ? null : `The server responded ${status}.`,
    };
  } catch (error) {
    return {
      reachable: false,
      httpStatus: null,
      reason: error instanceof Error ? `Could not connect: ${error.message.slice(0, 120)}` : "Could not connect.",
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
