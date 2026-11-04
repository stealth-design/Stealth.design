import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/gallery";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";

export const metadata = { title: "Collections" };

/** Curated sets, as a list of rows: number, name, description, size. */
export default async function CollectionsPage() {
  const collections = [...(await api.listCollections())].sort(
    (a, b) => Number(b.itemCount > 0) - Number(a.itemCount > 0),
  );

  return (
    <>
      <PageHeader
        label={plural(collections.length, "collection")}
        title="Collections"
        note="Sets of websites, grouped around an idea."
      />

      {collections.length === 0 ? (
        <EmptyState title="No collections yet" />
      ) : (
        <ol className="border-b">
          {collections.map((collection, index) => (
            <li key={collection.id} className="border-t">
              <Link
                href={`/browse?collection=${encodeURIComponent(collection.slug)}`}
                className={
                  collection.itemCount > 0
                    ? "group page-grid items-baseline gap-y-3 py-8 transition-colors hover:bg-muted"
                    : "group page-grid items-baseline gap-y-3 py-8 text-muted-foreground transition-colors hover:bg-muted"
                }
              >
                <span className="t-label col-span-1 text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="t-card col-span-3 md:col-span-5 md:col-start-2">
                  {collection.name}
                </span>
                <span className="col-span-full text-[15px] leading-relaxed font-light text-muted-foreground md:col-span-4 md:col-start-7">
                  {collection.description}
                </span>
                <span className="t-label col-span-full flex items-center justify-end gap-2 md:col-span-2 md:col-start-11">
                  {collection.itemCount > 0
                    ? plural(collection.itemCount, "website")
                    : "Empty"}
                  <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
