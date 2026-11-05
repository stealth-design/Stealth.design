import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  EmptyState,
  Facts,
  Filters,
  Provenance,
  Shot,
} from "@/components/gallery";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import { displayUrl, formatDate, humanise, kindLabel } from "@/lib/format";
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
 * One website: what is known about it on the column lines, then every fold
 * captured from it, full width, one after another.
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
      {/*
        No big title: the website's name, in the details below, is the
        heading.
      */}
      <nav
        aria-label="Breadcrumb"
        className="t-label flex flex-wrap gap-x-2 px-4 pt-6 pb-8 text-muted-foreground md:px-10 md:pt-10 md:pb-10"
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

      {/* --- What is known about it ----------------------------------------- */}
      <section className="page-grid gap-y-14 border-t pt-10">
        <div className="col-span-full md:col-span-4">
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="group inline-block"
            >
              <h1 className="flex items-start gap-2 text-[clamp(1.75rem,2.8vw,3rem)] leading-[0.9] font-semibold tracking-[-0.04em] break-words uppercase group-hover:opacity-60">
                <span className="min-w-0">{source.name}</span>
                <ArrowUpRight className="mt-0.5 size-5 shrink-0" />
              </h1>
            </a>
          ) : (
            <h1 className="text-[clamp(1.75rem,2.8vw,3rem)] leading-[0.9] font-semibold tracking-[-0.04em] break-words uppercase">
              {source.name}
            </h1>
          )}
          {source.description ? (
            <p className="t-note mt-6 max-w-md text-muted-foreground">
              {source.description}
            </p>
          ) : null}
        </div>

        <div className="col-span-full md:col-span-4 md:col-start-5">
          <Facts
            items={[
              {
                label: "Device",
                value: devices.length
                  ? devices.map((device) => humanise(device)).join(", ")
                  : null,
              },
              { label: "Added", value: added ? formatDate(added) : null },
              {
                label: "Website",
                value: website ? (
                  <a
                    href={website}
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    className="underline underline-offset-4 hover:opacity-60"
                  >
                    {displayUrl(website)}
                  </a>
                ) : null,
              },
            ]}
          />
        </div>

        <div className="col-span-full space-y-8 md:col-span-4 md:col-start-9">
          {[...byKind.entries()].map(([kind, group]) => (
            <div key={kind}>
              <p className="t-label mb-3 text-muted-foreground">
                {kindLabel(kind)}
              </p>
              <Filters
                options={group.map((term) => ({
                  label: term.name,
                  href: `/screens?term=${encodeURIComponent(term.slug)}`,
                  title: term.description ?? undefined,
                }))}
              />
            </div>
          ))}

          <Provenance
            sourceUrl={screens[0]?.sourceUrl ?? website}
            attribution={screens[0]?.attribution ?? source.attribution}
          />
        </div>
      </section>

      {/* --- The folds ------------------------------------------------------ */}
      {screens.length === 0 ? (
        <div className="mt-20">
          <EmptyState title="Coming soon" />
        </div>
      ) : (
        <div className="mt-14 space-y-6 px-4 md:mt-20 md:px-10">
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
