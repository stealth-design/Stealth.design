import Link from "next/link";
import { listCollections } from "@uxd/api";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  PageHeader,
  Panel,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Collections" };

/**
 * Curated sets (§11).
 *
 * The column that matters is the gap between item count and published count. A
 * collection is a curatorial statement, and one whose items are mostly
 * unpublished says something different to a visitor than it does to the curator
 * — the public API only ever serves the published subset, so a "12 examples"
 * collection can arrive as three. Showing both numbers side by side makes that
 * discrepancy something a curator notices before a visitor does.
 */
export default async function CollectionsPage() {
  const context = await getAdminContextWith("collection.read");
  const collections = await listCollections(context.db);

  const publicCollections = collections.filter((row) => row.visibility === "public");
  const incomplete = collections.filter(
    (row) => row.visibility === "public" && row.publishedItemCount < row.itemCount,
  );

  return (
    <>
      <PageHeader
        title="Collections"
        description="Curated sets of content, for internal reference or for the public site."
        count={`${collections.length} collections · ${publicCollections.length} public`}
      />

      <div className="space-y-3 p-4">
        {incomplete.length > 0 ? (
          <p className="text-2xs text-[var(--color-tone-warning)]">
            {incomplete.length} public{" "}
            {incomplete.length === 1 ? "collection contains items that are" : "collections contain items that are"}{" "}
            not published, so visitors see fewer entries than the count suggests.
          </p>
        ) : null}

        <Panel>
          {collections.length === 0 ? (
            <EmptyState
              title="No collections yet"
              description="A collection groups content for a purpose — a research theme, a pattern study, a set for the public site. Membership is explicit and ordered."
              action={<LinkButton href="/content">Browse content</LinkButton>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th className="w-24">Visibility</th>
                  <th className="w-24">Status</th>
                  <th className="w-20 text-right">Items</th>
                  <th className="w-24 text-right">Published</th>
                  <th className="w-32">Curator</th>
                  <th className="w-24">Updated</th>
                </tr>
              </thead>
              <tbody>
                {collections.map((row) => {
                  const shortfall = row.itemCount - row.publishedItemCount;
                  return (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/collections/${row.id}`} className="font-medium hover:underline">
                          {row.name}
                        </Link>
                        <InlineMeta items={[row.slug, row.module, row.description]} />
                      </td>
                      <td>
                        <Badge tone={row.visibility === "public" ? "success" : "neutral"}>
                          {row.visibility}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={row.status === "active" ? "success" : "neutral"}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {row.itemCount.toLocaleString("en-US")}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.publishedItemCount > 0 ? (
                          <span
                            className={
                              shortfall > 0 && row.visibility === "public"
                                ? "text-[var(--color-tone-warning)]"
                                : "text-[var(--color-tone-success)]"
                            }
                            title={
                              shortfall > 0
                                ? `${shortfall} of this collection's items are not published, so the public API omits them.`
                                : "Every item is live."
                            }
                          >
                            {row.publishedItemCount.toLocaleString("en-US")}
                          </span>
                        ) : (
                          <span className="text-ink-400">0</span>
                        )}
                      </td>
                      <td className="truncate-cell text-ink-600">{row.curatorName ?? "—"}</td>
                      <td>
                        <Timestamp value={row.updatedAt} relative />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <p className="max-w-3xl text-2xs leading-relaxed text-ink-500">
          A public collection is served by the public API only while its status is active and its
          visibility public, and it only ever carries its published items — the same publish gate
          every record passes, applied again at read time. Making a collection public does not
          publish its contents.
        </p>
      </div>
    </>
  );
}
