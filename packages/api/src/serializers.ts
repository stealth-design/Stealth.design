/**
 * Public API serialisers (§19).
 *
 * Every public response is built by *constructing* an object from named fields,
 * never by taking a database row and deleting the sensitive parts. The
 * difference decides what happens when someone adds a column: an allowlist
 * omits the new field until a person deliberately adds it, while a denylist
 * publishes it immediately and silently.
 *
 * So `internalNotes`, `reviewNotes`, `rightsNotes`, `crawlJobId`, `storageKey`,
 * `errorMessage`, reviewer identities and crawl diagnostics are not excluded
 * here — they are simply never read. The leak test walks the output of every
 * function in this file and asserts that no name from `NEVER_PUBLIC_FIELDS`
 * appears at any depth, which turns "we remembered" into "we checked".
 *
 * The second guarantee is `assertPublishable`, called on every record before it
 * is serialised. The query layer has already filtered to published rows; this is
 * the independent second check, so a bug in a WHERE clause cannot become a
 * disclosure.
 */
import { AppError, ErrorCode } from "@uxd/shared";
import {
  type LifecycleStatus,
  type RightsStatus,
  NEVER_PUBLIC_FIELDS,
  isPubliclyVisible,
} from "@uxd/types";

// --- Public shapes --------------------------------------------------------

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
  /**
   * The widest rendition, 2048px. Generated for every capture and, until this
   * was added, reachable only as a fallback for a missing `preview` — so the
   * site's largest available image was 1024px while this sat unused.
   */
  readonly largeUrl: string | null;
  /** Viewport the capture was taken at — useful context, not internal. */
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
  /** Present on screens. Null for every other kind. */
  readonly stateLabel: string | null;
}

/**
 * The facts that make a Screen a Screen rather than a URL (§2).
 *
 * `stateLabel` is the one that matters publicly: eight records all called
 * "Pricing" are unusable, and "Pricing — Comparison table expanded" is the
 * difference between a library and a folder of screenshots. The capture
 * conditions travel with it because a researcher comparing two screens needs
 * to know whether they are looking at the same viewport.
 */
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

export interface PublicFlowSummary {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly description: string | null;
  readonly stepCount: number;
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

export interface PublicCollection {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly itemCount: number;
}

// --- Row inputs -----------------------------------------------------------
// Deliberately narrow: a serialiser accepts only the fields it needs, so
// passing it a full row does not make more of that row reachable.

export interface PublishableRow {
  readonly status: LifecycleStatus;
  readonly rightsStatus: RightsStatus;
  readonly deletedAt?: Date | null;
}

/**
 * Refuse to serialise anything that is not publicly visible.
 *
 * Throws rather than returning null, because reaching this line means a query
 * returned a row it should not have — a bug worth surfacing as a 500 in the
 * logs, not one worth papering over with an empty response.
 */
export function assertPublishable(row: PublishableRow, what = "record"): void {
  if (row.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, "Not found", {
      detail: `attempted to serialise a deleted ${what}`,
    });
  }
  if (!isPubliclyVisible({ status: row.status, rightsStatus: row.rightsStatus })) {
    throw new AppError(ErrorCode.INTERNAL, "Not found", {
      status: 404,
      detail: `attempted to serialise a non-public ${what} (status=${row.status}, rights=${row.rightsStatus})`,
    });
  }
}

const iso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : null;

export interface MediaRowForPublic {
  readonly id: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly altText: string | null;
  readonly caption: string | null;
  readonly capturedAt: Date | null;
  readonly viewportWidth: number | null;
  readonly viewportHeight: number | null;
  readonly deviceClass: string | null;
  readonly status: string;
}

export interface MediaUrls {
  readonly url: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string | null;
  readonly previewUrl: string | null;
  readonly largeUrl: string | null;
}

export function serialiseMedia(row: MediaRowForPublic, urls: MediaUrls): PublicMedia {
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    altText: row.altText,
    caption: row.caption,
    url: urls.url,
    originalUrl: urls.originalUrl,
    thumbnailUrl: urls.thumbnailUrl,
    previewUrl: urls.previewUrl,
    largeUrl: urls.largeUrl,
    viewportWidth: row.viewportWidth,
    viewportHeight: row.viewportHeight,
    deviceClass: row.deviceClass,
  };
}

export interface SourceRowForPublic {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly domain: string | null;
  readonly companyName: string | null;
  readonly productName: string | null;
  readonly type: string;
  readonly module: string;
}

export function serialiseSource(row: SourceRowForPublic): PublicSourceSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    domain: row.domain,
    companyName: row.companyName,
    productName: row.productName,
    type: row.type,
    module: row.module,
  };
}

export interface TermRowForPublic {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly slug: string;
  readonly path: string;
  readonly description: string | null;
}

export function serialiseTerm(row: TermRowForPublic): PublicTaxonomyTerm {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    path: row.path,
    description: row.description,
  };
}

export interface ContentRowForPublic extends PublishableRow {
  readonly id: string;
  readonly kind: string;
  readonly module: string;
  readonly title: string | null;
  readonly slug: string | null;
  readonly description: string | null;
  readonly sourceUrl: string | null;
  readonly platform: string | null;
  readonly deviceClass: string | null;
  readonly capturedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly featuredAt?: Date | null;
  readonly attribution: string | null;
  /** Joined from `screen_details` when the row is a screen. */
  readonly stateLabel?: string | null;
}

export function serialiseContentSummary(
  row: ContentRowForPublic,
  extras: {
    readonly source?: PublicSourceSummary | null;
    readonly primaryMedia?: PublicMedia | null;
  } = {},
): PublicContentSummary {
  assertPublishable(row, "content record");
  return {
    id: row.id,
    kind: row.kind,
    module: row.module,
    // A published record always has a title — the database CHECK constraint
    // guarantees it — but the type is nullable, so this keeps the public shape
    // honest rather than emitting null into a required field.
    title: row.title ?? "Untitled",
    slug: row.slug ?? row.id,
    description: row.description,
    sourceUrl: row.sourceUrl,
    platform: row.platform,
    deviceClass: row.deviceClass,
    // When it was captured is kept for the team, not shown to the public.
    publishedAt: iso(row.publishedAt),
    featured: row.featuredAt != null,
    source: extras.source ?? null,
    primaryMedia: extras.primaryMedia ?? null,
    attribution: row.attribution,
    stateLabel: row.stateLabel ?? null,
  };
}

export function serialiseContentDetail(
  row: ContentRowForPublic,
  extras: {
    readonly source: PublicSourceSummary | null;
    readonly primaryMedia: PublicMedia | null;
    readonly media: readonly PublicMedia[];
    readonly taxonomy: readonly PublicTaxonomyTerm[];
    readonly relatedContent: readonly PublicContentSummary[];
    readonly flows: readonly PublicFlowSummary[];
    readonly states: readonly PublicContentSummary[];
    readonly interactions: readonly PublicContentSummary[];
    readonly parent: PublicContentSummary | null;
    readonly experience: PublicContentSummary | null;
    readonly screen?: PublicScreenFacts | null;
  },
): PublicContentDetail {
  return {
    ...serialiseContentSummary(row, { source: extras.source, primaryMedia: extras.primaryMedia }),
    screen: extras.screen ?? null,
    media: extras.media,
    taxonomy: extras.taxonomy,
    relatedContent: extras.relatedContent,
    flows: extras.flows,
    states: extras.states,
    interactions: extras.interactions,
    parent: extras.parent,
    experience: extras.experience,
  };
}

export interface FlowRowForPublic extends PublishableRow {
  readonly id: string;
  readonly title: string | null;
  readonly slug: string | null;
  readonly description: string | null;
  readonly stepCount: number | null;
  readonly goal: string | null;
}

export function serialiseFlowSummary(row: FlowRowForPublic): PublicFlowSummary {
  assertPublishable(row, "flow");
  return {
    id: row.id,
    title: row.title ?? "Untitled flow",
    slug: row.slug ?? row.id,
    description: row.description,
    stepCount: row.stepCount ?? 0,
  };
}

export function serialiseFlowDetail(
  row: FlowRowForPublic,
  extras: {
    readonly source: PublicSourceSummary | null;
    readonly steps: readonly {
      readonly position: number;
      readonly label: string | null;
      readonly content: PublicContentSummary;
    }[];
  },
): PublicFlowDetail {
  return {
    ...serialiseFlowSummary(row),
    goal: row.goal,
    source: extras.source,
    steps: extras.steps,
  };
}

export interface CollectionRowForPublic {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly itemCount: number;
  readonly visibility: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

export function serialiseCollection(row: CollectionRowForPublic): PublicCollection {
  if (row.visibility !== "public" || row.status !== "active" || row.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, "Not found", {
      detail: `attempted to serialise a non-public collection (${row.visibility}/${row.status})`,
    });
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    itemCount: row.itemCount,
  };
}

/**
 * Walk a serialised payload and report any forbidden field name.
 *
 * Used by the leak test, and available as a defensive assertion in
 * development. Returns the paths at which a forbidden name appears, so a
 * failure names the exact field rather than just saying "something leaked".
 */
export function findLeakedFields(payload: unknown, path = "$"): string[] {
  const forbidden = new Set(NEVER_PUBLIC_FIELDS);
  const found: string[] = [];

  const walk = (value: unknown, currentPath: string, depth: number): void => {
    if (depth > 12 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${currentPath}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${currentPath}.${key}`;
      if (forbidden.has(key)) found.push(childPath);
      walk(child, childPath, depth + 1);
    }
  };

  walk(payload, path, 0);
  return found;
}

/** Envelope for a paginated public list. */
export interface PublicListResponse<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export function publicList<T>(
  items: readonly T[],
  total: number,
  page: number,
  pageSize: number,
): PublicListResponse<T> {
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}
