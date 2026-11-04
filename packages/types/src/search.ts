/**
 * Search vocabulary (§31).
 *
 * V1 search is Postgres full-text (a generated `tsvector` column plus a GIN
 * index) with trigram-style substring fallback. The `SearchProvider` seam below
 * is what §31's "architect so semantic/AI search can be added later" needs: the
 * API depends on this interface, so adding an embedding-backed provider is a
 * new implementation plus a settings flip, not a rewrite of every query.
 */

export const SEARCH_ENTITY_TYPES = [
  "content",
  "source",
  "media",
  "taxonomy_term",
  "crawl_job",
  "collection",
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const SEARCH_ENTITY_META: Record<
  SearchEntityType,
  { label: string; plural: string; route: string }
> = {
  content: { label: "Content", plural: "Content", route: "/content" },
  source: { label: "Source", plural: "Sources", route: "/sources" },
  media: { label: "Media", plural: "Media", route: "/media" },
  taxonomy_term: { label: "Term", plural: "Taxonomy", route: "/taxonomy" },
  crawl_job: { label: "Crawl job", plural: "Crawl jobs", route: "/crawl-jobs" },
  collection: { label: "Collection", plural: "Collections", route: "/collections" },
};

export interface SearchHit {
  readonly entityType: SearchEntityType;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly snippet: string | null;
  readonly thumbnailUrl: string | null;
  readonly score: number;
  readonly href: string;
}

export interface SearchQuery {
  readonly q: string;
  readonly entityTypes?: readonly SearchEntityType[];
  readonly limit?: number;
}

/** The seam a semantic provider will implement later. */
export interface SearchProvider {
  readonly name: string;
  readonly supportsSemantic: boolean;
  search(query: SearchQuery): Promise<readonly SearchHit[]>;
}

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * Sortable columns, declared per surface.
 *
 * An allowlist rather than a free string, because a sort key becomes part of an
 * ORDER BY clause. Everything the API accepts is mapped to a known column.
 */
export const CONTENT_SORT_KEYS = [
  "updatedAt",
  "createdAt",
  "capturedAt",
  "publishedAt",
  "title",
  "status",
  "kind",
  "sourceName",
] as const;
export type ContentSortKey = (typeof CONTENT_SORT_KEYS)[number];

export const MEDIA_SORT_KEYS = [
  "createdAt",
  "capturedAt",
  "byteSize",
  "width",
  "originalFilename",
  "mimeType",
] as const;
export type MediaSortKey = (typeof MEDIA_SORT_KEYS)[number];

export const SOURCE_SORT_KEYS = [
  "name",
  "lastCapturedAt",
  "firstCapturedAt",
  "health",
  "contentCount",
  "createdAt",
] as const;
export type SourceSortKey = (typeof SOURCE_SORT_KEYS)[number];

export const JOB_SORT_KEYS = ["createdAt", "startedAt", "finishedAt", "status", "name"] as const;
export type JobSortKey = (typeof JOB_SORT_KEYS)[number];
