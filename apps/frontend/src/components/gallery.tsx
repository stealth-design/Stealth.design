import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Children } from "react";
import type {
  PublicContentSummary,
  PublicMedia,
  PublicSourceSummary,
} from "@uxd/api/client";
import { Reveal } from "@/components/reveal";
import { displayUrl, humanise } from "@/lib/format";
import { itemPath, websitePath } from "@/lib/paths";
import { cn } from "@/lib/utils";

/**
 * The pieces every page is built from, all on the page grid.
 *
 * Presentation only: pages fetch from the public API and hand plain records
 * to these. Nothing here fetches, and nothing here knows which page it is on.
 */

// --- Page furniture -------------------------------------------------------

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/**
 * The top of a page: a title in capitals on the left, the mono note that
 * explains it on the right, both sitting on the same baseline — the way the
 * page states what it is before showing anything.
 */
export function PageHeader({
  title,
  label,
  note,
  actions,
  crumbs,
}: {
  title: string;
  label?: string;
  note?: React.ReactNode;
  actions?: React.ReactNode;
  crumbs?: readonly Crumb[];
}) {
  return (
    <header className="page-grid gap-y-6 pt-16 pb-14 md:pt-24 md:pb-20">
      {crumbs ? (
        <nav
          aria-label="Breadcrumb"
          className="t-label col-span-full flex flex-wrap gap-x-2 text-muted-foreground"
        >
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex gap-x-2">
              {index > 0 ? <span aria-hidden>/</span> : null}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-foreground">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <Reveal className="col-span-full md:col-span-8">
        {label ? (
          <p className="t-label mb-5 text-muted-foreground">{label}</p>
        ) : null}
        <h1 className="t-display break-words">{title}</h1>
      </Reveal>
      {note || actions ? (
        <Reveal
          delay={0.05}
          className="col-span-full flex flex-col gap-6 self-end md:col-span-4 md:col-start-9"
        >
          {note ? (
            <div className="t-note max-w-md text-muted-foreground">{note}</div>
          ) : null}
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </Reveal>
      ) : null}
    </header>
  );
}

/** A section's opening: the same title-left, note-right composition, smaller. */
export function SectionHeader({
  title,
  note,
  href,
  hrefLabel = "See all",
}: {
  title: string;
  note?: React.ReactNode;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="page-grid mb-10 gap-y-5 md:mb-14">
      <h2 className="t-h2 col-span-full md:col-span-7">{title}</h2>
      <div className="col-span-full flex items-end justify-between gap-6 self-end md:col-span-4 md:col-start-9">
        {note ? (
          <p className="t-note max-w-sm text-muted-foreground">{note}</p>
        ) : (
          <span />
        )}
        {href ? (
          <Link
            href={href}
            className="t-note group inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"
          >
            {hrefLabel}
            <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** The full-width black bar that ends a section: "see all …". */
export function SeeAllBar({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group mt-16 flex h-20 items-center justify-center gap-3 bg-ink text-ink-foreground md:mt-20"
    >
      <span className="t-note text-[clamp(1rem,1.6vw,1.5rem)]">{children}</span>
      <ArrowRight className="size-5 text-brand transition-transform group-hover:translate-x-1" />
    </Link>
  );
}

// --- Screenshots ----------------------------------------------------------

const SHOT_SIZES = "(max-width: 768px) 100vw, 1360px";

/** A card's rendered width: one column on phones, then two, then three. */
const CARD_SIZES = "(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 34vw";

/**
 * The whole-page renditions, ascending, as a srcset. The original master is
 * excluded: a lossless PNG that can run to many megabytes.
 */
function uncroppedSrcSet(media: PublicMedia): string | undefined {
  const originalWidth = media.width ?? null;
  const candidates: { url: string; width: number }[] = [];
  const seen = new Set<number>();

  for (const [url, cap] of [
    [media.previewUrl, 1024],
    [media.largeUrl, 2048],
  ] as const) {
    if (!url) continue;
    const width = originalWidth === null ? cap : Math.min(cap, originalWidth);
    if (seen.has(width)) continue;
    seen.add(width);
    candidates.push({ url, width });
  }

  if (candidates.length < 2) return undefined;
  return candidates
    .sort((a, b) => a.width - b.width)
    .map((c) => `${c.url} ${c.width}w`)
    .join(", ");
}

/**
 * One screenshot.
 *
 * Tiles crop to a fixed ratio from the top, so a grid stays calm across
 * captures of different shapes; `full` keeps the capture's own proportions.
 *
 * Tiles are cropped by CSS, not by using the stored thumbnail: that is only
 * 480px wide, which a card on a high-density screen shows at nearly twice its
 * size — visibly soft. The 1024px and 2048px renditions are offered instead
 * and the browser picks by the card's width. The thumbnail is only a last
 * resort, and never joins the srcset, because srcset candidates must be the
 * same picture at different resolutions.
 */
export function Shot({
  media,
  title,
  size = "thumb",
  ratio = "16 / 10",
  full = false,
  priority = false,
  className,
}: {
  media: PublicMedia | null;
  title: string;
  size?: "thumb" | "preview" | "full";
  ratio?: string;
  full?: boolean;
  priority?: boolean;
  className?: string;
}) {
  if (!media) {
    return (
      <div
        className={cn(
          "t-label flex items-center justify-center bg-shot text-muted-foreground",
          className,
        )}
        style={{ aspectRatio: ratio }}
      >
        Image coming soon
      </div>
    );
  }

  const cropped = size === "thumb";
  const srcSet = uncroppedSrcSet(media);
  const src = cropped
    ? (media.previewUrl ?? media.largeUrl ?? media.thumbnailUrl ?? media.url)
    : (media.largeUrl ?? media.previewUrl ?? media.url);

  const style =
    full && media.width && media.height
      ? { aspectRatio: `${media.width} / ${media.height}` }
      : { aspectRatio: ratio };

  const isPortrait =
    !full &&
    !cropped &&
    media.width !== null &&
    media.height !== null &&
    media.height > media.width * 1.2;

  return (
    // A plain <img>: these come from the CMS's media origin at known sizes,
    // and an optimiser hop would add latency for no gain.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={cn("shot-img", className)}
      data-portrait={isPortrait ? "true" : undefined}
      style={style}
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? (cropped ? CARD_SIZES : SHOT_SIZES) : undefined}
      alt={media.altText ?? `Screenshot of ${title}`}
      width={media.width ?? undefined}
      height={media.height ?? undefined}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
    />
  );
}

/** The one label allowed on an image: white, square-cornered, top right. */
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute top-3 right-3 rounded-[4px] bg-white px-2 py-1 text-[15px] leading-none font-medium tracking-[-0.01em] text-black">
      {children}
    </span>
  );
}

// --- Cards ----------------------------------------------------------------

function entryHref(item: PublicContentSummary): string {
  return itemPath(item);
}

/**
 * A website's logo, as a small rounded tile. Without one, the first letter
 * of its name stands in, so every card keeps the same shape.
 */
export function SiteLogo({
  source,
  size = 24,
  className,
}: {
  source: Pick<PublicSourceSummary, "name" | "logoUrl">;
  size?: number;
  className?: string;
}) {
  const frame = cn(
    // A faint inner edge, drawn over the image, so a dark icon still reads
    // as a tile against the black page.
    "relative flex shrink-0 items-center justify-center overflow-hidden",
    "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-white/15 after:ring-inset",
    className,
  );
  const radius = Math.max(6, Math.round(size * 0.24));
  if (source.logoUrl) {
    // Always a square, like an app icon. The icon arrives as a solid tile
    // with its own background, so it fills the square: no frame, padding or
    // border around it.
    return (
      <span
        className={frame}
        style={{ width: size, height: size, borderRadius: radius }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={source.logoUrl}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        frame,
        "bg-muted font-medium text-muted-foreground uppercase",
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.45),
      }}
    >
      {source.name.trim().charAt(0) || "?"}
    </span>
  );
}

/**
 * The website's own address, opened in a new tab. `nofollow` because a
 * library linking out at scale should not hand out ranking it did not intend
 * to; `noopener` so the opened site cannot reach back into this tab.
 */
function ViewWebsite({
  href,
  className,
}: {
  href: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="nofollow noopener noreferrer"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3.5 text-[13px] font-medium tracking-[-0.01em] text-black shadow-[0_4px_16px_rgba(0,0,0,0.18)] transition hover:bg-neutral-100",
        className,
      )}
    >
      View website
      <ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  );
}

/**
 * A screen, as a card: the screenshot in a soft frame, and the website it
 * came from underneath — logo on the left, then its name.
 *
 * Hovering the card brings up "View website", which goes to the site itself.
 * On touch screens, where nothing hovers, it is always shown. The screenshot
 * and the "View website" button are separate links side by side, never one
 * inside the other.
 */
export function ScreenCard({
  item,
  priority = false,
  showSource = true,
}: {
  item: PublicContentSummary;
  priority?: boolean;
  showSource?: boolean;
}) {
  const href = entryHref(item);
  const source = item.source;
  const website = source?.websiteUrl ?? null;
  const name = showSource && source ? source.name : item.title;
  const aside = item.deviceClass === "mobile" ? "Mobile" : null;

  return (
    <article className="group">
      <div className="relative overflow-hidden rounded-xl bg-shot">
        <Link
          href={href}
          aria-label={`${name}, ${item.title}`}
          className="block"
        >
          <Shot
            media={item.primaryMedia}
            title={item.title}
            priority={priority}
            className="transition-transform duration-700 ease-out group-hover:scale-[1.03]"
          />
        </Link>
        {website ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/35 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            />
            <ViewWebsite
              href={website}
              className="absolute right-3 bottom-3 translate-y-1.5 opacity-0 duration-300 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100"
            />
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-3 pt-3">
        {showSource && source ? (
          <Link
            href={websitePath(source.slug)}
            className="flex min-w-0 flex-1 items-center gap-3 transition-opacity hover:opacity-70"
          >
            <SiteLogo source={source} size={40} />
            <h3 className="min-w-0 truncate text-[16px] leading-tight font-medium tracking-[-0.015em]">
              {name}
            </h3>
          </Link>
        ) : (
          <h3 className="min-w-0 flex-1 truncate text-[15px] leading-tight font-medium tracking-[-0.015em]">
            <Link href={href} className="transition-opacity hover:opacity-60">
              {name}
            </Link>
          </h3>
        )}
        {aside ? (
          <span className="t-label shrink-0 text-muted-foreground">
            {aside}
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** A product: its most recent capture, large, with the name and domain below. */
export function ProductCard({
  source,
  cover,
  count,
  priority = false,
}: {
  source: PublicSourceSummary;
  cover: PublicMedia | null;
  count: number;
  priority?: boolean;
}) {
  return (
    <article className="group">
      <Link
        href={websitePath(source.slug)}
        className="relative block overflow-hidden rounded-lg"
      >
        <Shot
          media={cover}
          title={source.name}
          priority={priority}
          className="transition-transform duration-700 ease-out group-hover:scale-[1.02]"
        />
        <Tag>{humanise(source.type)}</Tag>
      </Link>
      <div className="mt-4 flex items-baseline justify-between gap-4">
        <h3 className="t-card">
          <Link
            href={websitePath(source.slug)}
            className="transition-opacity hover:opacity-60"
          >
            {source.name}
          </Link>
        </h3>
        <p className="t-label shrink-0 text-muted-foreground">
          {count === 1 ? "1 screen" : `${count} screens`}
        </p>
      </div>
      {source.domain ? (
        <p className="t-label mt-1 text-muted-foreground">{source.domain}</p>
      ) : null}
    </article>
  );
}

/**
 * Cards on the page grid. `columns` is how many cards share a row at
 * desktop: 2 (six columns each), 3 (four) or 4 (three).
 */
export function CardGrid({
  children,
  columns = 3,
}: {
  children: React.ReactNode;
  columns?: 2 | 3 | 4;
}) {
  const span = { 2: "md:col-span-6", 3: "md:col-span-4", 4: "md:col-span-3" }[
    columns
  ];
  return (
    <div className="page-grid gap-y-14 md:gap-y-16">
      {Children.map(children, (child, index) => (
        <Reveal
          key={index}
          delay={(index % columns) * 0.04}
          className={cn(columns === 4 ? "col-span-2" : "col-span-full", span)}
        >
          {child}
        </Reveal>
      ))}
    </div>
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

/**
 * Filters as outlined tags: square-cornered, in capitals, filled black when
 * on. Links, so every filtered view is a URL that works without JavaScript.
 */
export function Filters({ options }: { options: readonly FilterOption[] }) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <Link
          key={option.href + option.label}
          href={option.href}
          title={option.title}
          aria-current={option.active ? "true" : undefined}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-[6px] border px-3 text-[15px] tracking-[-0.01em] uppercase transition-colors",
            option.active
              ? "border-foreground bg-foreground text-background"
              : "border-foreground/80 hover:bg-foreground hover:text-background",
          )}
        >
          {option.label}
          {option.count !== undefined ? (
            <span className="font-mono text-[11px] tabular-nums opacity-60">
              {option.count.toLocaleString("en-US")}
            </span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

// --- Metadata -------------------------------------------------------------

/** Key and value pairs, as mono labels over plain values. */
export function Facts({
  items,
}: {
  items: readonly { label: string; value: React.ReactNode | string | null }[];
}) {
  const present = items.filter(
    (item) =>
      item.value !== null && item.value !== undefined && item.value !== "",
  );
  if (present.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-6">
      {present.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="t-label text-muted-foreground">{item.label}</dt>
          <dd className="mt-1.5 text-[17px] font-light break-words">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where an image came from. On every screen: these are
 * other people's interfaces, and provenance is part of the record.
 * `nofollow` because a library linking out at scale should not hand out
 * ranking it did not intend to.
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
    <p className="t-label text-muted-foreground">
      {shown ? (
        <>
          From{" "}
          {sourceUrl ? (
            <a
              href={sourceUrl}
              rel="nofollow noreferrer"
              className="text-foreground underline underline-offset-4"
            >
              {shown}
            </a>
          ) : (
            shown
          )}
        </>
      ) : null}
      {attribution ? ` · ${attribution}` : null}
    </p>
  );
}

/** Nothing to show: said plainly, at the size of a section title. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-grid">
      <div className="col-span-full border-t pt-10 pb-24 md:col-span-8">
        <p className="t-h2">{title}</p>
        {children ? (
          <div className="t-note mt-6 max-w-lg text-muted-foreground">
            {children}
          </div>
        ) : null}
        {action ? <div className="mt-8">{action}</div> : null}
      </div>
    </div>
  );
}

/** Previous, page N of M, next — as text, on the grid. */
export function Pager({
  page,
  totalPages,
  href,
}: {
  page: number;
  totalPages: number;
  href: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="page-grid mt-20 items-center" aria-label="Pages">
      <div className="col-span-1 md:col-span-4">
        {page > 1 ? (
          <Link
            href={href(page - 1)}
            className="t-nav inline-flex items-center gap-2 hover:opacity-60"
          >
            <ArrowLeft className="size-4" /> Previous
          </Link>
        ) : null}
      </div>
      <p className="t-label col-span-2 text-center text-muted-foreground md:col-span-4">
        Page {page} of {totalPages}
      </p>
      <div className="col-span-1 text-right md:col-span-4">
        {page < totalPages ? (
          <Link
            href={href(page + 1)}
            className="t-nav inline-flex items-center gap-2 hover:opacity-60"
          >
            Next <ArrowRight className="size-4" />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

/** The black block button. */
export function BlockLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="t-nav inline-flex h-11 items-center gap-2 rounded-[4px] bg-ink px-4 text-ink-foreground transition-opacity hover:opacity-80"
    >
      {children}
    </Link>
  );
}
