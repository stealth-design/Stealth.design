/**
 * The Library: what is live on the public site, by website.
 *
 * Read from the screen's own status, like the Inbox, so the Library can never
 * claim something is live that the public API would not serve.
 */
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  type Db,
  contentItems,
  mediaDerivatives,
  screenDetails,
  taxonomyAssignments,
  taxonomyTerms,
  users,
} from "@uxd/database";

const LIMIT = 500;

export interface LibraryWebsite {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly published: number;
  readonly lastPublishedAt: Date | null;
  readonly thumbnailKeys: readonly string[];
}

/** One row per website with something live, most recently published first. */
export async function libraryWebsites(db: Db): Promise<LibraryWebsite[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    domain: string | null;
    published: number;
    last_published_at: string | null;
  }>(sql`
    select s.id, s.name, s.domain,
           count(*)::int as published,
           max(ci.published_at) as last_published_at
      from content_items ci
      join sources s on s.id = ci.source_id
     where ci.kind = 'screen'
       and ci.deleted_at is null
       and ci.status = 'published'
     group by s.id, s.name, s.domain
     order by max(ci.published_at) desc nulls last
  `);

  const ids = rows.rows.map((row) => row.id);
  const thumbs = ids.length
    ? await db.execute<{ source_id: string; storage_key: string }>(sql`
        select source_id, storage_key from (
          select ci.source_id, d.storage_key,
                 row_number() over (
                   partition by ci.source_id
                   order by ci.published_at desc nulls last, ci.id desc
                 ) as rn
            from content_items ci
            join media_derivatives d on d.media_id = ci.primary_media_id and d.kind = 'thumbnail'
           where ci.kind = 'screen'
             and ci.deleted_at is null
             and ci.status = 'published'
             and ci.source_id in ${ids}
        ) ranked
        where rn <= 4
      `)
    : { rows: [] };

  const bySource = new Map<string, string[]>();
  for (const row of thumbs.rows) bySource.set(row.source_id, [...(bySource.get(row.source_id) ?? []), row.storage_key]);

  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    published: row.published,
    lastPublishedAt: row.last_published_at ? new Date(row.last_published_at) : null,
    thumbnailKeys: bySource.get(row.id) ?? [],
  }));
}

export interface LibraryItem {
  readonly id: string;
  readonly title: string | null;
  readonly slug: string | null;
  readonly screenName: string | null;
  readonly stateLabel: string | null;
  readonly url: string | null;
  readonly deviceProfile: string | null;
  readonly publishedAt: Date | null;
  readonly featuredAt: Date | null;
  readonly publishedByName: string | null;
  readonly gridKey: string | null;
  readonly imageKey: string | null;
}

/**
 * One website's live screens, newest first, optionally narrowed by a search
 * on the name and by a tag.
 */
export async function listLibrary(
  db: Db,
  filters: { sourceId: string; q?: string | null; termId?: string | null; featured?: boolean },
): Promise<{ items: LibraryItem[]; total: number; featured: number }> {
  const q = filters.q?.trim().slice(0, 100);
  const where = and(
    eq(contentItems.kind, "screen"),
    isNull(contentItems.deletedAt),
    eq(contentItems.status, "published"),
    eq(contentItems.sourceId, filters.sourceId),
    q ? or(ilike(contentItems.title, `%${q}%`), ilike(screenDetails.screenName, `%${q}%`)) : undefined,
    filters.featured ? sql`${contentItems.featuredAt} is not null` : undefined,
    filters.termId
      ? sql`exists (
          select 1 from ${taxonomyAssignments} ta
           where ta.content_item_id = ${contentItems}.id
             and ta.term_id = ${filters.termId}
             and ta.review_status = 'accepted'
        )`
      : undefined,
  );

  const derivative = (kinds: string) => sql<string | null>`(
    select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
    where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
      and ${mediaDerivatives.kind}::text in (${sql.raw(kinds)})
    order by array_position(array[${sql.raw(kinds)}]::text[], ${mediaDerivatives.kind}::text)
    limit 1
  )`;

  const [items, [count], [featuredCount]] = await Promise.all([
    db
      .select({
        id: contentItems.id,
        title: contentItems.title,
        slug: contentItems.slug,
        screenName: screenDetails.screenName,
        stateLabel: screenDetails.stateLabel,
        url: screenDetails.url,
        deviceProfile: screenDetails.deviceProfile,
        publishedAt: contentItems.publishedAt,
        featuredAt: contentItems.featuredAt,
        publishedByName: users.name,
        gridKey: derivative("'preview','thumbnail'"),
        imageKey: derivative("'large','preview','thumbnail'"),
      })
      .from(contentItems)
      .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .leftJoin(users, eq(users.id, contentItems.publishedBy))
      .where(where)
      .orderBy(desc(contentItems.publishedAt), desc(contentItems.id))
      .limit(LIMIT),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItems)
      .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .where(where),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(
        and(
          eq(contentItems.sourceId, filters.sourceId),
          eq(contentItems.status, "published"),
          isNull(contentItems.deletedAt),
          sql`${contentItems.featuredAt} is not null`,
        ),
      ),
  ]);

  return { items, total: count?.n ?? 0, featured: featuredCount?.n ?? 0 };
}

/** The tags used on a website's live screens, most used first — the filter. */
export async function libraryTags(db: Db, sourceId: string) {
  return db
    .select({
      termId: taxonomyTerms.id,
      name: taxonomyTerms.name,
      count: sql<number>`count(*)::int`,
    })
    .from(taxonomyAssignments)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
    .innerJoin(contentItems, eq(contentItems.id, taxonomyAssignments.contentItemId))
    .where(
      and(
        eq(contentItems.sourceId, sourceId),
        eq(contentItems.kind, "screen"),
        eq(contentItems.status, "published"),
        isNull(contentItems.deletedAt),
        eq(taxonomyAssignments.reviewStatus, "accepted"),
        isNull(taxonomyTerms.archivedAt),
      ),
    )
    .groupBy(taxonomyTerms.id, taxonomyTerms.name)
    .orderBy(desc(sql`count(*)`), taxonomyTerms.name);
}
