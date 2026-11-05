import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, Filters, Shot } from "@/components/gallery";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import { formatDate, humanise, kindLabel } from "@/lib/format";
import { websitesPath } from "@/lib/paths";

/** More than any website has for launch; the page is one long scroll. */
const MAX_SCREENS = 40;

type Screen = NonNullable<Awaited<ReturnType<typeof api.getContent>>>;
type Term = Screen["taxonomy"][number];

/** The tab title is the website's name. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ source: string }>;
}) {
  const { source: slug } = await params;
  const source = await api.getSource(slug);
  return { title: source?.name ?? "Website" };
}

/**
 * One website: its name, a button to the real site and what it is, centred
 * at the top; then every fold captured from it, full width, one after
 * another.
 *
 * This is the only page for a website. Its address is /websites/<name>; the
 * screens have no address of their own, because they are parts of this page
 * (the old /websites/<name>/<screen> addresses redirect here).
 */
export default async function WebsitePage({
  params,
}: {
  params: Promise<{ source: string }>;
}) {
  const { source: slug } = await params;
  const source = await api.getSource(slug);
  if (!source) notFound();

  const list = await api.listScreens({
    source: slug,
    pageSize: MAX_SCREENS,
  });
  // Oldest first: folds are captured top to bottom.
  const screens = (
    await Promise.all(
      [...list.items].reverse().map((item) => api.getContent(item.slug)),
    )
  ).filter((screen): screen is Screen => screen !== null);

  const website =
    source.canonicalUrl ?? (source.domain ? `https://${source.domain}` : null);
  const devices = [
    ...new Set(
      screens.map((screen) => screen.deviceClass).filter(Boolean) as string[],
    ),
  ];
  const added = screens
    .map((screen) => screen.publishedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  // Every tag across the folds, once each, grouped by kind.
  const byKind = new Map<string, Term[]>();
  for (const term of screens.flatMap((screen) => screen.taxonomy)) {
    const group = byKind.get(term.kind) ?? [];
    if (!group.some((existing) => existing.id === term.id)) group.push(term);
    byKind.set(term.kind, group);
  }

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="t-label flex flex-wrap gap-x-2 px-4 pt-6 text-muted-foreground md:px-10 md:pt-8"
      >
        <Link
          href={websitesPath()}
          className="transition-colors hover:text-foreground"
        >
          Websites
        </Link>
        <span aria-hidden>/</span>
        <span className="text-foreground">{source.name}</span>
      </nav>

      {/* --- The name, the way in, then what it is --------------------------- */}
      {/*
        Centred, the name first and large but not shouting, then one button
        to the real site (the name itself is not a link: the button is the
        way out). The facts sit in a row beneath. Short enough that the first
        fold reaches the top of the screenshots.
      */}
      <section className="px-4 pt-10 pb-12 text-center md:px-10 md:pt-10 md:pb-14">
        <Reveal>
          <h1 className="mx-auto max-w-[16ch] text-[clamp(2.25rem,4.6vw,4.75rem)] leading-[0.95] font-semibold tracking-[-0.045em] break-words uppercase text-balance">
            {source.name}
          </h1>
          {source.description ? (
            <p className="t-note mx-auto mt-5 max-w-xl text-muted-foreground">
              {source.description}
            </p>
          ) : null}
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="mt-7 inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-[15px] font-medium tracking-[-0.01em] text-background transition-opacity hover:opacity-80 md:mt-8"
            >
              View website
              <ArrowUpRight aria-hidden className="size-4" />
            </a>
          ) : null}
        </Reveal>

        <dl className="mx-auto mt-10 flex max-w-4xl flex-wrap items-start justify-center gap-x-14 gap-y-6 md:mt-12">
          {[...byKind.entries()].map(([kind, group]) => (
            <div key={kind} className="flex flex-col items-center">
              <dt className="t-label mb-3 text-muted-foreground">
                {kindLabel(kind)}
              </dt>
              <dd>
                <Filters
                  options={group.map((term) => ({
                    label: term.name,
                    href: `/?term=${encodeURIComponent(term.slug)}#websites`,
                    title: term.description ?? undefined,
                  }))}
                />
              </dd>
            </div>
          ))}
          {added ? (
            <div className="flex flex-col items-center">
              <dt className="t-label mb-3 text-muted-foreground">Added</dt>
              <dd className="flex h-9 items-center text-[17px]">
                {formatDate(added)}
              </dd>
            </div>
          ) : null}
          {devices.length ? (
            <div className="flex flex-col items-center">
              <dt className="t-label mb-3 text-muted-foreground">Device</dt>
              <dd className="flex h-9 items-center text-[17px]">
                {devices.map((device) => humanise(device)).join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
        {source.attribution ? (
          <p className="t-label mx-auto mt-8 max-w-xl text-muted-foreground">
            {source.attribution}
          </p>
        ) : null}
      </section>

      {/* --- The folds ------------------------------------------------------ */}
      {screens.length === 0 ? (
        <div className="mt-20">
          <EmptyState title="Coming soon" />
        </div>
      ) : (
        <div className="space-y-6 px-4 md:px-10">
          {screens.flatMap((screen, screenIndex) =>
            (screen.media.length ? screen.media : [null]).map(
              (media, index) => (
                <Reveal key={media?.id ?? screen.id}>
                  <figure
                    className={
                      screen.deviceClass === "mobile"
                        ? "mx-auto max-w-[440px]"
                        : undefined
                    }
                  >
                    <Shot
                      media={media}
                      title={`${source.name}, ${screen.title}`}
                      size="preview"
                      full
                      priority={screenIndex === 0 && index === 0}
                      className="rounded-lg"
                    />
                    {media?.caption ? (
                      <figcaption className="t-label mt-3 text-muted-foreground">
                        {media.caption}
                      </figcaption>
                    ) : null}
                  </figure>
                </Reveal>
              ),
            ),
          )}
        </div>
      )}
    </>
  );
}
