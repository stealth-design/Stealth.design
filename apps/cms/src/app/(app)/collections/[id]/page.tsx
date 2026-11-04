import Link from "next/link";
import { notFound } from "next/navigation";
import { getCollectionDetail } from "@uxd/api";
import {
  CONTENT_KIND_META,
  LIFECYCLE_STATUS_META,
  RIGHTS_STATUS_META,
  type ContentKind,
  type LifecycleStatus,
  type RightsStatus,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  Field,
  FieldList,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  Thumbnail,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Collection" };

/**
 * One collection, in its curated order (§11).
 *
 * Membership is explicit and ordered — `collection_items.position` — because a
 * curated set is a sequence, not a query result. A "before and after" pair or a
 * progression through a design language reads in one order and is meaningless in
 * another.
 *
 * Each item shows its own lifecycle status. That is the operationally important
 * thing about a public collection: the public API serves only the published
 * subset, so a collection can be complete here and partial to a visitor, and
 * this is where a curator sees that.
 */
export default async function CollectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContextWith("collection.read");
  const { id } = await params;

  const detail = await getCollectionDetail(context.db, id);
  if (!detail) notFound();

  const { collection, items } = detail;
  const urls = await resolveMediaUrls(items.map((item) => item.thumbnailKey));

  const publishedItems = items.filter((item) => item.status === "published").length;
  const isPublic = collection.visibility === "public";

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Collections", href: "/collections" }]}
        title={collection.name}
        description={collection.description ?? undefined}
        count={`${items.length} item${items.length === 1 ? "" : "s"}`}
        actions={<LinkButton href="/content">Add from content</LinkButton>}
      />

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isPublic ? "success" : "neutral"}>{collection.visibility}</Badge>
          <Badge tone={collection.status === "active" ? "success" : "neutral"}>
            {collection.status}
          </Badge>
          {isPublic && publishedItems < items.length ? (
            <span className="text-2xs text-[var(--color-tone-warning)]">
              A visitor sees {publishedItems} of these {items.length} items — the rest are not
              published.
            </span>
          ) : null}
          {isPublic && items.length > 0 && publishedItems === items.length ? (
            <span className="text-2xs text-[var(--color-tone-success)]">
              Every item is live.
            </span>
          ) : null}
          {!isPublic ? (
            <span className="text-2xs text-ink-500">
              Internal. Not served by the public API whatever its items' statuses.
            </span>
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          <div className="lg:col-span-3">
            <Panel title="Items, in curated order">
              {items.length === 0 ? (
                <EmptyState
                  title="Nothing in this collection yet"
                  description="Add records from Content. Order is explicit, so a sequence you arrange here is the sequence a reader gets."
                  action={<LinkButton href="/content">Browse content</LinkButton>}
                />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-10 text-right">#</th>
                      <th className="w-12" />
                      <th>Record</th>
                      <th className="w-20">Kind</th>
                      <th className="w-28">Status</th>
                      <th className="w-28">Rights</th>
                      <th className="w-32">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, index) => {
                      const statusMeta = LIFECYCLE_STATUS_META[item.status as LifecycleStatus];
                      const rightsMeta = RIGHTS_STATUS_META[item.rightsStatus as RightsStatus];
                      const hidden = isPublic && item.status !== "published";
                      return (
                        <tr key={item.id} className={hidden ? "opacity-60" : undefined}>
                          <td className="text-right tabular-nums text-2xs text-ink-400">
                            {index + 1}
                          </td>
                          <td>
                            <Thumbnail
                              url={item.thumbnailKey ? (urls.get(item.thumbnailKey) ?? null) : null}
                              alt=""
                              width={36}
                              height={24}
                            />
                          </td>
                          <td className="truncate-cell">
                            <Link href={`/content/${item.id}`} className="font-medium hover:underline">
                              {item.title ?? "Untitled"}
                            </Link>
                            <InlineMeta
                              items={[
                                item.note,
                                hidden ? "not visible publicly" : null,
                              ]}
                            />
                          </td>
                          <td className="text-2xs text-ink-600">
                            {CONTENT_KIND_META[item.kind as ContentKind]?.label ?? item.kind}
                          </td>
                          <td>
                            <Badge tone={statusMeta.tone} title={statusMeta.description}>
                              {statusMeta.label}
                            </Badge>
                          </td>
                          <td>
                            <Badge tone={rightsMeta.tone} title={rightsMeta.description}>
                              {rightsMeta.label}
                            </Badge>
                          </td>
                          <td className="truncate-cell">
                            {item.sourceId ? (
                              <Link href={`/sources/${item.sourceId}`} className="hover:underline">
                                {item.sourceName ?? "—"}
                              </Link>
                            ) : (
                              <span className="text-ink-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Collection">
              <FieldList>
                <Field label="Slug" mono>
                  {collection.slug}
                </Field>
                <Field label="Module">{collection.module}</Field>
                <Field
                  label="Recorded item count"
                  hint="Maintained on the collection. The table counts actual membership rows."
                >
                  {collection.itemCount !== items.length ? (
                    <span className="text-[var(--color-tone-warning)]">
                      {collection.itemCount} recorded, {items.length} actual
                    </span>
                  ) : (
                    String(collection.itemCount)
                  )}
                </Field>
                <Field label="Published items">{publishedItems}</Field>
                <Field label="Published at">
                  <Timestamp value={collection.publishedAt} />
                </Field>
                <Field label="Created">
                  <Timestamp value={collection.createdAt} />
                </Field>
                <Field label="Updated">
                  <Timestamp value={collection.updatedAt} />
                </Field>
                <Field label="Collection ID" mono>
                  {collection.id}
                </Field>
              </FieldList>
            </Panel>

            <p className="text-2xs leading-relaxed text-ink-500">
              Making a collection public does not publish its contents, and publishing a record does
              not add it to any collection. Both gates are applied at read time by{" "}
              <MonoValue value="listPublicCollections" />, so a record withdrawn from the public API
              disappears from every public collection immediately without anyone editing the
              collection.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
