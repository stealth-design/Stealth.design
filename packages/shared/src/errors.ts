/**
 * Error taxonomy.
 *
 * Every error carries a stable machine `code`, an HTTP status, and a
 * `publicMessage` that is safe to show to an end user or return over the
 * public API. `detail` is for operators only and must never be serialised to
 * an unauthenticated response.
 */

export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",

  // Ingestion / crawl domain
  URL_INVALID: "URL_INVALID",
  URL_BLOCKED: "URL_BLOCKED",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  ROBOTS_DISALLOWED: "ROBOTS_DISALLOWED",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  CAPTURE_TIMEOUT: "CAPTURE_TIMEOUT",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  NAVIGATION_FAILED: "NAVIGATION_FAILED",
  SCREENSHOT_FAILED: "SCREENSHOT_FAILED",
  STORAGE_FAILED: "STORAGE_FAILED",
  MEDIA_REJECTED: "MEDIA_REJECTED",
  CLASSIFICATION_FAILED: "CLASSIFICATION_FAILED",
  DUPLICATE: "DUPLICATE",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_UNAVAILABLE: 502,

  URL_INVALID: 400,
  URL_BLOCKED: 403,
  SSRF_BLOCKED: 403,
  ROBOTS_DISALLOWED: 403,
  CAPTURE_FAILED: 502,
  CAPTURE_TIMEOUT: 504,
  RESPONSE_TOO_LARGE: 413,
  NAVIGATION_FAILED: 502,
  SCREENSHOT_FAILED: 500,
  STORAGE_FAILED: 500,
  MEDIA_REJECTED: 415,
  CLASSIFICATION_FAILED: 500,
  DUPLICATE: 409,
  LIMIT_EXCEEDED: 429,
};

export interface AppErrorOptions {
  /** Operator-facing detail. Never returned to unauthenticated callers. */
  readonly detail?: string;
  /** Structured, already-redacted context for logs. */
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable?: boolean;
  readonly status?: number;
  /** Field-level issues, for form rendering. */
  readonly issues?: readonly { path: string; message: string }[];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly detail?: string;
  readonly context?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly issues?: readonly { path: string; message: string }[];

  constructor(code: ErrorCode, publicMessage: string, options: AppErrorOptions = {}) {
    super(options.detail ? `${publicMessage} (${options.detail})` : publicMessage, {
      cause: options.cause,
    });
    this.name = "AppError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.detail = options.detail;
    this.context = options.context;
    this.retryable = options.retryable ?? code === ErrorCode.UPSTREAM_UNAVAILABLE;
    this.issues = options.issues;
  }

  /** Body safe to return over any API surface, including unauthenticated. */
  toPublicJSON(): { error: { code: ErrorCode; message: string; issues?: readonly { path: string; message: string }[] } } {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(this.issues ? { issues: this.issues } : {}),
      },
    };
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

export const badRequest = (m: string, o?: AppErrorOptions) => new AppError(ErrorCode.BAD_REQUEST, m, o);
export const notFound = (what = "Resource", o?: AppErrorOptions) =>
  new AppError(ErrorCode.NOT_FOUND, `${what} not found`, o);
export const forbidden = (m = "You do not have permission to do that", o?: AppErrorOptions) =>
  new AppError(ErrorCode.FORBIDDEN, m, o);
export const unauthenticated = (m = "Authentication required", o?: AppErrorOptions) =>
  new AppError(ErrorCode.UNAUTHENTICATED, m, o);
export const conflict = (m: string, o?: AppErrorOptions) => new AppError(ErrorCode.CONFLICT, m, o);
export const internal = (m = "Something went wrong", o?: AppErrorOptions) =>
  new AppError(ErrorCode.INTERNAL, m, o);

/** Coerce an unknown thrown value into an AppError without leaking internals. */
export function toAppError(value: unknown): AppError {
  if (AppError.is(value)) return value;
  if (value instanceof Error) {
    return new AppError(ErrorCode.INTERNAL, "Something went wrong", {
      detail: value.message,
      cause: value,
    });
  }
  return new AppError(ErrorCode.INTERNAL, "Something went wrong", {
    detail: typeof value === "string" ? value : "non-error thrown",
  });
}

/**
 * Human-readable explanations for operational error codes, surfaced in the CMS
 * so a non-engineer reading a crawl log understands what happened.
 */
export const ERROR_CODE_EXPLANATIONS: Partial<Record<ErrorCode, string>> = {
  URL_INVALID: "The address was not a valid http(s) URL.",
  URL_BLOCKED: "The address is not allowed by our ingestion rules.",
  SSRF_BLOCKED: "The address resolved to a private or internal network and was refused for safety.",
  ROBOTS_DISALLOWED: "The site's robots.txt asks crawlers not to fetch this page.",
  CAPTURE_TIMEOUT: "The page took too long to load and the capture was abandoned.",
  RESPONSE_TOO_LARGE: "The page or asset was larger than our size limit.",
  NAVIGATION_FAILED: "The browser could not load the page (DNS, TLS, or the server refused).",
  SCREENSHOT_FAILED: "The page loaded but the screenshot could not be produced.",
  STORAGE_FAILED: "The capture succeeded but the file could not be saved to storage.",
  DUPLICATE: "We already have this exact content, so a new version was recorded instead.",
  LIMIT_EXCEEDED: "A configured job limit (pages, depth, or rate) stopped this item.",
  MEDIA_REJECTED: "The file type is not accepted by the media library.",
};
