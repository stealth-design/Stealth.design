import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { PublicContentSummary } from "@uxd/api/client";
import { Shot, SiteLogo } from "@/components/gallery";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { itemPath, websitePath } from "@/lib/paths";
import { cn } from "@/lib/utils";

/**
 * Three ways to draw a screen card, side by side on `/cards` so one can be
 * chosen. Whichever wins becomes `ScreenCard`; the others go.
 *
 *   A  shadcn's media card — image flush at the top of a ringed card, a
 *      header row under it with the title left and the action right
 *   B  HeroUI's cover card — the image is the card, and a frosted bar with
 *      the name and action sits over its bottom edge
 *   C  no card at all — the image in a thin ring, the name row beneath,
 *      the way large galleries do it so the screenshots carry the page
 *
 * All three share the rules: logo then name, "View website" on hover (always
 * shown where nothing hovers), and the image and the button are separate
 * links, never one inside the other.
 */

/** Shown on hover; always shown on touch screens, and when tabbed to. */
const REVEAL =
  "opacity-0 transition-[opacity,translate] duration-300 group-hover/card:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

function parts(item: PublicContentSummary) {
  return {
    href: itemPath(item),
    source: item.source,
    name: item.source?.name ?? item.title,
    website: item.source?.websiteUrl ?? null,
  };
}

function Visit({
  href,
  label = "View website",
  className,
  variant = "outline",
}: {
  href: string;
  label?: string;
  className?: string;
  variant?: "outline" | "secondary" | "ghost";
}) {
  return (
    <Button asChild size="sm" variant={variant} className={className}>
      <a href={href} target="_blank" rel="nofollow noopener noreferrer">
        {label}
        <ArrowUpRight aria-hidden data-icon="inline-end" />
      </a>
    </Button>
  );
}

/** A — shadcn's media card. */
export function ScreenCardA({
  item,
  priority = false,
}: {
  item: PublicContentSummary;
  priority?: boolean;
}) {
  const { href, source, name, website } = parts(item);
  return (
    <Card className="group/card gap-0 py-0 transition-shadow duration-300 hover:shadow-lg hover:ring-foreground/15">
      <Link
        href={href}
        aria-label={`${name}, ${item.title}`}
        className="block overflow-hidden border-b"
      >
        <Shot
          media={item.primaryMedia}
          title={item.title}
          priority={priority}
          className="transition-transform duration-700 ease-out group-hover/card:scale-[1.02]"
        />
      </Link>
      <CardHeader className="items-center py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {source ? <SiteLogo source={source} size={26} /> : null}
          <CardTitle className="truncate">
            {source ? (
              <Link
                href={websitePath(source.slug)}
                className="hover:underline hover:underline-offset-4"
              >
                {name}
              </Link>
            ) : (
              name
            )}
          </CardTitle>
        </div>
        {website ? (
          <CardAction className="row-span-1 self-center">
            <Visit href={website} className={REVEAL} />
          </CardAction>
        ) : null}
      </CardHeader>
    </Card>
  );
}

/** B — HeroUI's cover card, with a frosted footer over the image. */
export function ScreenCardB({
  item,
  priority = false,
}: {
  item: PublicContentSummary;
  priority?: boolean;
}) {
  const { href, source, name, website } = parts(item);
  return (
    <Card className="group/card relative gap-0 rounded-2xl py-0">
      <Link
        href={href}
        aria-label={`${name}, ${item.title}`}
        className="block overflow-hidden"
      >
        <Shot
          media={item.primaryMedia}
          title={item.title}
          priority={priority}
          ratio="4 / 3"
          className="transition-transform duration-700 ease-out group-hover/card:scale-[1.03]"
        />
      </Link>
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-2.5 rounded-xl bg-background/80 py-2 pr-2 pl-2.5 ring-1 ring-foreground/10 backdrop-blur-md">
        {source ? <SiteLogo source={source} size={26} /> : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
        {website ? (
          <Visit
            href={website}
            variant="secondary"
            className={cn(REVEAL, "pointer-events-auto")}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** C — no card; the screenshot in a thin ring and the name row beneath. */
export function ScreenCardC({
  item,
  priority = false,
}: {
  item: PublicContentSummary;
  priority?: boolean;
}) {
  const { href, source, name, website } = parts(item);
  return (
    <article className="group/card">
      <Link
        href={href}
        aria-label={`${name}, ${item.title}`}
        className="block overflow-hidden rounded-xl ring-1 ring-foreground/10 transition-shadow duration-300 group-hover/card:shadow-lg"
      >
        <Shot
          media={item.primaryMedia}
          title={item.title}
          priority={priority}
          className="transition-transform duration-700 ease-out group-hover/card:scale-[1.02]"
        />
      </Link>
      <div className="mt-3 flex items-center gap-2.5">
        {source ? <SiteLogo source={source} size={24} /> : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {source ? (
            <Link
              href={websitePath(source.slug)}
              className="hover:underline hover:underline-offset-4"
            >
              {name}
            </Link>
          ) : (
            name
          )}
        </p>
        {website ? (
          <Visit
            href={website}
            variant="ghost"
            label="Visit"
            className={REVEAL}
          />
        ) : null}
      </div>
    </article>
  );
}
