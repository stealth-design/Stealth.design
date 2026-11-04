import Link from "next/link";
import clsx from "clsx";
import { listProducts, type ProductListing } from "@uxd/api";
import { Page } from "@/components/page";
import { Timestamp } from "@/components/ui/primitives";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { AddProduct } from "./add-product";

export const metadata = { title: "Products" };

/**
 * Products: where the work starts. Paste an address to add one; every listed
 * product is a card that says, before it is opened, whether it has been
 * captured and where its screens are up to.
 */
export default async function ProductsPage() {
  const context = await getAdminContextWith("source.read");
  const products = await listProducts(context.db);
  const covers = await resolveMediaUrls(products.map((product) => product.coverKey));

  return (
    <Page title="Products" description="The websites and apps we study. Add one, then open it to capture its screens.">
      <AddProduct />

      <div className="mt-12">
        <p className="mb-4 font-mono text-xs text-ink-400">
          {products.length} {products.length === 1 ? "product" : "products"}
        </p>
        {products.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-200 py-16 text-center text-[13px] text-ink-500">
            No products yet. Paste a website address above to add the first one.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} cover={product.coverKey ? (covers.get(product.coverKey) ?? null) : null} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}

function ProductCard({ product, cover }: { product: ProductListing; cover: string | null }) {
  const screens = product.captured + product.draft + product.published;

  return (
    <Link
      href={`/products/${product.id}`}
      className="group block overflow-hidden rounded-xl border border-ink-200 bg-surface transition-colors hover:border-ink-300"
    >
      <div className="relative aspect-[16/10] overflow-hidden border-b border-ink-200 bg-ink-100">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.015]"
          />
        ) : (
          <Placeholder name={product.name} />
        )}
      </div>

      <div className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="truncate text-[15px] font-medium text-ink-900">{product.name}</h2>
          {screens > 0 ? (
            <span className="shrink-0 font-mono text-xs text-ink-500">
              {screens} {screens === 1 ? "screen" : "screens"}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{product.domain ?? "No address"}</p>

        <div className="mt-4 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {screens === 0 ? (
            <span className="text-ink-500">Not captured yet</span>
          ) : (
            <>
              <Count tone="captured" value={product.captured} label="in inbox" />
              <Count tone="draft" value={product.draft} label="draft" />
              <Count tone="published" value={product.published} label="published" />
            </>
          )}
        </div>

        <p className="mt-3 border-t border-ink-200 pt-3 text-[11px] text-ink-400">
          {product.lastScreenAt ? (
            <>
              Last captured <Timestamp value={product.lastScreenAt} relative />
            </>
          ) : (
            <>
              Added <Timestamp value={product.createdAt} relative />
            </>
          )}
        </p>
      </div>
    </Link>
  );
}

/** A product with no screenshot yet: its initial, so the grid still reads as a set of things. */
function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2">
      <span className="text-5xl font-medium tracking-tight text-ink-300">{name.slice(0, 1).toUpperCase()}</span>
      <span className="text-[11px] text-ink-400">No screenshots yet</span>
    </div>
  );
}

function Count({ tone, value, label }: { tone: "captured" | "draft" | "published"; value: number; label: string }) {
  return (
    <span className={clsx("flex items-center gap-1.5", value === 0 ? "text-ink-400" : "text-ink-700")}>
      <span
        aria-hidden
        className={clsx(
          "size-1.5 rounded-full",
          value === 0 && "bg-ink-300",
          value > 0 && tone === "captured" && "bg-[var(--color-tone-warning)]",
          value > 0 && tone === "draft" && "bg-ink-500",
          value > 0 && tone === "published" && "bg-[var(--color-tone-success)]",
        )}
      />
      <span className="font-mono">{value}</span> {label}
    </span>
  );
}
