/**
 * Pagination.
 *
 * CMS tables use offset pagination (operators need page numbers and total
 * counts to reason about a backlog). The public API and any endpoint that can
 * be walked by a machine use keyset/cursor pagination so deep pages stay
 * cheap and stable while new content is being published.
 */
import { z } from "zod";

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type OffsetPagination = z.infer<typeof offsetPaginationSchema>;

export const cursorPaginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
});
export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly hasMore: boolean;
}

export function buildPage<T>(items: readonly T[], total: number, p: OffsetPagination): Page<T> {
  const pageCount = Math.max(1, Math.ceil(total / p.pageSize));
  return {
    items,
    total,
    page: p.page,
    pageSize: p.pageSize,
    pageCount,
    hasMore: p.page < pageCount,
  };
}

export function toOffset(p: OffsetPagination): { limit: number; offset: number } {
  return { limit: p.pageSize, offset: (p.page - 1) * p.pageSize };
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Opaque, tamper-evident-enough cursor. Not a security boundary — the query
 * it feeds is always re-authorised server side. */
export function encodeCursor(value: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
