/**
 * Typed client for the public API.
 *
 * This module is the frontend's *entire* data layer, and it is deliberately
 * tiny and dependency-free: `fetch`, and the public response types. It imports
 * nothing from `@uxd/database`, `@uxd/auth` or `@uxd/media`, which is what lets
 * the boundary check assert that the public site cannot reach the database even
 * in principle (§18).
 *
 * It is exported from `@uxd/api/client`, a separate entry point from
 * `@uxd/api`, so importing it cannot accidentally pull in the server.
 */

// The public shapes, re-declared here rather than imported from the server
// module. Duplication is the point: this file must not import anything that
// transitively reaches the database.

export interface PublicMedia {
  readonly id: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly altText: string | null;
  readonly caption: string | null;
  /** The unmodified master file. `originalUrl` is the same value, named. */
  readonly url: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string | null;
  readonly previewUrl: string | null;
  /** The widest rendition, 2048px. */
  readonly largeUrl: string | null;
  readonly viewportWidth: number | null;
  readonly viewportHeight: number | null;
  readonly deviceClass: string | null;
}

export interface PublicTaxonomyTerm {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly slug: string;
  readonly path: string;
  readonly description: string | null;
}

export interface PublicSourceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly domain: string | null;
  readonly companyName: string | null;
  readonly productName: string | null;
  readonly type: string;
  readonly module: string;
  /** The website's logo, a raster image; null when it has none. */
  readonly logoUrl: string | null;
  /** The website itself — where "View website" goes. Always http(s). */
  readonly websiteUrl: string | null;
}

export interface PublicSourceDetail extends PublicSourceSummary {
  readonly description: string | null;
  readonly canonicalUrl: string | null;
  readonly attribution: string | null;
}

export interface PublicContentSummary {
  readonly id: string;
  readonly kind: string;
  readonly module: string;
  readonly title: string;
  readonly slug: string;
  readonly description: string | null;
  readonly sourceUrl: string | null;
  readonly platform: string | null;
  readonly deviceClass: string | null;
  readonly publishedAt: string | null;
  /** In its website's featured section. */
  readonly featured: boolean;
  readonly source: PublicSourceSummary | null;
  readonly primaryMedia: PublicMedia | null;
  readonly attribution: string | null;
  /** Present on screens: what makes this state its own record. */
  readonly stateLabel: string | null;
}

export interface PublicFlowSummary {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly description: string | null;
  readonly stepCount: number;
}

/** The capture conditions of a screen. Absent on every other kind. */
export interface PublicScreenFacts {
  readonly screenName: string | null;
  readonly stateLabel: string | null;
  readonly deviceProfile: string | null;
  readonly viewportWidth: number | null;
  readonly viewportHeight: number | null;
  readonly deviceScaleFactor: number | null;
}

export interface PublicContentDetail extends PublicContentSummary {
  readonly screen: PublicScreenFacts | null;
  readonly media: readonly PublicMedia[];
  readonly taxonomy: readonly PublicTaxonomyTerm[];
  readonly relatedContent: readonly PublicContentSummary[];
  readonly flows: readonly PublicFlowSummary[];
  readonly states: readonly PublicContentSummary[];
  readonly interactions: readonly PublicContentSummary[];
  readonly parent: PublicContentSummary | null;
  readonly experience: PublicContentSummary | null;
}

export interface PublicFlowDetail extends PublicFlowSummary {
  readonly goal: string | null;
  readonly source: PublicSourceSummary | null;
  readonly steps: readonly {
    readonly position: number;
    readonly label: string | null;
    readonly content: PublicContentSummary;
  }[];
}

export interface PublicListResponse<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export interface PublicFacetGroup {
  readonly kind: string;
  readonly terms: readonly { readonly term: PublicTaxonomyTerm; readonly count: number }[];
}

export interface PublicCollection {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly itemCount: number;
}

export interface ContentQuery {
  readonly q?: string;
  readonly kind?: string;
  readonly module?: string;
  readonly source?: string;
  readonly collection?: string;
  readonly term?: readonly string[];
  readonly platform?: string;
  readonly device?: string;
  readonly sort?: "recent" | "captured" | "title";
  /** Only what is in its website's featured section. */
  readonly featured?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

/** An API error, with the code and message the server chose to expose. */
export class PublicApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface PublicApiClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** Next.js revalidation seconds, passed through to `fetch`. */
  readonly revalidate?: number | false;
  readonly userAgent?: string;
}

export interface PublicApiClient {
  listContent(query?: ContentQuery): Promise<PublicListResponse<PublicContentSummary>>;
  getContent(idOrSlug: string): Promise<PublicContentDetail | null>;
  /** Published screens. The same filters as `listContent`, pinned to the kind. */
  listScreens(query?: ContentQuery): Promise<PublicListResponse<PublicContentSummary>>;
  getScreen(idOrSlug: string): Promise<PublicContentDetail | null>;
  listFlows(query?: ContentQuery): Promise<PublicListResponse<PublicContentSummary>>;
  getFlow(idOrSlug: string): Promise<PublicFlowDetail | null>;
  listSources(query?: { module?: string; page?: number; pageSize?: number }): Promise<
    PublicListResponse<PublicSourceSummary & { publishedCount: number }>
  >;
  getSource(slug: string): Promise<PublicSourceDetail | null>;
  listFacets(kinds?: readonly string[]): Promise<readonly PublicFacetGroup[]>;
  listCollections(): Promise<readonly PublicCollection[]>;
  lookupByUrl(url: string): Promise<{ id: string; slug: string | null; kind: string } | null>;
  health(): Promise<boolean>;
}

export function createPublicApiClient(options: PublicApiClientOptions): PublicApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value)) {
          // Repeated parameters, which is how the API expresses stacked filters.
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        // `next.revalidate` is ignored outside Next.js, so this client works
        // in a plain Node script and in a server component alike.
        ...(options.revalidate !== undefined
          ? { next: { revalidate: options.revalidate } }
          : {}),
      } as RequestInit);
    } catch (cause) {
      const isTimeout = cause instanceof Error && /timeout|abort/i.test(cause.message);
      throw new PublicApiError(
        503,
        isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        isTimeout
          ? "The content API did not respond in time."
          : "Could not reach the content API.",
        null,
      );
    }

    const requestId = response.headers.get("x-request-id");

    if (!response.ok) {
      // A 4xx is this caller's mistake — a bad slug, a page size over the
      // limit — and calling it "upstream unavailable" sends whoever reads the
      // log looking at the wrong machine. Only a 5xx is the API's problem.
      let code = response.status >= 500 ? "UPSTREAM_ERROR" : "BAD_REQUEST";
      let message =
        response.status >= 500
          ? `The content API returned ${response.status}.`
          : `The content API rejected this request (${response.status}).`;
      try {
        const body = (await response.json()) as {
          error?: { code?: string; message?: string; detail?: string; issues?: unknown };
        };
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
        // A validation failure names the field. Without it the caller is left
        // guessing which of eight query parameters was wrong.
        if (body.error?.detail) message = `${message} ${body.error.detail}`;
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      throw new PublicApiError(response.status, code, message, requestId);
    }

    return (await response.json()) as T;
  }

  /** Turn a 404 into null, since "not found" is a normal page outcome. */
  async function optional<T>(promise: Promise<T>): Promise<T | null> {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof PublicApiError && error.isNotFound) return null;
      throw error;
    }
  }

  return {
    listContent(query = {}) {
      return request<PublicListResponse<PublicContentSummary>>("/content", {
        q: query.q,
        kind: query.kind,
        module: query.module,
        source: query.source,
        collection: query.collection,
        term: query.term,
        platform: query.platform,
        device: query.device,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      });
    },

    getContent(idOrSlug) {
      return optional(request<PublicContentDetail>(`/content/${encodeURIComponent(idOrSlug)}`));
    },

    listScreens(query = {}) {
      return request<PublicListResponse<PublicContentSummary>>("/screens", {
        q: query.q,
        module: query.module,
        source: query.source,
        collection: query.collection,
        term: query.term,
        platform: query.platform,
        device: query.device,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      });
    },

    getScreen(idOrSlug) {
      return optional(request<PublicContentDetail>(`/screens/${encodeURIComponent(idOrSlug)}`));
    },

    listFlows(query = {}) {
      return request<PublicListResponse<PublicContentSummary>>("/flows", {
        q: query.q,
        source: query.source,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      });
    },

    getFlow(idOrSlug) {
      return optional(request<PublicFlowDetail>(`/flows/${encodeURIComponent(idOrSlug)}`));
    },

    listSources(query = {}) {
      return request<PublicListResponse<PublicSourceSummary & { publishedCount: number }>>(
        "/sources",
        query,
      );
    },

    getSource(slug) {
      return optional(request<PublicSourceDetail>(`/sources/${encodeURIComponent(slug)}`));
    },

    async listFacets(kinds) {
      const result = await request<{ facets: readonly PublicFacetGroup[] }>("/facets", {
        kind: kinds,
      });
      return result.facets;
    },

    async listCollections() {
      const result = await request<{ items: readonly PublicCollection[] }>("/collections");
      return result.items;
    },

    async lookupByUrl(url) {
      const result = await optional(
        request<{ found: boolean; id: string; slug: string | null; kind: string }>("/lookup", { url }),
      );
      return result?.found ? { id: result.id, slug: result.slug, kind: result.kind } : null;
    },

    async health() {
      try {
        const result = await request<{ ok: boolean }>("/health");
        return result.ok;
      } catch {
        return false;
      }
    },
  };
}
