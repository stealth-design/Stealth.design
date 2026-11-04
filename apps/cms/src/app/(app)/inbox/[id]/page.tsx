import { notFound } from "next/navigation";
import {
  INBOX_STAGES,
  canDiscardScreen,
  getProduct,
  getWebsiteIndustry,
  getWebsiteLogo,
  inboxCounts,
  inboxTags,
  listInbox,
  listTaxonomyTerms,
  type InboxStage,
} from "@uxd/api";
import { can } from "@uxd/auth";
import type { TagOption } from "@/components/tag-picker";
import { ago } from "@/lib/ago";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { Inbox } from "./inbox";

export const metadata = { title: "Inbox" };

/**
 * One website's Inbox: its captures waiting for a decision.
 *
 * Who sees which button is decided here, from the same permissions the
 * services enforce: publishing needs `content.publish`, keeping something as
 * a draft needs `review.decide`, and anyone can throw away a capture of their
 * own that was never public. Someone with creation access only sees the queue
 * and can tidy it, but cannot decide it.
 */
export default async function WebsiteInboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stage?: string }>;
}) {
  const context = await getAdminContextWith("review.read");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const stage: InboxStage = INBOX_STAGES.includes(query.stage as InboxStage) ? (query.stage as InboxStage) : "review";

  const product = await getProduct(context.db, id);
  if (!product) notFound();

  const [{ items, total }, counts, terms, industryId, logo] = await Promise.all([
    listInbox(context.db, { stage, sourceId: id }),
    inboxCounts(context.db, id),
    listTaxonomyTerms(context.db, { statuses: ["active"] }),
    getWebsiteIndustry(context, id),
    getWebsiteLogo(context, id),
  ]);

  const [assigned, media] = await Promise.all([
    inboxTags(
      context.db,
      items.map((item) => item.id),
    ),
    resolveMediaUrls([...items.flatMap((item) => [item.thumbnailKey, item.imageKey]), logo?.storageKey]),
  ]);

  const tags: TagOption[] = terms.map((term) => ({
    id: term.id,
    name: term.name,
    kind: term.kind,
    usageCount: term.usageCount,
    aliases: term.aliases,
  }));

  const now = Date.now();

  return (
    <Inbox
      stage={stage}
      product={{ id: product.id, name: product.name, domain: product.domain }}
      profile={{
        industryId,
        industries: terms
          .filter((term) => term.kind === "industry")
          .map((term) => ({ id: term.id, name: term.name, depth: term.depth })),
        canEdit: can(context.actor, "taxonomy.assign"),
        logo: logo
          ? {
              mediaId: logo.mediaId,
              url: logo.storageKey ? (media.get(logo.storageKey) ?? null) : null,
              origin: logo.origin,
            }
          : null,
        canEditLogo: can(context.actor, "source.update"),
      }}
      total={total}
      counts={counts}
      tags={tags}
      permissions={{
        decide: can(context.actor, "review.decide"),
        publish: can(context.actor, "content.publish"),
        rename: can(context.actor, "content.update"),
        tag: can(context.actor, "taxonomy.assign"),
      }}
      items={items.map((item) => ({
        id: item.id,
        name: item.screenName ?? item.title ?? "Untitled",
        stateLabel: item.stateLabel,
        url: item.url,
        mobile: item.deviceProfile?.startsWith("mobile") ?? false,
        productId: item.sourceId,
        productName: item.sourceName ?? item.sourceDomain ?? "Unknown product",
        capturedBy: item.createdByName,
        capturedAgo: item.capturedAt ? ago(item.capturedAt, now) : null,
        // The exact moment, for the record. Formatted in the reader's own
        // time zone by the page, not here.
        capturedAt: item.capturedAt ? item.capturedAt.toISOString() : null,
        thumbnailUrl: item.thumbnailKey ? (media.get(item.thumbnailKey) ?? null) : null,
        imageUrl: item.imageKey ? (media.get(item.imageKey) ?? null) : null,
        discardable: canDiscardScreen(context.actor, {
          createdBy: item.createdBy,
          status: item.status,
          everPublished: item.firstPublishedAt !== null,
        }),
        tags: assigned
          .filter((tag) => tag.contentItemId === item.id && tag.reviewStatus === "accepted")
          .map((tag) => ({ assignmentId: tag.assignmentId, termId: tag.termId })),
        suggestions: assigned
          .filter((tag) => tag.contentItemId === item.id && tag.reviewStatus === "pending")
          .map((tag) => ({ assignmentId: tag.assignmentId, termId: tag.termId, name: tag.name })),
      }))}
    />
  );
}
