import Link from "next/link";
import { EmptyState, PageIntro, Room } from "@/components/gallery";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";

export const metadata = { title: "Collections" };

/** Curated sets, as a quiet list. */
export default async function CollectionsPage() {
  const collections = [...(await api.listCollections())].sort(
    (a, b) => Number(b.itemCount > 0) - Number(a.itemCount > 0),
  );

  return (
    <>
      <PageIntro
        title="Collections"
        count={plural(collections.length, "collection")}
        description="Curated sets of screens, in the order they were arranged."
      />
      {collections.length === 0 ? (
        <EmptyState title="No collections yet" />
      ) : (
        <Room>
          <ul className="max-w-3xl divide-y divide-white/[0.06] border-y border-white/[0.06]">
            {collections.map((collection) => (
              <li key={collection.id}>
                <Link href={`/browse?collection=${encodeURIComponent(collection.slug)}`} className="group flex items-baseline gap-6 py-4">
                  <span className="min-w-0 flex-1">
                    <span className={collection.itemCount > 0 ? "text-[14px] text-lit" : "text-[14px] text-dim"}>{collection.name}</span>
                    {collection.description ? (
                      <span className="mt-1 block text-[13px] leading-relaxed text-faint group-hover:text-dim">{collection.description}</span>
                    ) : null}
                  </span>
                  <span className="num shrink-0 text-[12px] text-faint">
                    {collection.itemCount > 0 ? plural(collection.itemCount, "entry", "entries") : "empty"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Room>
      )}
    </>
  );
}
