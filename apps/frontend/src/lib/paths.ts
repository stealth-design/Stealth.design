/**
 * Every public address, built in one place.
 *
 *   /websites           all websites
 *   /websites/gladia    one website, with every fold captured from it
 *
 * Screens have no address of their own: they are parts of their website's
 * page. Old screen addresses (/entry/<slug>, /websites/<name>/<screen>)
 * redirect to the website.
 */

export function websitesPath(): string {
  return "/websites";
}

export function websitePath(sourceSlug: string): string {
  return `/websites/${sourceSlug}`;
}

/**
 * Where a screen is shown: its website's page. Without a website (rare: a
 * screen not tied to one) it falls back to `/entry/<slug>`, which has no page.
 */
export function screenPath(slug: string, sourceSlug?: string | null): string {
  return sourceSlug ? websitePath(sourceSlug) : `/entry/${slug}`;
}

/** A card's link: its website's page. */
export function itemPath(item: {
  readonly slug: string;
  readonly source?: { readonly slug: string } | null;
}): string {
  return screenPath(item.slug, item.source?.slug);
}
