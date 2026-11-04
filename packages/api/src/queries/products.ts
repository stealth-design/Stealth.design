/**
 * The Products screen: every listed product, with what a researcher needs to
 * decide where to go next — has it been captured, how many screens, how many
 * are waiting, how many are live — and a cover image.
 *
 * "Listed" means not archived or removed. Archiving takes a product off the
 * screen without touching anything captured from it; adding its URL again
 * puts it back.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { type Db, sources } from "@uxd/database";

/** Screen statuses, by the step of the job they belong to. */
const CAPTURED = ["processed", "ai_classified", "needs_review"] as const;
const DRAFT = ["approved"] as const;
const PUBLISHED = ["published"] as const;
const COUNTED = [...CAPTURED, ...DRAFT, ...PUBLISHED];

export interface ProductListing {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly createdAt: Date;
  /** When its newest screen was captured — the date a researcher means by "last captured". */
  readonly lastScreenAt: Date | null;
  /** Captured and waiting in the inbox. */
  readonly captured: number;
  /** Reviewed and kept as a draft. */
  readonly draft: number;
  readonly published: number;
  /** The product's first screenshot, at preview size where there is one. */
  readonly coverKey: string | null;
}

export async function listProducts(db: Db): Promise<ProductListing[]> {
  const counted = sql.join(COUNTED.map((status) => sql`${status}`), sql`, `);
  const list = (statuses: readonly string[]) => sql.join(statuses.map((status) => sql`${status}`), sql`, `);

  const rows = await db
    .select({
      id: sources.id,
      name: sources.name,
      domain: sources.domain,
      createdAt: sources.createdAt,
      lastScreenAt: sql<Date | null>`(
        select max(ci.created_at) from content_items ci
        where ci.source_id = ${sources}.id and ci.kind = 'screen' and ci.deleted_at is null
          and ci.status::text in (${counted})
      )`.mapWith((value: string | Date | null) => (value === null ? null : new Date(value))),
      captured: sql<number>`(
        select count(*)::int from content_items ci
        where ci.source_id = ${sources}.id and ci.kind = 'screen' and ci.deleted_at is null
          and ci.status::text in (${list(CAPTURED)})
      )`,
      draft: sql<number>`(
        select count(*)::int from content_items ci
        where ci.source_id = ${sources}.id and ci.kind = 'screen' and ci.deleted_at is null
          and ci.status::text in (${list(DRAFT)})
      )`,
      published: sql<number>`(
        select count(*)::int from content_items ci
        where ci.source_id = ${sources}.id and ci.kind = 'screen' and ci.deleted_at is null
          and ci.status::text in (${list(PUBLISHED)})
      )`,
      // The earliest screen that is still in play. Preview size suits a large
      // card; the thumbnail is the fallback for media processed before
      // previews existed.
      coverKey: sql<string | null>`(
        select coalesce(
          (select md.storage_key from media_derivatives md where md.media_id = ci.primary_media_id and md.kind = 'preview' limit 1),
          (select md.storage_key from media_derivatives md where md.media_id = ci.primary_media_id and md.kind = 'thumbnail' limit 1)
        )
        from content_items ci
        where ci.source_id = ${sources}.id and ci.kind = 'screen' and ci.deleted_at is null
          and ci.primary_media_id is not null and ci.status::text in (${counted})
        order by ci.created_at asc, ci.id asc
        limit 1
      )`,
    })
    .from(sources)
    .where(and(isNull(sources.deletedAt), sql`${sources.status}::text not in ('archived', 'removed')`))
    // Most recently worked on first; a product added a moment ago is at the
    // top, where the researcher who added it is looking.
    .orderBy(
      sql`greatest(${sources.updatedAt}, (
        select max(ci.created_at) from content_items ci
        where ci.source_id = ${sources}.id and ci.kind = 'screen' and ci.deleted_at is null
      )) desc`,
      sources.id,
    );

  return rows;
}

/** The few fields a product's own page needs to name itself. */
export async function getProduct(db: Db, id: string) {
  const [row] = await db
    .select({
      id: sources.id,
      name: sources.name,
      domain: sources.domain,
      canonicalUrl: sources.canonicalUrl,
      blockedAt: sources.crawlBlockedAt,
      blockedReason: sources.crawlBlockedReason,
    })
    .from(sources)
    .where(and(eq(sources.id, id), isNull(sources.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface ProductState {
  readonly id: string;
  /** What makes this state its own record — "Cookie banner". Null for the plain view. */
  readonly label: string | null;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  /** Published at some point, even if not now. Such a screen is never discarded. */
  readonly everPublished: boolean;
  readonly deviceProfile: string | null;
  readonly thumbnailKey: string | null;
}

export interface ProductPage {
  /** The address path the states were captured at — the grouping key. */
  readonly path: string;
  readonly url: string;
  /** Derived from the path: "/" is Home, "/upload" is Upload. */
  readonly name: string;
  readonly states: readonly ProductState[];
}

/**
 * A product's captured screens, grouped into pages by the address they were
 * captured at. Three captures of soundcloud.com/ are one page — Home — with
 * three states, which is how a researcher thinks of them.
 */
export async function getProductPages(db: Db, sourceId: string): Promise<ProductPage[]> {
  const counted = sql.join(COUNTED.map((status) => sql`${status}`), sql`, `);
  const rows = await db.execute<{
    id: string;
    url: string | null;
    state_label: string | null;
    status: string;
    created_by: string | null;
    created_at: string | Date;
    ever_published: boolean;
    device_profile: string | null;
    thumbnail_key: string | null;
  }>(sql`
    select ci.id, coalesce(sd.url, ci.source_url) as url, sd.state_label, ci.status::text as status,
           ci.created_by, ci.created_at, ci.first_published_at is not null as ever_published,
           sd.device_profile,
           (select md.storage_key from media_derivatives md
             where md.media_id = ci.primary_media_id and md.kind = 'thumbnail' limit 1) as thumbnail_key
      from content_items ci
      left join screen_details sd on sd.content_item_id = ci.id
     where ci.source_id = ${sourceId} and ci.kind = 'screen' and ci.deleted_at is null
       and ci.status::text in (${counted})
     order by ci.created_at asc, ci.id asc
  `);

  const pages = new Map<string, { url: string; states: ProductState[] }>();
  for (const row of rows.rows) {
    const { path, url } = pathOf(row.url);
    const page = pages.get(path) ?? { url, states: [] };
    page.states.push({
      id: row.id,
      label: row.state_label,
      status: row.status,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      everPublished: row.ever_published,
      deviceProfile: row.device_profile,
      thumbnailKey: row.thumbnail_key,
    });
    pages.set(path, page);
  }

  return [...pages.entries()]
    .map(([path, page]) => ({ path, url: page.url, name: pageName(path), states: page.states }))
    .sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
}

function pathOf(raw: string | null): { path: string; url: string } {
  if (!raw) return { path: "/", url: "" };
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : "/";
    return { path, url: `${parsed.origin}${path}` };
  } catch {
    return { path: raw, url: raw };
  }
}

function pageName(path: string): string {
  if (path === "/") return "Home";
  const last = path.split("/").filter(Boolean).pop() ?? path;
  const words = decodeURIComponent(last).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
}
