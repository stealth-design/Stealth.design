import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import clsx from "clsx";
import {
  canDiscardScreen,
  getProduct,
  getProductPages,
  listTaxonomyTerms,
  type ProductPage,
  type ProductState,
} from "@uxd/api";
import { can } from "@uxd/auth";
import type { StudioProfile } from "@uxd/types";
import { Page } from "@/components/page";
import type { TagOption } from "@/components/tag-picker";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { CaptureAgain, CaptureBox } from "./capture";
import { EditProduct } from "./edit-product";
import { AllowCapturing } from "@/components/take-down";
import { LocalTime } from "@/components/local-time";
import { StateTile, type StateStage } from "./state-tile";

/**
 * A product's page — where creation happens. Top to bottom it answers: what do
 * I do here (capture), where are things up to (the three stages), and what do
 * I have (its pages, each with its states side by side).
 *
 * Nothing here publishes. That happens in the Inbox, behind its own
 * permission, so someone with creation access can do everything on this page
 * and still never make anything public.
 */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getAdminContextWith("source.read");
  const product = await getProduct(context.db, id);
  if (!product) notFound();

  const [pages, terms] = await Promise.all([
    getProductPages(context.db, id),
    listTaxonomyTerms(context.db, { statuses: ["active"] }),
  ]);
  const tags: TagOption[] = terms.map((term) => ({
    id: term.id,
    name: term.name,
    kind: term.kind,
    usageCount: term.usageCount,
    aliases: term.aliases,
  }));
  const states = pages.flatMap((page) => page.states);
  const thumbnails = await resolveMediaUrls(states.map((state) => state.thumbnailKey));

  const host = product.domain ?? "";
  const origin = product.canonicalUrl ?? (host ? `https://${host}` : "");
  const counts = {
    inbox: states.filter((state) => stageOf(state) === "inbox").length,
    draft: states.filter((state) => stageOf(state) === "draft").length,
    published: states.filter((state) => stageOf(state) === "published").length,
  };

  return (
    <Page
      back={{ label: "Products", href: "/products" }}
      title={product.name}
      description={<span className="font-mono text-xs">{host}</span>}
      actions={
        <>
          <EditProduct sourceId={product.id} name={product.name} />
          {origin ? (
            <a
              href={origin}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 items-center gap-1.5 rounded-md border border-ink-200 px-3 text-xs text-ink-700 transition-colors hover:border-ink-300 hover:bg-ink-100 hover:text-ink-900"
            >
              Visit site
              <ArrowUpRight aria-hidden className="size-3" />
            </a>
          ) : null}
        </>
      }
    >
      {product.blockedAt ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-300 bg-surface p-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink-900">Taken down — nothing from {product.name} is on the public site.</p>
            <p className="mt-1 text-xs text-ink-500">
              <LocalTime iso={product.blockedAt.toISOString()} />
              {product.blockedReason ? ` · ${product.blockedReason}` : ""}. Capturing is blocked; its screens are in
              Drafts.
            </p>
          </div>
          {can(context.actor, "content.unpublish") ? <AllowCapturing productId={product.id} /> : null}
        </div>
      ) : (
        <CaptureBox sourceId={product.id} origin={origin} host={host} tags={tags} />
      )}

      {states.length === 0 ? (
        <p className="mt-10 text-center text-[13px] text-ink-500">
          Nothing captured yet. Start with the home page — leave the address empty and press Capture screens.
        </p>
      ) : (
        <>
          <Stages productId={product.id} counts={counts} />

          <section className="mt-12" aria-labelledby="pages-heading">
            <h2 id="pages-heading" className="flex items-baseline gap-2 text-[13px] text-ink-900">
              Pages <span className="font-mono text-xs text-ink-400">{pages.length}</span>
            </h2>
            <div className="mt-4 space-y-10">
              {pages.map((page) => (
                <PageRow
                  key={page.path}
                  sourceId={product.id}
                  page={page}
                  tags={tags}
                  thumbnails={thumbnails}
                  discardable={(state) =>
                    canDiscardScreen(context.actor, {
                      createdBy: state.createdBy,
                      status: state.status,
                      everPublished: state.everPublished,
                    })
                  }
                />
              ))}
            </div>
          </section>
        </>
      )}
    </Page>
  );
}

function stageOf(state: ProductState): StateStage {
  if (state.status === "published") return "published";
  if (state.status === "approved") return "draft";
  return "inbox";
}

/** The three stages, in order. The one with something waiting is a way to it. */
function Stages({ productId, counts }: { productId: string; counts: Record<StateStage, number> }) {
  return (
    <ol className="mt-6 grid grid-cols-1 overflow-hidden rounded-xl border border-ink-200 sm:grid-cols-3">
      <li className="border-b border-ink-200 sm:border-b-0 sm:border-r">
        {counts.inbox > 0 ? (
          <Link
            href={`/inbox/${productId}`}
            className="group flex h-full items-center gap-3 p-4 transition-colors hover:bg-ink-100"
          >
            <Stage dot="bg-[var(--color-tone-warning)]" value={counts.inbox} label="In inbox" />
            <span className="ml-auto flex items-center gap-1 text-xs text-ink-600 group-hover:text-ink-900">
              Review them <ArrowRight aria-hidden className="size-3" />
            </span>
          </Link>
        ) : (
          <div className="flex items-center gap-3 p-4">
            <Stage dot="bg-ink-300" value={0} label="In inbox" />
          </div>
        )}
      </li>
      <li className="flex items-center gap-3 border-b border-ink-200 p-4 sm:border-b-0 sm:border-r">
        <Stage dot={counts.draft > 0 ? "bg-ink-500" : "bg-ink-300"} value={counts.draft} label="Drafts" />
      </li>
      <li className="flex items-center gap-3 p-4">
        <Stage
          dot={counts.published > 0 ? "bg-[var(--color-tone-success)]" : "bg-ink-300"}
          value={counts.published}
          label="Published"
        />
      </li>
    </ol>
  );
}

function Stage({ dot, value, label }: { dot: string; value: number; label: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden className={clsx("size-2 rounded-full", dot)} />
      <span className={clsx("font-mono text-lg leading-none", value > 0 ? "text-ink-900" : "text-ink-400")}>{value}</span>
      <span className="text-xs text-ink-500">{label}</span>
    </span>
  );
}

function PageRow({
  sourceId,
  page,
  tags,
  thumbnails,
  discardable,
}: {
  sourceId: string;
  page: ProductPage;
  tags: readonly TagOption[];
  thumbnails: Map<string, string>;
  discardable: (state: ProductState) => boolean;
}) {
  // Unnamed states are the plain view of the page; when there are several,
  // number them so each tile can be told apart.
  let unnamed = 0;
  const unnamedTotal = page.states.filter((state) => !state.label).length;
  const labelled = page.states.map((state) => {
    if (state.label) return state.label;
    unnamed += 1;
    return unnamedTotal > 1 ? `Default ${unnamed}` : "Default";
  });

  const mobileCount = page.states.filter((state) => state.deviceProfile === "mobile_390").length;
  const profile: StudioProfile = mobileCount > page.states.length / 2 ? "mobile_390" : "desktop_1440";

  return (
    <div className="border-t border-ink-200 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="text-[15px] font-medium text-ink-900">{page.name}</h3>
          <span className="truncate font-mono text-xs text-ink-500">{page.path}</span>
          <span className="shrink-0 text-xs text-ink-400">
            {page.states.length} {page.states.length === 1 ? "state" : "states"}
          </span>
        </div>
        {page.url ? <CaptureAgain sourceId={sourceId} url={page.url} profile={profile} tags={tags} /> : null}
      </div>

      <div className="-mx-6 mt-4 overflow-x-auto px-6 pb-2 md:-mx-10 md:px-10">
        <ul className="flex w-max gap-4">
          {page.states.map((state, index) => (
            <li key={state.id}>
              <StateTile
                id={state.id}
                label={labelled[index] ?? "Default"}
                stage={stageOf(state)}
                thumbnail={state.thumbnailKey ? (thumbnails.get(state.thumbnailKey) ?? null) : null}
                mobile={state.deviceProfile === "mobile_390"}
                discardable={discardable(state)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
