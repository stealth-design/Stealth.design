import Link from "next/link";
import type { PublicContentSummary, PublicMedia, PublicSourceSummary } from "@uxd/api/client";
import type { Slide } from "@/components/viewer";
import { displayUrl } from "@/lib/format";
import { stageSrcSet, thumbSrc } from "@/lib/media";
import { cn } from "@/lib/utils";

/**
 * The room around the screens: page intros, contact sheets, product rows,
 * quiet filters and lists. Presentation only — pages fetch, these render.
 */

/** The page's width and gutters. */
export function Room({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-[1600px] px-5 md:px-8", className)}>{children}</div>;
}

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/**
 * A page's opening, kept small: where you are, what this is, how many.
 * Nothing here is large — the largest thing on any page is a screenshot.
 */
export function PageIntro({
  title,
  count,
  description,
  crumbs,
  children,
}: {
  title: string;
  count?: string;
  description?: React.ReactNode;
  crumbs?: readonly Crumb[];
  children?: React.ReactNode;
}) {
  return (
    <Room className="pt-10 pb-10 md:pt-14">
      {crumbs ? (
        <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap gap-x-2 text-[12px] text-faint">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex gap-x-2">
              {index > 0 ? <span aria-hidden>/</span> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="transition-colors hover:text-lit">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-dim">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[20px] font-medium tracking-[-0.015em] text-lit">{title}</h1>
        {count ? <span className="num text-[12px] text-faint">{count}</span> : null}
      </div>
      {description ? <div className="mt-2 max-w-xl text-[13px] leading-relaxed text-dim">{description}</div> : null}
      {children ? <div className="mt-6">{children}</div> : null}
    </Room>
  );
}

/** A section's label row inside a page. */
export function SectionLabel({
  title,
  count,
  href,
  hrefLabel = "View all",
}: {
  title: string;
  count?: number;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="mb-5 flex items-baseline gap-3">
      <h2 className="text-[13px] font-medium text-lit">{title}</h2>
      {count !== undefined ? <span className="num text-[12px] text-faint">{count}</span> : null}
      {href ? (
        <Link href={href} className="ml-auto text-[12px] text-dim transition-colors hover:text-lit">
          {hrefLabel} →
        </Link>
      ) : null}
    </div>
  );
}

// --- Screenshots ----------------------------------------------------------

/**
 * One screenshot. Frames crop to 16:10 from the top so a sheet stays calm;
 * `full` keeps the capture's own proportions.
 */
export function Shot({
  media,
  title,
  full = false,
  priority = false,
  className,
}: {
  media: PublicMedia | null;
  title: string;
  full?: boolean;
  priority?: boolean;
  className?: string;
}) {
  if (!media) {
    return (
      <div className={cn("flex aspect-[16/10] items-center justify-center bg-shot text-[12px] text-faint", className)}>
        No screenshot
      </div>
    );
  }
  const srcSet = full ? stageSrcSet(media) : undefined;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={cn("shot-img", className)}
      style={full && media.width && media.height ? { aspectRatio: `${media.width} / ${media.height}` } : { aspectRatio: "16 / 10" }}
      src={full ? (media.largeUrl ?? media.previewUrl ?? media.url) : thumbSrc(media)}
      srcSet={srcSet}
      sizes={srcSet ? "(max-width: 768px) 100vw, 1500px" : undefined}
      alt={media.altText ?? `Screenshot of ${title}`}
      width={media.width ?? undefined}
      height={media.height ?? undefined}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

// --- Screens as slides ----------------------------------------------------

export function entryHref(item: PublicContentSummary): string {
  return item.kind === "flow" ? `/flow/${item.slug}` : `/entry/${item.slug}`;
}

/** "Screen name, state" — the dim half of a caption. */
export function screenSubtitle(item: PublicContentSummary): string {
  return [item.title, item.stateLabel].filter(Boolean).join(", ");
}

/** A record as a slide for the viewer: the product lit, the screen dim. */
export function toSlide(item: PublicContentSummary): Slide {
  return {
    id: item.id,
    href: entryHref(item),
    title: item.source?.name ?? item.title,
    subtitle: item.source ? screenSubtitle(item) : item.stateLabel,
    media: item.primaryMedia,
  };
}

// --- The contact sheet ----------------------------------------------------

/**
 * Screens as a contact sheet: numbered frames at a dimmed exposure that come
 * up to full brightness under the pointer. The numbers run on across pages,
 * so frame 031 on page two is frame 031 everywhere.
 */
export function ContactSheet({
  items,
  numberFrom = 1,
  showSource = true,
  size = "md",
}: {
  items: readonly PublicContentSummary[];
  numberFrom?: number;
  showSource?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <ol
      className={cn(
        "grid gap-x-4 gap-y-8",
        size === "md" ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      )}
    >
      {items.map((item, index) => (
        <li key={item.id}>
          <Link href={entryHref(item)} className="group block" aria-label={item.title}>
            <div className="overflow-hidden rounded-[4px] opacity-75 ring-1 ring-white/[0.06] transition-all duration-300 group-hover:opacity-100 group-hover:ring-white/15">
              <Shot media={item.primaryMedia} title={item.title} priority={index < 4} />
            </div>
            <div className="mt-2.5 flex items-baseline gap-2.5 text-[12px]">
              <span className="num text-faint">{String(numberFrom + index).padStart(3, "0")}</span>
              <span className="min-w-0 truncate text-dim transition-colors group-hover:text-lit">
                {showSource && item.source ? <span className="text-lit/80">{item.source.name} </span> : null}
                {screenSubtitle(item)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/**
 * A product as a row: its name and a strip of its frames. The strip runs off
 * the edge when there are more than fit, like a roll of film.
 */
export function ProductRow({
  source,
  count,
  items,
}: {
  source: PublicSourceSummary;
  count: number;
  items: readonly PublicContentSummary[];
}) {
  return (
    <section className="border-t border-white/[0.06] py-8">
      <Room className="mb-4 flex items-baseline gap-3">
        <Link href={`/sources/${source.slug}`} className="text-[15px] font-medium text-lit hover:opacity-70">
          {source.name}
        </Link>
        {source.domain ? <span className="text-[12px] text-faint">{source.domain}</span> : null}
        <span className="num ml-auto text-[12px] text-faint">{count === 1 ? "1 screen" : `${count} screens`}</span>
        <Link href={`/sources/${source.slug}`} className="text-[12px] text-dim hover:text-lit">
          Open →
        </Link>
      </Room>
      <div className="no-scrollbar overflow-x-auto">
        <ol className="flex w-max gap-3 px-5 md:px-8">
          {items.map((item) => (
            <li key={item.id} className="w-[260px] md:w-[320px]">
              <Link href={entryHref(item)} className="group block" aria-label={item.title}>
                <div className="overflow-hidden rounded-[4px] opacity-75 ring-1 ring-white/[0.06] transition-all duration-300 group-hover:opacity-100 group-hover:ring-white/15">
                  <Shot media={item.primaryMedia} title={item.title} />
                </div>
                <p className="mt-2 truncate text-[12px] text-dim group-hover:text-lit">{screenSubtitle(item)}</p>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// --- Filters --------------------------------------------------------------

export interface FilterOption {
  readonly label: string;
  readonly href: string;
  readonly count?: number;
  readonly active?: boolean;
  readonly title?: string;
}

/** Filters as quiet text: the one that is on is lit, the rest are dim. */
export function Filters({ label, options }: { label?: string; options: readonly FilterOption[] }) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {label ? <span className="mr-2 text-[12px] text-faint">{label}</span> : null}
      {options.map((option) => (
        <Link
          key={option.href + option.label}
          href={option.href}
          title={option.title}
          aria-current={option.active ? "true" : undefined}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors",
            option.active ? "bg-accent text-lit" : "text-dim hover:text-lit",
          )}
        >
          {option.label}
          {option.count !== undefined ? <span className="num text-[11px] text-faint">{option.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}

// --- Metadata -------------------------------------------------------------

/** Label and value rows, for the details panel. */
export function Facts({
  items,
}: {
  items: readonly { label: string; value: React.ReactNode | string | null }[];
}) {
  const present = items.filter(
    (item) => item.value !== null && item.value !== undefined && item.value !== "",
  );
  if (present.length === 0) return null;
  return (
    <dl className="divide-y divide-white/[0.06] text-[13px]">
      {present.map((item) => (
        <div key={item.label} className="flex gap-4 py-2.5">
          <dt className="w-24 shrink-0 text-faint">{item.label}</dt>
          <dd className="min-w-0 break-words text-lit">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where an image came from. (When it was captured is kept for the team and
 * deliberately not shown.) These are other people's interfaces,
 * and provenance is part of the record. `nofollow` because a library linking
 * out at scale should not hand out ranking it did not intend to.
 */
export function Provenance({
  sourceUrl,
  attribution,
}: {
  sourceUrl: string | null;
  attribution: string | null;
}) {
  const shown = displayUrl(sourceUrl);
  return (
    <p className="text-[12px] leading-relaxed text-faint">
      {shown ? (
        <>
          Captured from{" "}
          {sourceUrl ? (
            <a href={sourceUrl} rel="nofollow noreferrer" className="text-dim underline underline-offset-4 hover:text-lit">
              {shown}
            </a>
          ) : (
            shown
          )}
        </>
      ) : (
        "Source URL not recorded"
      )}
      {attribution ? ` · ${attribution}` : null}
    </p>
  );
}

/** Nothing to show: said quietly, in the middle of the room. */
export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Room className="flex min-h-[40vh] flex-col items-center justify-center text-center">
      <p className="text-[15px] text-lit">{title}</p>
      {children ? <div className="mt-2 max-w-sm text-[13px] leading-relaxed text-dim">{children}</div> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </Room>
  );
}

/** Previous · page N of M · next. */
export function Pager({ page, totalPages, href }: { page: number; totalPages: number; href: (page: number) => string }) {
  if (totalPages <= 1) return null;
  return (
    <Room className="mt-16 flex items-center justify-center gap-6 text-[13px]">
      {page > 1 ? (
        <Link href={href(page - 1)} className="text-dim hover:text-lit">
          ← Previous
        </Link>
      ) : (
        <span className="text-faint">← Previous</span>
      )}
      <span className="num text-[12px] text-faint">
        {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={href(page + 1)} className="text-dim hover:text-lit">
          Next →
        </Link>
      ) : (
        <span className="text-faint">Next →</span>
      )}
    </Room>
  );
}

/** The one filled button: light on dark. */
export function LightLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center gap-2 rounded-md bg-lit px-3.5 text-[13px] font-medium text-background transition-opacity hover:opacity-85"
    >
      {children}
    </Link>
  );
}
