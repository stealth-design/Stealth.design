import { notFound } from "next/navigation";
import { getProduct, inboxTags, libraryTags, listLibrary, listTaxonomyTerms } from "@uxd/api";
import { can } from "@uxd/auth";
import type { TagOption } from "@/components/tag-picker";
import { ago } from "@/lib/ago";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { Library } from "./library";

export const metadata = { title: "Library" };

/**
 * One website's live screens.
 *
 * A grid to scan, narrowed by name or by tag; opening a screen shows it large
 * with its name and tags, which can be corrected in place — a fix here is a
 * fix on the public site. Unpublishing sends a screen back to Drafts, never
 * away: it was reviewed, and that stays true.
 */
export default async function WebsiteLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; tag?: string; featured?: string }>;
}) {
  const context = await getAdminContextWith("content.read");
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const product = await getProduct(context.db, id);
  if (!product) notFound();

  const q = query.q?.trim() || null;
  const termId = query.tag || null;
  const featuredOnly = query.featured === "1";

  const [{ items, total, featured }, facets, terms] = await Promise.all([
    listLibrary(context.db, { sourceId: id, q, termId, featured: featuredOnly }),
    libraryTags(context.db, id),
    listTaxonomyTerms(context.db, { statuses: ["active"] }),
  ]);
  const [assigned, media] = await Promise.all([
    inboxTags(
      context.db,
      items.map((item) => item.id),
    ),
    resolveMediaUrls(items.flatMap((item) => [item.gridKey, item.imageKey])),
  ]);

  const tags: TagOption[] = terms.map((term) => ({
    id: term.id,
    name: term.name,
    kind: term.kind,
    usageCount: term.usageCount,
    aliases: term.aliases,
  }));
  const now = Date.now();
  const origin = context.env.PUBLIC_FRONTEND_ORIGIN.replace(/\/$/, "");

  return (
    <Library
      product={{ id: product.id, name: product.name, domain: product.domain }}
      total={total}
      query={q ?? ""}
      activeTag={termId}
      featuredOnly={featuredOnly}
      featuredCount={featured}
      facets={facets}
      tags={tags}
      permissions={{
        unpublish: can(context.actor, "content.unpublish"),
        feature: can(context.actor, "content.publish"),
        takeDown: can(context.actor, "content.unpublish"),
        rename: can(context.actor, "content.update"),
        tag: can(context.actor, "taxonomy.assign"),
      }}
      items={items.map((item) => ({
        id: item.id,
        name: item.screenName ?? item.title ?? "Untitled",
        stateLabel: item.stateLabel,
        url: item.url,
        mobile: item.deviceProfile?.startsWith("mobile") ?? false,
        publicUrl: item.slug ? `${origin}/entry/${item.slug}` : null,
        publishedAgo: item.publishedAt ? ago(item.publishedAt, now) : null,
        featured: item.featuredAt !== null,
        publishedBy: item.publishedByName,
        gridUrl: item.gridKey ? (media.get(item.gridKey) ?? null) : null,
        imageUrl: item.imageKey ? (media.get(item.imageKey) ?? null) : null,
        tags: assigned
          .filter((tag) => tag.contentItemId === item.id && tag.reviewStatus === "accepted")
          .map((tag) => ({ assignmentId: tag.assignmentId, termId: tag.termId, name: tag.name })),
      }))}
    />
  );
}
