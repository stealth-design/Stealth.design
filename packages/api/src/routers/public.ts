/**
 * The public read API (§18, §19).
 *
 * Read-only, unauthenticated, and the frontend's only data source. Four
 * properties hold across every route here:
 *
 *   1. No writes. There is no POST, PUT, PATCH or DELETE in this router.
 *   2. Only published content, enforced at the SQL level by
 *      `publishedContentCondition()` inside `queries/public.ts`.
 *   3. Only allowlisted fields, enforced by the serialisers, which construct
 *      their output rather than filtering a row.
 *   4. No internal metadata: no crawl logs, no reviewer names, no rights notes,
 *      no storage keys, no error messages (§19).
 *
 * Because it is public and cacheable, every response carries an explicit
 * `Cache-Control` so a CDN in front of it does the right thing without further
 * configuration.
 */
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { CONTENT_KINDS, ENABLED_MODULE_KEYS, publicFacetKinds } from "@uxd/types";
import { AppError, ErrorCode, MAX_PAGE_SIZE, sha256Hex, urlHash } from "@uxd/shared";
import type { BaseContext } from "../context.js";
import { validate } from "../errors.js";
import { type MediaUrlOptions, publicMediaBaseUrl } from "../queries/public.js";
import { publicList } from "../serializers.js";
import {
  findPublicContentByUrl,
  getPublicContent,
  getPublicFlow,
  getPublicSource,
  listPublicCollections,
  listPublicContent,
  listPublicFacets,
  listPublicSources,
} from "../queries/public.js";

export interface PublicApiDeps {
  readonly baseContext: (requestId: string, ip: string | null, userAgent: string | null) => BaseContext;
  /** Origins allowed to call this cross-origin. The frontend's origin. */
  readonly allowedOrigins: readonly string[];
}

type Env = { Variables: { ctx: BaseContext } };

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(CONTENT_KINDS).optional(),
  module: z.enum(ENABLED_MODULE_KEYS as [string, ...string[]]).optional(),
  source: z.string().max(120).optional(),
  collection: z.string().max(120).optional(),
  // Repeated `term` parameters stack as an AND filter.
  term: z.union([z.string().max(120), z.array(z.string().max(120))]).optional(),
  platform: z.string().max(40).optional(),
  device: z.string().max(40).optional(),
  sort: z.enum(["recent", "captured", "title"]).default("recent"),
  /** `featured=true`: only what is in its website's featured section. */
  featured: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
});

/**
 * Cache headers. Not cached by the CDN in front of the CMS: the public site
 * keeps its own copy and is told to refresh the moment something is
 * published, and a CDN copy here would hand it the old answer back for
 * minutes afterwards. Browsers may keep a list for a few seconds.
 */
const CACHE = {
  list: "public, max-age=5, s-maxage=0",
  detail: "public, max-age=5, s-maxage=0",
  reference: "public, max-age=5, s-maxage=0",
} as const;

export function createPublicApi(deps: PublicApiDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use(
    "*",
    cors({
      origin: [...deps.allowedOrigins],
      allowMethods: ["GET", "HEAD", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 86_400,
    }),
  );

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set(
      "ctx",
      deps.baseContext(
        requestId,
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        c.req.header("user-agent") ?? null,
      ),
    );
    await next();
    c.header("x-request-id", requestId);
    // The public API never returns anything user-specific, so no response can
    // legitimately vary by cookie — and saying so stops a CDN from guessing.
    c.header("vary", "origin, accept-encoding");
  });

  /**
   * How this response should build media URLs.
   *
   * Derived per request from the storage configuration rather than captured
   * once, so a deployment that changes `STORAGE_DRIVER` does not need a
   * restart-order dance to get correct URLs.
   */
  const mediaUrlOptions = (ctx: BaseContext): MediaUrlOptions => ({
    publicBaseUrl: publicMediaBaseUrl(ctx.env),
  });

  /** Machine-readable description of what this API offers. */
  app.get("/", (c) => {
    c.header("cache-control", CACHE.reference);
    return c.json({
      name: "UX Disrupt public API",
      version: "v1",
      description:
        "Read-only access to published design-research content. Everything returned here originates from a CMS record that a person approved and published.",
      endpoints: {
        content: "/content",
        contentDetail: "/content/:idOrSlug",
        screens: "/screens",
        screenDetail: "/screens/:idOrSlug",
        flows: "/flows",
        flowDetail: "/flows/:idOrSlug",
        sources: "/sources",
        sourceDetail: "/sources/:slug",
        facets: "/facets",
        collections: "/collections",
        lookupByUrl: "/lookup?url=",
      },
      contentKinds: CONTENT_KINDS,
      modules: ENABLED_MODULE_KEYS,
      facetKinds: publicFacetKinds(),
    });
  });

  /**
   * Liveness for a load balancer.
   *
   * Reports whether the database is reachable, because a public API that can
   * serve its own routes but cannot read content is not healthy — and a
   * balancer that keeps sending it traffic makes an outage look like
   * intermittent 500s rather than a down instance.
   */
  app.get("/health", async (c) => {
    const ctx = c.get("ctx");
    c.header("cache-control", "no-store");
    try {
      await ctx.db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, reason: "database unreachable" }, 503);
    }
  });

  /** Browse published content, with search and facet filters. */
  app.get("/content", validate("query", listQuerySchema), async (c) => {
    const ctx = c.get("ctx");
    const query = c.req.valid("query");
    const termSlugs = query.term === undefined ? [] : Array.isArray(query.term) ? query.term : [query.term];

    const { items, total } = await listPublicContent(ctx.db, ctx.storage, {
      q: query.q,
      kind: query.kind,
      module: query.module,
      sourceSlug: query.source,
      collectionSlug: query.collection,
      termSlugs,
      featured: query.featured === "true",
      platform: query.platform,
      deviceClass: query.device,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
    }, mediaUrlOptions(ctx));

    c.header("cache-control", CACHE.list);
    return c.json(publicList(items, total, query.page, query.pageSize));
  });

  /**
   * One record, by id or slug.
   *
   * Accepts either so a URL can be readable (`/content/stripe-pricing`) while
   * an id still resolves for anything that stored one.
   */
  app.get("/content/:idOrSlug", async (c) => {
    const ctx = c.get("ctx");
    const idOrSlug = c.req.param("idOrSlug");
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const content = await getPublicContent(
      ctx.db,
      ctx.storage,
      isUuid ? { id: idOrSlug } : { slug: idOrSlug },
      mediaUrlOptions(ctx),
    );
    if (!content) throw new AppError(ErrorCode.NOT_FOUND, "Not found");

    c.header("cache-control", CACHE.detail);
    return c.json(content);
  });

  /**
   * Published Screens.
   *
   * A thin pin on `/content`, not a parallel implementation. Screens are the
   * kind of content this product is mostly about, and a named endpoint is
   * kinder than telling every caller to remember `?kind=screen` — but the
   * publish filter, the facet logic and the serializer are the same ones, so
   * there is no second place for the "is this public?" rule to drift.
   */
  app.get("/screens", validate("query", listQuerySchema), async (c) => {
    const ctx = c.get("ctx");
    const query = c.req.valid("query");
    const termSlugs = query.term === undefined ? [] : Array.isArray(query.term) ? query.term : [query.term];

    const { items, total } = await listPublicContent(
      ctx.db,
      ctx.storage,
      {
        q: query.q,
        kind: "screen",
        module: query.module,
        sourceSlug: query.source,
        collectionSlug: query.collection,
        termSlugs,
        featured: query.featured === "true",
        platform: query.platform,
        deviceClass: query.device,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      },
      mediaUrlOptions(ctx),
    );

    c.header("cache-control", CACHE.list);
    return c.json(publicList(items, total, query.page, query.pageSize));
  });

  app.get("/screens/:idOrSlug", async (c) => {
    const ctx = c.get("ctx");
    const idOrSlug = c.req.param("idOrSlug");
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const content = await getPublicContent(
      ctx.db,
      ctx.storage,
      isUuid ? { id: idOrSlug } : { slug: idOrSlug, kind: "screen" },
      mediaUrlOptions(ctx),
    );
    if (!content || content.kind !== "screen") throw new AppError(ErrorCode.NOT_FOUND, "Not found");

    c.header("cache-control", CACHE.detail);
    return c.json(content);
  });

  /** Published flows. Same pinning as `/screens`. */
  app.get("/flows", validate("query", listQuerySchema), async (c) => {
    const ctx = c.get("ctx");
    const query = c.req.valid("query");

    const { items, total } = await listPublicContent(
      ctx.db,
      ctx.storage,
      {
        q: query.q,
        kind: "flow",
        module: query.module,
        sourceSlug: query.source,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      },
      mediaUrlOptions(ctx),
    );

    c.header("cache-control", CACHE.list);
    return c.json(publicList(items, total, query.page, query.pageSize));
  });

  /** A flow and its ordered steps, for the simple flow viewer (§32). */
  app.get("/flows/:idOrSlug", async (c) => {
    const ctx = c.get("ctx");
    const idOrSlug = c.req.param("idOrSlug");
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const flow = await getPublicFlow(
      ctx.db,
      ctx.storage,
      isUuid ? { id: idOrSlug } : { slug: idOrSlug },
      mediaUrlOptions(ctx),
    );
    if (!flow) throw new AppError(ErrorCode.NOT_FOUND, "Not found");

    c.header("cache-control", CACHE.detail);
    return c.json(flow);
  });

  app.get(
    "/sources",
    validate(
      "query",
      z.object({
        module: z.string().max(40).optional(),
        page: z.coerce.number().int().min(1).max(1_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
      }),
    ),
    async (c) => {
      const ctx = c.get("ctx");
      const query = c.req.valid("query");
      const { items, total } = await listPublicSources(ctx.db, query, { storage: ctx.storage, options: mediaUrlOptions(ctx) });
      c.header("cache-control", CACHE.list);
      return c.json(publicList(items, total, query.page, query.pageSize));
    },
  );

  app.get("/sources/:slug", async (c) => {
    const ctx = c.get("ctx");
    const source = await getPublicSource(ctx.db, c.req.param("slug"), { storage: ctx.storage, options: mediaUrlOptions(ctx) });
    if (!source) throw new AppError(ErrorCode.NOT_FOUND, "Not found");
    c.header("cache-control", CACHE.detail);
    return c.json(source);
  });

  /** Facets with published-content counts, for the frontend's filters. */
  app.get(
    "/facets",
    validate("query", z.object({ kind: z.union([z.string(), z.array(z.string())]).optional() })),
    async (c) => {
      const ctx = c.get("ctx");
      const kindParam = c.req.valid("query").kind;
      const kinds = kindParam === undefined ? undefined : Array.isArray(kindParam) ? kindParam : [kindParam];
      const facets = await listPublicFacets(ctx.db, { kinds });
      c.header("cache-control", CACHE.reference);
      return c.json({ facets });
    },
  );

  app.get("/collections", async (c) => {
    const ctx = c.get("ctx");
    const collections = await listPublicCollections(ctx.db);
    c.header("cache-control", CACHE.reference);
    return c.json({ items: collections });
  });

  /**
   * Resolve a captured URL to its public record.
   *
   * Useful for "do you have this page?" integrations. It reveals only whether
   * a *published* record exists — an unpublished capture returns 404 exactly
   * like an unknown URL, so this cannot be used to probe what is in the
   * ingestion pipeline.
   */
  app.get("/lookup", validate("query", z.object({ url: z.string().min(1).max(2048) })), async (c) => {
    const ctx = c.get("ctx");
    const hash = urlHash(c.req.valid("query").url, {});
    if (!hash) throw new AppError(ErrorCode.URL_INVALID, "That is not a URL we can parse.");

    const found = await findPublicContentByUrl(ctx.db, hash);
    c.header("cache-control", CACHE.detail);
    if (!found) return c.json({ found: false }, 404);
    return c.json({ found: true, id: found.id, slug: found.slug, kind: found.kind });
  });

  /** Anything else is a 404 in the API's own error shape. */
  app.notFound((c) => {
    c.header("cache-control", "no-store");
    return c.json({ error: { code: ErrorCode.NOT_FOUND, message: "Not found" } }, 404);
  });

  return app;
}

/** Weak ETag for a public payload, so a CDN can revalidate cheaply. */
export function etagFor(payload: unknown): string {
  return `W/"${sha256Hex(JSON.stringify(payload)).slice(0, 32)}"`;
}
