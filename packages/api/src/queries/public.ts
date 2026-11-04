/**
 * Public API queries (§19).
 *
 * Every function here starts from `publishedContentCondition()`. There is no
 * parameter to relax it, no flag to include drafts, and no code path in this
 * file that queries `content_items` without it — which is what makes "the
 * public API only returns published/approved content" a property of the module
 * rather than a rule each handler has to remember.
 *
 * The condition is derived from `publishedContentFilter()` in `@uxd/types`, the
 * same function the publishing gate reads, so the SQL filter and the
 * application-level `isPubliclyVisible` check cannot drift apart. There is a
 * test asserting they select the same rows for every status/rights combination.
 */
import { type SQL, and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  type Db,
  collectionItems,
  collections,
  contentItems,
  flowDetails,
  flowSteps,
  mediaAssets,
  mediaDerivatives,
  mediaUsages,
  pageDetails,
  screenDetails,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
} from "@uxd/database";
import type { StorageDriver } from "@uxd/media";
import {
  type ContentKind,
  HUMAN_CONFIRMED_ORIGINS,
  publishedContentFilter,
} from "@uxd/types";
import {
  type MediaUrls,
  type PublicContentDetail,
  type PublicContentSummary,
  type PublicFlowDetail,
  serialiseContentDetail,
  serialiseContentSummary,
  serialiseFlowDetail,
  serialiseFlowSummary,
  serialiseMedia,
  serialiseSource,
  serialiseTerm,
} from "../serializers.js";

/**
 * The one condition every public content query applies.
 *
 * Built from the shared filter definition, not hand-written, so adding a
 * publish-blocking rights status updates the SQL automatically.
 */
export function publishedContentCondition(): SQL {
  const filter = publishedContentFilter();
  return and(
    inArray(contentItems.status, [...filter.statuses]),
    notInArray(contentItems.rightsStatus, [...filter.excludedRightsStatuses]),
    isNull(contentItems.deletedAt),
  )!;
}

/** Media a public response may reference: ready, not archived, not deleted. */
/** The website columns every public read selects. */
const publicSourceColumns = {
  id: sources.id,
  name: sources.name,
  slug: sources.slug,
  domain: sources.domain,
  companyName: sources.companyName,
  productName: sources.productName,
  type: sources.type,
  module: sources.module,
  canonicalUrl: sources.canonicalUrl,
  logoMediaId: sources.logoMediaId,
};

/**
 * Resolves websites' logos to public URLs, in one batch.
 *
 * The `preview` rendition, not the thumbnail: thumbnails are cropped to the
 * card's shape, which would cut a square logo. SVG never gets a URL — it is
 * not served inline from our origin (see the public media route).
 */
async function buildLogoResolver(
  db: Db,
  storage: StorageDriver,
  logoMediaIds: readonly (string | null | undefined)[],
  options: MediaUrlOptions = {},
): Promise<(mediaId: string | null | undefined) => string | null> {
  const ids = [...new Set(logoMediaIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return () => null;
  const usable = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.id, ids), publicMediaCondition(), sql`${mediaAssets.mimeType} <> 'image/svg+xml'`));
  const resolve = await buildMediaUrlResolver(
    db,
    storage,
    usable.map((row) => row.id),
    options,
  );
  return (mediaId) => {
    if (!mediaId) return null;
    const urls = resolve(mediaId);
    return urls ? (urls.previewUrl ?? urls.originalUrl) || null : null;
  };
}

function publicMediaCondition(): SQL {
  return and(
    eq(mediaAssets.status, "ready"),
    isNull(mediaAssets.deletedAt),
    isNull(mediaAssets.archivedAt),
  )!;
}

/**
 * Only human-confirmed classifications reach the public API.
 *
 * §14 requires the CMS to distinguish AI Suggested from Human Verified, and the
 * consequence for the public surface is that an unreviewed machine guess is not
 * published as if it were a curated fact.
 */
function publicTaxonomyCondition(): SQL {
  return and(
    inArray(taxonomyAssignments.origin, [...HUMAN_CONFIRMED_ORIGINS]),
    eq(taxonomyTerms.status, "active"),
  )!;
}

// --- Media URL resolution -------------------------------------------------

export interface MediaUrlResolver {
  (mediaId: string): MediaUrls | null;
}

/**
 * Build a URL resolver for a batch of media rows.
 *
 * Resolving URLs one at a time would mean a presign round trip per image, so a
 * 24-item grid would issue 72 of them. This resolves the whole page at once.
 */
export async function buildMediaUrlResolver(
  db: Db,
  storage: StorageDriver,
  mediaIds: readonly string[],
  options: { readonly publicBaseUrl?: string } = {},
): Promise<MediaUrlResolver> {
  if (mediaIds.length === 0) return () => null;

  const [assets, derivatives] = await Promise.all([
    db
      .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, [...mediaIds])),
    db
      .select({
        mediaId: mediaDerivatives.mediaId,
        kind: mediaDerivatives.kind,
        storageKey: mediaDerivatives.storageKey,
      })
      .from(mediaDerivatives)
      .where(inArray(mediaDerivatives.mediaId, [...mediaIds])),
  ]);

  const keysToSign = new Set<string>();
  for (const asset of assets) keysToSign.add(asset.storageKey);
  for (const derivative of derivatives) keysToSign.add(derivative.storageKey);

  const urlByKey = new Map<string, string>();

  if (options.publicBaseUrl) {
    // The driver's own `url()` is not usable here. With the local driver it
    // points at the CMS's *session-gated* media route, so the public API would
    // be advertising URLs the public cannot fetch — which is not a cosmetic
    // problem: it makes the whole public surface serve broken images. So the
    // caller supplies the base of a route that applies the publish gate
    // instead, and URLs are built against that.
    //
    // With S3 and a public bucket or CDN this is left unset and the driver's
    // `url()` is correct, because the object is directly fetchable.
    const base = options.publicBaseUrl.replace(/\/$/, "");
    for (const key of keysToSign) urlByKey.set(key, `${base}/${key}`);
  } else {
    await Promise.all(
      [...keysToSign].map(async (key) => {
        urlByKey.set(key, await storage.url(key));
      }),
    );
  }

  const originalByMedia = new Map(assets.map((a) => [a.id, a.storageKey]));
  const derivativeByMedia = new Map<string, Map<string, string>>();
  for (const derivative of derivatives) {
    const forMedia = derivativeByMedia.get(derivative.mediaId) ?? new Map<string, string>();
    forMedia.set(derivative.kind, derivative.storageKey);
    derivativeByMedia.set(derivative.mediaId, forMedia);
  }

  return (mediaId: string): MediaUrls | null => {
    const originalKey = originalByMedia.get(mediaId);
    if (!originalKey) return null;
    const derivativesForMedia = derivativeByMedia.get(mediaId);
    const thumbKey = derivativesForMedia?.get("thumbnail");
    const previewKey = derivativesForMedia?.get("preview");
    // `large` is generated for every wide capture and used to be reachable
    // only as a fallback for a missing `preview` — which never happened, so
    // the widest rendition the site could serve was 1024px while a 2048px one
    // sat in storage. It is its own field now, and the frontend picks between
    // them by rendered size.
    const largeKey = derivativesForMedia?.get("large");
    const original = urlByKey.get(originalKey) ?? "";
    return {
      url: original,
      originalUrl: original,
      thumbnailUrl: thumbKey ? (urlByKey.get(thumbKey) ?? null) : null,
      previewUrl: previewKey ? (urlByKey.get(previewKey) ?? null) : null,
      largeUrl: largeKey ? (urlByKey.get(largeKey) ?? null) : null,
    };
  };
}

// --- Content listing ------------------------------------------------------

/**
 * How a public response should build its media URLs.
 *
 * Threaded explicitly rather than read from a global, so the compiler names
 * every caller that has to make the decision.
 */
export interface MediaUrlOptions {
  readonly publicBaseUrl?: string;
}

/**
 * Where public media is served from, given the storage configuration.
 *
 * With the local driver, the CMS's own public media route — which re-applies
 * the publish gate per request. With S3, nothing: the driver's `url()` already
 * produces a directly fetchable URL, presigned or via the configured CDN.
 *
 * One function so the two cases cannot drift apart, and so a third driver has
 * exactly one place to declare its answer.
 */
export function publicMediaBaseUrl(env: {
  readonly STORAGE_DRIVER: string;
  readonly CMS_BASE_URL: string;
  readonly STORAGE_PUBLIC_BASE_URL?: string;
}): string | undefined {
  // Served through the CMS's publish-gated route unless the bucket has its own
  // public address (a CDN). That covers `local`, `blob`, and a *private* S3
  // bucket such as Neon Object Storage, whose presigned links expire after an
  // hour: the public site caches pages for longer than that, so handing those
  // out would leave visitors with broken images.
  return mediaServedByCms(env) ? `${env.CMS_BASE_URL.replace(/\/$/, "")}/api/public/media` : undefined;
}

/** Whether media bytes are streamed by the CMS rather than linked directly. */
export function mediaServedByCms(env: {
  readonly STORAGE_DRIVER: string;
  readonly STORAGE_PUBLIC_BASE_URL?: string;
}): boolean {
  return env.STORAGE_DRIVER !== "s3" || !env.STORAGE_PUBLIC_BASE_URL;
}

export interface PublicContentQuery {
  readonly q?: string;
  readonly kind?: ContentKind;
  readonly module?: string;
  readonly sourceSlug?: string;
  readonly termSlugs?: readonly string[];
  /** Only what is in its website's featured section, most recently featured first. */
  readonly featured?: boolean;
  readonly platform?: string;
  readonly deviceClass?: string;
  readonly collectionSlug?: string;
  readonly sort?: "recent" | "captured" | "title";
  readonly page: number;
  readonly pageSize: number;
}

export async function listPublicContent(
  db: Db,
  storage: StorageDriver,
  query: PublicContentQuery,
  options: MediaUrlOptions = {},
): Promise<{ items: PublicContentSummary[]; total: number }> {
  const conditions: SQL[] = [publishedContentCondition()];

  if (query.kind) conditions.push(eq(contentItems.kind, query.kind));
  if (query.module) conditions.push(sql`${contentItems.module} = ${query.module}`);
  if (query.platform) conditions.push(sql`${contentItems.platform} = ${query.platform}`);
  if (query.deviceClass) conditions.push(sql`${contentItems.deviceClass} = ${query.deviceClass}`);

  if (query.sourceSlug) {
    conditions.push(
      sql`${contentItems.sourceId} in (select id from ${sources} where ${sources.slug} = ${query.sourceSlug} and ${sources.deletedAt} is null)`,
    );
  }

  if (query.q && query.q.trim().length > 0) {
    // V1 searches by company only: everything published is a hero section, so
    // "which company?" is the question a visitor is asking. Matched on the
    // product's name, its company name and its website.
    const term = `%${query.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      sql`${contentItems.sourceId} in (
        select s.id from ${sources} s
         where s.deleted_at is null
           and (s.name ilike ${term} or s.company_name ilike ${term} or s.domain ilike ${term} or s.site ilike ${term})
      )`,
    );
  }

  if (query.featured) conditions.push(sql`${contentItems.featuredAt} is not null`);

  // Faceting by taxonomy: a record must carry every requested term (AND, not
  // OR), which is what makes stacked filters narrow rather than widen.
  if (query.termSlugs && query.termSlugs.length > 0) {
    for (const slug of query.termSlugs.slice(0, 10)) {
      // A term counts whether it is on the screen itself or on the website
      // the screen is from: Industry is set once per website, and every one
      // of its screens should be found under it.
      conditions.push(sql`exists (
        select 1
        from ${taxonomyAssignments} ta
        join ${taxonomyTerms} tt on tt.id = ta.term_id
        where (ta.content_item_id = ${contentItems.id} or ta.source_id = ${contentItems.sourceId})
          and tt.slug = ${slug}
          and tt.status = 'active'
          and ta.origin in ${sql`(${sql.join(HUMAN_CONFIRMED_ORIGINS.map((o) => sql`${o}`), sql`, `)})`}
      )`);
    }
  }

  if (query.collectionSlug) {
    conditions.push(sql`exists (
      select 1 from ${collectionItems} ci
      join ${collections} c on c.id = ci.collection_id
      where ci.content_item_id = ${contentItems.id}
        and c.slug = ${query.collectionSlug}
        and c.visibility = 'public'
        and c.status = 'active'
        and c.deleted_at is null
    )`);
  }

  const where = and(...conditions);
  // "captured" is still accepted from old links, but ordering by capture date
  // would reveal it, so it reads as "recent".
  const orderBy = query.featured
    ? desc(contentItems.featuredAt)
    : query.sort === "title"
      ? asc(contentItems.title)
      : desc(contentItems.publishedAt);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        content: contentItems,
        // Left-joined rather than filtered: the same list serves pages, flows
        // and screens, and only screens have a state.
        stateLabel: screenDetails.stateLabel,
        source: publicSourceColumns,
      })
      .from(contentItems)
      .leftJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .leftJoin(sources, eq(sources.id, contentItems.sourceId))
      .where(where)
      .orderBy(orderBy, desc(contentItems.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(contentItems).where(where),
  ]);

  const mediaIds = rows.map((r) => r.content.primaryMediaId).filter((id): id is string => id !== null);
  const [resolveUrls, mediaRows, resolveLogo] = await Promise.all([
    buildMediaUrlResolver(db, storage, mediaIds, options),
    loadPublicMedia(db, mediaIds),
    buildLogoResolver(db, storage, rows.map((r) => r.source?.logoMediaId), options),
  ]);

  return {
    items: rows.map((row) =>
      serialiseContentSummary(
        { ...row.content, stateLabel: row.stateLabel },
        {
          source: row.source?.id ? serialiseSource(row.source, resolveLogo) : null,
          primaryMedia: row.content.primaryMediaId
            ? buildMedia(mediaRows, row.content.primaryMediaId, resolveUrls)
            : null,
        },
      ),
    ),
    total: countRows[0]?.n ?? 0,
  };
}

type PublicMediaRow = Awaited<ReturnType<typeof loadPublicMedia>>[number];

async function loadPublicMedia(db: Db, mediaIds: readonly string[]) {
  if (mediaIds.length === 0) return [];
  return db
    .select({
      id: mediaAssets.id,
      kind: mediaAssets.kind,
      mimeType: mediaAssets.mimeType,
      width: mediaAssets.width,
      height: mediaAssets.height,
      altText: mediaAssets.altText,
      caption: mediaAssets.caption,
      capturedAt: mediaAssets.capturedAt,
      viewportWidth: mediaAssets.viewportWidth,
      viewportHeight: mediaAssets.viewportHeight,
      deviceClass: mediaAssets.deviceClass,
      status: mediaAssets.status,
    })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.id, [...mediaIds]), publicMediaCondition()));
}

function buildMedia(
  rows: readonly PublicMediaRow[],
  mediaId: string,
  resolveUrls: MediaUrlResolver,
) {
  const row = rows.find((r) => r.id === mediaId);
  if (!row) return null;
  const urls = resolveUrls(mediaId);
  if (!urls) return null;
  return serialiseMedia(row, urls);
}

// --- Content detail -------------------------------------------------------

export async function getPublicContent(
  db: Db,
  storage: StorageDriver,
  identifier: { readonly id?: string; readonly slug?: string; readonly kind?: ContentKind },
  options: MediaUrlOptions = {},
): Promise<PublicContentDetail | null> {
  const lookup = identifier.id
    ? eq(contentItems.id, identifier.id)
    : identifier.slug
      ? and(
          eq(contentItems.slug, identifier.slug),
          identifier.kind ? eq(contentItems.kind, identifier.kind) : undefined,
        )!
      : null;
  if (!lookup) return null;

  const [row] = await db
    .select({
      content: contentItems,
      screen: screenDetails,
      source: publicSourceColumns,
    })
    .from(contentItems)
    .leftJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(lookup, publishedContentCondition()))
    .limit(1);

  if (!row) return null;
  const content = row.content;

  const [usages, terms, children, flowMemberships, related, parentRow, experienceRow] =
    await Promise.all([
      db
        .select({ mediaId: mediaUsages.mediaId, role: mediaUsages.role, position: mediaUsages.position })
        .from(mediaUsages)
        .where(eq(mediaUsages.contentItemId, content.id))
        .orderBy(asc(mediaUsages.position)),

      db
        .select({
          id: taxonomyTerms.id,
          kind: taxonomyTerms.kind,
          name: taxonomyTerms.name,
          slug: taxonomyTerms.slug,
          path: taxonomyTerms.path,
          description: taxonomyTerms.description,
        })
        .from(taxonomyAssignments)
        .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
        .where(and(eq(taxonomyAssignments.contentItemId, content.id), publicTaxonomyCondition()))
        .orderBy(asc(taxonomyTerms.kind), asc(taxonomyTerms.name)),

      // States and interactions belonging to this page or screen.
      db
        .select()
        .from(contentItems)
        .where(
          and(
            eq(contentItems.parentId, content.id),
            inArray(contentItems.kind, ["state", "interaction"]),
            publishedContentCondition(),
          ),
        )
        .orderBy(asc(contentItems.title))
        .limit(100),

      // Flows this record appears in.
      db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          slug: contentItems.slug,
          description: contentItems.description,
          status: contentItems.status,
          rightsStatus: contentItems.rightsStatus,
          deletedAt: contentItems.deletedAt,
          stepCount: flowDetails.stepCount,
          goal: flowDetails.goal,
        })
        .from(flowSteps)
        .innerJoin(contentItems, eq(contentItems.id, flowSteps.flowId))
        .leftJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
        .where(and(eq(flowSteps.contentItemId, content.id), publishedContentCondition()))
        .limit(25),

      // Explicit relationships, in both directions.
      db
        .select()
        .from(contentItems)
        .where(
          and(
            or(
              sql`${contentItems.id} in (select to_id from content_relations where from_id = ${content.id})`,
              sql`${contentItems.id} in (select from_id from content_relations where to_id = ${content.id})`,
            ),
            publishedContentCondition(),
          ),
        )
        .limit(24),

      content.parentId
        ? db
            .select()
            .from(contentItems)
            .where(and(eq(contentItems.id, content.parentId), publishedContentCondition()))
            .limit(1)
        : Promise.resolve([]),

      content.experienceId
        ? db
            .select()
            .from(contentItems)
            .where(and(eq(contentItems.id, content.experienceId), publishedContentCondition()))
            .limit(1)
        : Promise.resolve([]),
    ]);

  const allMediaIds = [
    ...new Set([
      ...(content.primaryMediaId ? [content.primaryMediaId] : []),
      ...usages.map((u) => u.mediaId),
      ...related.map((r) => r.primaryMediaId).filter((id): id is string => id !== null),
      ...children.map((c) => c.primaryMediaId).filter((id): id is string => id !== null),
    ]),
  ];

  const [mediaRows, resolveUrls, resolveLogo] = await Promise.all([
    loadPublicMedia(db, allMediaIds),
    buildMediaUrlResolver(db, storage, allMediaIds, options),
    buildLogoResolver(db, storage, [row.source?.logoMediaId], options),
  ]);

  // One entry per *file*, not per usage row.
  //
  // A single screenshot is legitimately attached under several roles — the
  // capture pipeline records it as both `primary` and `screenshot_desktop`,
  // and deduplication means one file can serve several records. Mapping over
  // usages therefore yields the same image two or three times, which on a
  // detail page means the reader scrolls past the same screenshot repeatedly
  // (and React warns about duplicate keys).
  //
  // Usages are already ordered by role and position, so keeping the first
  // occurrence keeps the intended ordering.
  const seenMedia = new Set<string>();
  const media = usages
    .filter((usage) => {
      if (seenMedia.has(usage.mediaId)) return false;
      seenMedia.add(usage.mediaId);
      return true;
    })
    .map((usage) => buildMedia(mediaRows, usage.mediaId, resolveUrls))
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const summarise = (row: typeof content) =>
    serialiseContentSummary(row, {
      source: null,
      primaryMedia: row.primaryMediaId ? buildMedia(mediaRows, row.primaryMediaId, resolveUrls) : null,
    });

  return serialiseContentDetail({ ...content, stateLabel: row.screen?.stateLabel ?? null }, {
    screen: row.screen
      ? {
          screenName: row.screen.screenName,
          stateLabel: row.screen.stateLabel,
          deviceProfile: row.screen.deviceProfile,
          viewportWidth: row.screen.viewportWidth,
          viewportHeight: row.screen.viewportHeight,
          deviceScaleFactor: row.screen.deviceScaleFactor,
        }
      : null,
    source: row.source?.id ? serialiseSource(row.source, resolveLogo) : null,
    primaryMedia: content.primaryMediaId
      ? buildMedia(mediaRows, content.primaryMediaId, resolveUrls)
      : null,
    media,
    taxonomy: terms.map(serialiseTerm),
    relatedContent: related.map(summarise),
    flows: flowMemberships.map((flow) =>
      serialiseFlowSummary({
        id: flow.id,
        title: flow.title,
        slug: flow.slug,
        description: flow.description,
        stepCount: flow.stepCount,
        goal: flow.goal,
        status: flow.status,
        rightsStatus: flow.rightsStatus,
        deletedAt: flow.deletedAt,
      }),
    ),
    states: children.filter((c) => c.kind === "state").map(summarise),
    interactions: children.filter((c) => c.kind === "interaction").map(summarise),
    parent: parentRow[0] ? summarise(parentRow[0]) : null,
    experience: experienceRow[0] ? summarise(experienceRow[0]) : null,
  });
}

// --- Flows ----------------------------------------------------------------

export async function getPublicFlow(
  db: Db,
  storage: StorageDriver,
  identifier: { readonly id?: string; readonly slug?: string },
  options: MediaUrlOptions = {},
): Promise<PublicFlowDetail | null> {
  const lookup = identifier.id
    ? eq(contentItems.id, identifier.id)
    : identifier.slug
      ? eq(contentItems.slug, identifier.slug)
      : null;
  if (!lookup) return null;

  const [row] = await db
    .select({
      content: contentItems,
      detail: flowDetails,
      source: publicSourceColumns,
    })
    .from(contentItems)
    .leftJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(lookup, eq(contentItems.kind, "flow"), publishedContentCondition()))
    .limit(1);

  if (!row) return null;

  const steps = await db
    .select({ step: flowSteps, content: contentItems })
    .from(flowSteps)
    .innerJoin(contentItems, eq(contentItems.id, flowSteps.contentItemId))
    .where(and(eq(flowSteps.flowId, row.content.id), publishedContentCondition()))
    .orderBy(asc(flowSteps.position));

  const mediaIds = steps
    .map((s) => s.content.primaryMediaId)
    .filter((id): id is string => id !== null);
  const [mediaRows, resolveUrls, resolveLogo] = await Promise.all([
    loadPublicMedia(db, mediaIds),
    buildMediaUrlResolver(db, storage, mediaIds, options),
    buildLogoResolver(db, storage, [row.source?.logoMediaId], options),
  ]);

  return serialiseFlowDetail(
    {
      id: row.content.id,
      title: row.content.title,
      slug: row.content.slug,
      description: row.content.description,
      stepCount: row.detail?.stepCount ?? steps.length,
      goal: row.detail?.goal ?? null,
      status: row.content.status,
      rightsStatus: row.content.rightsStatus,
      deletedAt: row.content.deletedAt,
    },
    {
      source: row.source?.id ? serialiseSource(row.source, resolveLogo) : null,
      steps: steps.map((s) => ({
        position: s.step.position,
        label: s.step.label,
        content: serialiseContentSummary(s.content, {
          primaryMedia: s.content.primaryMediaId
            ? buildMedia(mediaRows, s.content.primaryMediaId, resolveUrls)
            : null,
        }),
      })),
    },
  );
}

// --- Sources --------------------------------------------------------------

/**
 * Public sources.
 *
 * A source is only listed once it has published content. Listing an empty
 * source would expose the fact that we are studying a product before anything
 * about it is public, which is a small but real information leak from the
 * ingestion pipeline.
 */
export async function listPublicSources(
  db: Db,
  query: { readonly module?: string; readonly page: number; readonly pageSize: number },
  media?: { readonly storage: StorageDriver; readonly options?: MediaUrlOptions },
) {
  const hasPublished = sql`exists (
    select 1 from ${contentItems} ci
    where ci.source_id = ${sources.id}
      and ci.status = 'published'
      and ci.deleted_at is null
      and ci.rights_status not in ('pending_review','restricted','removed','do_not_republish')
  )`;

  const conditions: SQL[] = [isNull(sources.deletedAt), hasPublished];
  if (query.module) conditions.push(sql`${sources.module} = ${query.module}`);
  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        ...publicSourceColumns,
        publishedCount: sql<number>`(
          select count(*)::int from ${contentItems} ci
          where ci.source_id = ${sources}.id
            and ci.status = 'published'
            and ci.deleted_at is null
            and ci.rights_status not in ('pending_review','restricted','removed','do_not_republish')
        )`,
      })
      .from(sources)
      .where(where)
      .orderBy(asc(sources.name))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(sources).where(where),
  ]);

  const resolveLogo = media
    ? await buildLogoResolver(db, media.storage, rows.map((row) => row.logoMediaId), media.options)
    : undefined;
  return {
    items: rows.map((row) => ({ ...serialiseSource(row, resolveLogo), publishedCount: row.publishedCount })),
    total: countRows[0]?.n ?? 0,
  };
}

export async function getPublicSource(
  db: Db,
  slug: string,
  media?: { readonly storage: StorageDriver; readonly options?: MediaUrlOptions },
) {
  const [row] = await db
    .select({
      ...publicSourceColumns,
      description: sources.description,
      attribution: sources.attribution,
      deletedAt: sources.deletedAt,
    })
    .from(sources)
    .where(and(eq(sources.slug, slug), isNull(sources.deletedAt)))
    .limit(1);

  if (!row) return null;
  const resolveLogo = media
    ? await buildLogoResolver(db, media.storage, [row.logoMediaId], media.options)
    : undefined;
  return {
    ...serialiseSource(row, resolveLogo),
    description: row.description,
    canonicalUrl: row.canonicalUrl,
    attribution: row.attribution,
  };
}

// --- Taxonomy facets ------------------------------------------------------

/**
 * Public facets, with counts.
 *
 * Counts reflect published content only, so a facet never advertises material
 * a visitor cannot reach — a filter that returns zero results is a worse
 * experience than one that is not offered.
 */
export async function listPublicFacets(db: Db, options: { readonly kinds?: readonly string[] } = {}) {
  // One grouped join, not a correlated subquery per row.
  //
  // Two reasons, one of them a trap worth naming. Interpolating a column into
  // a raw `sql` fragment renders it *unqualified* when the fragment sits in the
  // select list (`"id"`, not `"taxonomy_terms"."id"`), so a correlated subquery
  // there cannot resolve the outer row at all — it fails at parse time, not
  // subtly. Inside `.where()` the same interpolation is qualified and works.
  // Aggregating sidesteps the question: the term id becomes a real GROUP BY
  // column. And the inner joins do the work the EXISTS clause used to, so a
  // term with no published content simply does not appear.
  //
  // It also means the published-content rule arrives from
  // `publishedContentCondition()` rather than being retyped as SQL literals
  // here, which is the difference between one definition and two that drift.
  const conditions: SQL[] = [
    eq(taxonomyTerms.status, "active"),
    inArray(taxonomyAssignments.origin, [...HUMAN_CONFIRMED_ORIGINS]),
    publishedContentCondition(),
  ];
  if (options.kinds && options.kinds.length > 0) {
    conditions.push(sql`${taxonomyTerms.kind}::text in ${options.kinds}`);
  }

  // `distinct` because a term may be assigned to the same record more than
  // once — different origins, or a re-classification — and a facet count is a
  // count of content, not of assignments.
  const publishedCount = sql<number>`count(distinct ${contentItems.id})::int`;

  const rows = await db
    .select({
      id: taxonomyTerms.id,
      kind: taxonomyTerms.kind,
      name: taxonomyTerms.name,
      slug: taxonomyTerms.slug,
      path: taxonomyTerms.path,
      description: taxonomyTerms.description,
      count: publishedCount,
    })
    .from(taxonomyTerms)
    .innerJoin(taxonomyAssignments, eq(taxonomyAssignments.termId, taxonomyTerms.id))
    // A term on a screen counts that screen; a term on a website (Industry)
    // counts every published screen from it.
    .innerJoin(
      contentItems,
      or(
        eq(contentItems.id, taxonomyAssignments.contentItemId),
        eq(contentItems.sourceId, taxonomyAssignments.sourceId),
      ),
    )
    .where(and(...conditions))
    .groupBy(
      taxonomyTerms.id,
      taxonomyTerms.kind,
      taxonomyTerms.name,
      taxonomyTerms.slug,
      taxonomyTerms.path,
      taxonomyTerms.description,
    )
    // Busiest facet first within each kind, which is the order a filter list
    // wants. Previously an ordinal (`3`) that pointed at `name` by accident.
    .orderBy(asc(taxonomyTerms.kind), desc(publishedCount), asc(taxonomyTerms.name))
    .limit(500);

  const byKind = new Map<string, { term: ReturnType<typeof serialiseTerm>; count: number }[]>();
  for (const row of rows) {
    const bucket = byKind.get(row.kind) ?? [];
    bucket.push({ term: serialiseTerm(row), count: row.count });
    byKind.set(row.kind, bucket);
  }
  return [...byKind.entries()].map(([kind, terms]) => ({ kind, terms }));
}

// --- Collections ----------------------------------------------------------

export async function listPublicCollections(db: Db) {
  return db
    .select({
      id: collections.id,
      name: collections.name,
      slug: collections.slug,
      description: collections.description,
      itemCount: collections.itemCount,
    })
    .from(collections)
    .where(
      and(
        eq(collections.visibility, "public"),
        eq(collections.status, "active"),
        isNull(collections.deletedAt),
      ),
    )
    .orderBy(asc(collections.sortOrder), asc(collections.name))
    .limit(100);
}

// --- Page URL lookup ------------------------------------------------------

/** Resolve a public page by the URL it was captured from. */
export async function findPublicContentByUrl(db: Db, urlHash: string) {
  const [row] = await db
    .select({ id: contentItems.id, slug: contentItems.slug, kind: contentItems.kind })
    .from(pageDetails)
    .innerJoin(contentItems, eq(contentItems.id, pageDetails.contentItemId))
    .where(and(eq(pageDetails.normalizedUrlHash, urlHash), publishedContentCondition()))
    .limit(1);
  return row ?? null;
}

// --- Public media resolution ----------------------------------------------

export interface PublicMediaFile {
  readonly mimeType: string;
  readonly byteSize: number | null;
  /** A derivative is re-encoded by us and therefore safe to render inline. */
  readonly isDerivative: boolean;
}

/**
 * Resolve a storage key to a file the public may fetch.
 *
 * The public API hands out media URLs, so something has to serve them — and
 * that something needs the *same* gate as every other public read, or the
 * gate is decorative. A screenshot is publicly fetchable when its asset is
 * ready and undeleted **and** it is used by at least one published content
 * record. Withdraw the record and the image stops resolving, in the same
 * request, without anyone touching storage.
 *
 * Returns null for anything else, including a key that exists but whose
 * content is unpublished — indistinguishable from a key that never existed,
 * because saying "this exists but you may not have it" is itself a disclosure
 * about what is in the pipeline (§19).
 */
export async function findPublicMediaByKey(
  db: Db,
  key: string,
): Promise<PublicMediaFile | null> {
  // The published-content condition is expressed once, here, and reused for
  // both lookups rather than retyped.
  const usedByPublished = (mediaIdColumn: SQL) => sql`exists (
    select 1
    from ${mediaUsages} mu
    join ${contentItems} ci on ci.id = mu.content_item_id
    where mu.media_id = ${mediaIdColumn}
      and ci.status = 'published'
      and ci.deleted_at is null
      and ci.rights_status not in ('pending_review','restricted','removed','do_not_republish')
  )`;

  const [asset] = await db
    .select({ mimeType: mediaAssets.mimeType, byteSize: mediaAssets.byteSize })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.storageKey, key),
        publicMediaCondition(),
        usedByPublished(sql`${mediaAssets}.id`),
      ),
    )
    .limit(1);

  if (asset) {
    return { mimeType: asset.mimeType, byteSize: asset.byteSize, isDerivative: false };
  }

  // A website's logo, while the website has work on show. Taking a website
  // down unpublishes all of it, so its logo goes with it.
  const logoOfPublished = (mediaIdColumn: SQL) => sql`exists (
    select 1
    from ${sources} s
    join ${contentItems} ci on ci.source_id = s.id
    where s.logo_media_id = ${mediaIdColumn}
      and s.deleted_at is null
      and ci.status = 'published'
      and ci.deleted_at is null
      and ci.rights_status not in ('pending_review','restricted','removed','do_not_republish')
  )`;
  const [logo] = await db
    .select({ mimeType: mediaAssets.mimeType, byteSize: mediaAssets.byteSize })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.storageKey, key),
        publicMediaCondition(),
        sql`${mediaAssets.mimeType} <> 'image/svg+xml'`,
        logoOfPublished(sql`${mediaAssets}.id`),
      ),
    )
    .limit(1);
  if (logo) {
    return { mimeType: logo.mimeType, byteSize: logo.byteSize, isDerivative: false };
  }

  // Derivatives live under their own keys. They are always raster images that
  // sharp produced from the original, so they carry no script whatever the
  // original was — which is what makes them safe to render inline.
  const [derivative] = await db
    .select({ mimeType: mediaDerivatives.mimeType, byteSize: mediaDerivatives.byteSize })
    .from(mediaDerivatives)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.mediaId))
    .where(
      and(
        eq(mediaDerivatives.storageKey, key),
        publicMediaCondition(),
        usedByPublished(sql`${mediaDerivatives}.media_id`),
      ),
    )
    .limit(1);

  if (derivative) {
    return {
      mimeType: derivative.mimeType,
      byteSize: derivative.byteSize,
      isDerivative: true,
    };
  }

  const [logoDerivative] = await db
    .select({ mimeType: mediaDerivatives.mimeType, byteSize: mediaDerivatives.byteSize })
    .from(mediaDerivatives)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.mediaId))
    .where(
      and(
        eq(mediaDerivatives.storageKey, key),
        publicMediaCondition(),
        logoOfPublished(sql`${mediaDerivatives}.media_id`),
      ),
    )
    .limit(1);
  if (logoDerivative) {
    return { mimeType: logoDerivative.mimeType, byteSize: logoDerivative.byteSize, isDerivative: true };
  }

  return null;
}
