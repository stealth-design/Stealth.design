/**
 * Control-plane client.
 *
 * The worker's only channel to the rest of the system. It holds a bearer token
 * and one base URL, and everything it needs — work to do, somewhere to put
 * screenshots, a place to report results — comes through here.
 *
 * There is deliberately no database client, no S3 client and no session secret
 * anywhere in this app. `loadWorkerEnv` asserts that at startup, and the
 * repository's boundary check asserts it at build time.
 */
import { type Logger, AppError, ErrorCode, backoffDelay, sleep } from "@uxd/shared";
import type { CrawlJobConfig } from "@uxd/types";

export interface LeasedItem {
  readonly id: string;
  readonly jobId: string;
  readonly jobReference: string;
  readonly url: string;
  readonly host: string;
  readonly depth: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly config: CrawlJobConfig;
}

/** A live session this worker has been handed. */
export interface ClaimedStudioSession {
  readonly id: string;
  readonly targetUrl: string;
  readonly deviceProfile: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly leaseToken: string;
  readonly expiresAt: string;
  /** Photograph the header logo once the page is up: the website has none
   * yet, or only its app icon. */
  readonly wantsLogo?: boolean;
}

export interface StudioCommand {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface StudioSyncResult {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly status?: string;
  readonly commands: readonly StudioCommand[];
}

export interface StudioLiveInputResult {
  readonly accepted: boolean;
  readonly ended: boolean;
  readonly pointer: { readonly x: number; readonly y: number } | null;
  readonly wheel: {
    readonly x: number;
    readonly y: number;
    readonly deltaX: number;
    readonly deltaY: number;
  } | null;
}

export interface UploadedMedia {
  readonly mediaId: string;
  readonly deduplicated: boolean;
  readonly sha256: string;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ControlPlaneClient {
  register(input: {
    name: string;
    hostname?: string;
    version?: string;
    capabilities?: Record<string, unknown>;
  }): Promise<{ instanceId: string }>;
  heartbeatInstance(
    instanceId: string,
    stats: { itemsInFlight: number; itemsCompleted: number; itemsFailed: number },
  ): Promise<void>;
  lease(input: {
    workerName: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<LeasedItem[]>;
  heartbeatItems(
    itemIds: readonly string[],
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<{ alive: string[]; lost: string[] }>;
  markStarted(itemId: string, leaseToken: string): Promise<boolean>;
  isJobActive(jobId: string): Promise<boolean>;
  uploadMedia(input: {
    bytes: Uint8Array;
    filename: string;
    contentType: string;
    sourceUrl: string;
    viewportWidth?: number | null;
    viewportHeight?: number | null;
    deviceScaleFactor?: number | null;
    deviceProfile?: string | null;
    browserName?: string | null;
    browserVersion?: string | null;
    screenshotScope?: string | null;
    altText?: string | null;
  }): Promise<UploadedMedia>;
  report(payload: Record<string, unknown>): Promise<{
    accepted: boolean;
    willRetry?: boolean;
    reason?: string;
    contentItemId?: string | null;
    version?: number | null;
    changed?: boolean | null;
    discoveredQueued?: number;
  }>;
  /** Take a session waiting for a browser, if there is one. */
  claimSession(): Promise<ClaimedStudioSession | null>;
  /**
   * One turn of the studio conversation.
   *
   * Posts what just happened and what the page looks like now, and blocks until
   * there is something to do or the control plane's poll window closes. The
   * blocking is the point: it is what makes a click feel immediate over a
   * transport that is really just polling.
   */
  syncSession(
    sessionId: string,
    payload: Record<string, unknown>,
    frame: { bytes: Uint8Array; width: number; height: number } | null,
  ): Promise<StudioSyncResult>;
  /**
   * Post one live frame. Resolves `false` when the control plane says the
   * session is over, so the frame pump can stop.
   */
  postFrame(
    sessionId: string,
    leaseToken: string,
    frame: { bytes: Uint8Array; width: number; height: number },
  ): Promise<boolean>;
  /** Wait for pointer and wheel input from the studio. */
  takeInput(sessionId: string, leaseToken: string): Promise<StudioLiveInputResult>;
  /** Offer the logo photographed in the page header. */
  reportLogo(sessionId: string, leaseToken: string, mediaId: string): Promise<void>;
  /** Report a Screen the researcher captured. */
  reportScreen(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<{ contentItemId?: string; slug?: string; flowStepPosition?: number | null }>;
  getRobots(origin: string): Promise<unknown | null>;
  putRobots(payload: Record<string, unknown>): Promise<void>;
  logEvent(
    jobId: string,
    event: {
      level?: "debug" | "info" | "warn" | "error";
      code: string;
      message?: string;
      itemId?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface ControlPlaneOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** This worker's name, sent so provenance can attribute a capture to it. */
  readonly workerName: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export function createControlPlaneClient(options: ControlPlaneOptions): ControlPlaneClient {
  const base = `${options.baseUrl.replace(/\/$/, "")}/api/internal`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 4;

  /**
   * One request, with retries on transient failures only.
   *
   * A 4xx is our bug or a stale lease and must not be retried — retrying a
   * rejected report would loop forever. A 5xx or a network error is worth
   * retrying, because the control plane restarting during a deploy should cost
   * the worker a pause rather than a batch of lost captures.
   */
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: {
      formData?: FormData;
      /** A raw body, sent as is with its own type — for live frames. */
      raw?: { bytes: Uint8Array; contentType: string };
      headers?: Record<string, string>;
      retry?: boolean;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const url = `${base}${path}`;
    const retryable = init?.retry ?? true;
    let lastError: unknown;

    for (let attempt = 1; attempt <= (retryable ? maxRetries : 1); attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            accept: "application/json",
            "x-worker-name": options.workerName,
            ...(init?.raw
              ? { "content-type": init.raw.contentType }
              : init?.formData
                ? {}
                : body !== undefined
                  ? { "content-type": "application/json" }
                  : {}),
            ...init?.headers,
          },
          body: init?.raw
            ? init.raw.bytes
            : (init?.formData ?? (body !== undefined ? JSON.stringify(body) : undefined)),
          signal: AbortSignal.timeout(init?.timeoutMs ?? timeoutMs),
        });

        if (response.ok) {
          const text = await response.text();
          return (text.length > 0 ? JSON.parse(text) : {}) as T;
        }

        // 409 is the stale-lease signal. It is a normal outcome, not a fault:
        // the caller decides what to do and must not retry.
        if (response.status === 409) {
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          return payload as T;
        }

        const detail = await response.text().catch(() => "");
        if (response.status >= 400 && response.status < 500) {
          // The control plane says why in a sentence meant for a person
          // ("Linear was taken down…"). Carry it, so the studio can show it.
          let reason: string | null = null;
          try {
            const parsed = JSON.parse(detail) as { error?: { message?: unknown } };
            if (typeof parsed.error?.message === "string") reason = parsed.error.message.slice(0, 300);
          } catch {
            // Not JSON: the generic message below stands.
          }
          throw new AppError(
            response.status === 401 ? ErrorCode.UNAUTHENTICATED : ErrorCode.BAD_REQUEST,
            reason ?? `The control plane rejected ${method} ${path}`,
            { detail: `${response.status}: ${detail.slice(0, 500)}`, status: response.status },
          );
        }
        throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, "The control plane is unavailable", {
          detail: `${response.status}: ${detail.slice(0, 300)}`,
          retryable: true,
        });
      } catch (error) {
        lastError = error;
        const isClientError =
          AppError.is(error) && error.status >= 400 && error.status < 500;
        if (isClientError || attempt === maxRetries || !retryable) throw error;

        const delayMs = backoffDelay(attempt, 1_000, 30_000);
        options.logger.warn("Control-plane request failed; retrying", {
          method,
          path,
          attempt,
          delayMs,
          error,
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  return {
    async register(input) {
      return call("POST", "/workers/register", input);
    },

    async heartbeatInstance(instanceId, stats) {
      // A missed heartbeat is not worth retrying: the next one is seconds away.
      await call("POST", `/workers/${instanceId}/heartbeat`, stats, { retry: false }).catch(() => {});
    },

    async lease(input) {
      const result = await call<{ items: LeasedItem[] }>("POST", "/jobs/lease", input);
      return result.items ?? [];
    },

    async heartbeatItems(itemIds, leaseToken, leaseSeconds) {
      return call("POST", "/jobs/heartbeat", { itemIds: [...itemIds], leaseToken, leaseSeconds });
    },

    async markStarted(itemId, leaseToken) {
      const result = await call<{ accepted: boolean }>("POST", `/items/${itemId}/start`, {
        leaseToken,
      });
      return result.accepted;
    },

    async isJobActive(jobId) {
      const result = await call<{ active: boolean }>("GET", `/jobs/${jobId}/active`);
      return result.active;
    },

    async uploadMedia(input) {
      const form = new FormData();
      // The cast narrows Uint8Array<ArrayBufferLike> to Uint8Array<ArrayBuffer>,
      // which is what BlobPart requires since TS 5.7. These bytes always come
      // from a Playwright screenshot or a TextEncoder, never a SharedArrayBuffer.
      const part = input.bytes as Uint8Array<ArrayBuffer>;
      form.set("file", new Blob([part], { type: input.contentType }), input.filename);
      form.set("filename", input.filename);
      form.set("sourceUrl", input.sourceUrl);
      const optional: [string, unknown][] = [
        ["viewportWidth", input.viewportWidth],
        ["viewportHeight", input.viewportHeight],
        ["deviceScaleFactor", input.deviceScaleFactor],
        ["deviceProfile", input.deviceProfile],
        ["browserName", input.browserName],
        ["browserVersion", input.browserVersion],
        ["screenshotScope", input.screenshotScope],
        ["altText", input.altText],
      ];
      for (const [key, value] of optional) {
        if (value !== null && value !== undefined) form.set(key, String(value));
      }
      return call<UploadedMedia>("POST", "/media", undefined, { formData: form });
    },

    async report(payload) {
      return call("POST", "/items/report", payload);
    },

    async claimSession() {
      const result = await call<{ session: ClaimedStudioSession | null }>(
        "POST",
        "/sessions/claim",
        {},
        // No retry: another poll is a second away, and a retried claim during a
        // control-plane restart would take a session the operator has by then
        // given up on.
        { retry: false },
      );
      return result.session ?? null;
    },

    async syncSession(sessionId, payload, frame) {
      const form = new FormData();
      form.set("payload", JSON.stringify(payload));
      if (frame) {
        form.set("frame", new Blob([frame.bytes], { type: "image/jpeg" }), "frame.jpg");
        form.set("frameWidth", String(frame.width));
        form.set("frameHeight", String(frame.height));
      }
      // The server holds this open for its poll window, so the client timeout
      // has to exceed it or every idle turn would look like a network failure.
      return call<StudioSyncResult>("POST", `/sessions/${sessionId}/sync`, undefined, {
        formData: form,
        retry: false,
      });
    },

    async postFrame(sessionId, leaseToken, frame) {
      const result = await call<{ accepted?: boolean }>("POST", `/sessions/${sessionId}/frame`, undefined, {
        raw: { bytes: frame.bytes, contentType: "image/jpeg" },
        headers: {
          "x-lease-token": leaseToken,
          "x-frame-width": String(frame.width),
          "x-frame-height": String(frame.height),
        },
        // A frame is superseded within milliseconds; retrying a stale one is
        // worse than dropping it.
        retry: false,
        timeoutMs: 10_000,
      });
      return result.accepted !== false;
    },

    async takeInput(sessionId, leaseToken) {
      // Held open by the server until input arrives, so the timeout sits
      // comfortably above its poll window.
      return call<StudioLiveInputResult>("GET", `/sessions/${sessionId}/input`, undefined, {
        headers: { "x-lease-token": leaseToken },
        retry: false,
        timeoutMs: 30_000,
      });
    },

    async reportLogo(sessionId, leaseToken, mediaId) {
      await call("POST", `/sessions/${sessionId}/logo`, { leaseToken, mediaId }, { retry: false });
    },

    async reportScreen(sessionId, payload) {
      const result = await call<{
        contentItemId?: string;
        slug?: string;
        flowStepPosition?: number | null;
        error?: { message?: string };
      }>("POST", `/sessions/${sessionId}/screen`, payload, { retry: false });
      // A 409 comes back as a body rather than a throw (it is usually a stale
      // lease). A refused screen is still a failed capture, never a silent one.
      if (!result.contentItemId) {
        throw new AppError(ErrorCode.CONFLICT, result.error?.message ?? "The capture was not saved.");
      }
      return result;
    },

    async getRobots(origin) {
      const result = await call<{ rules: unknown | null }>(
        "GET",
        `/robots?origin=${encodeURIComponent(origin)}`,
      );
      return result.rules;
    },

    async putRobots(payload) {
      await call("POST", "/robots", payload, { retry: false }).catch(() => {});
    },

    async logEvent(jobId, event) {
      // Losing a log line must never fail a capture.
      await call("POST", `/jobs/${jobId}/events`, event, { retry: false }).catch(() => {});
    },
  };
}
