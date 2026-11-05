import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CardGrid,
  Facts,
  Filters,
  PageHeader,
  Provenance,
  ScreenCard,
  SectionHeader,
  Shot,
} from "@/components/gallery";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import {
  displayUrl,
  formatDate,
  humanise,
  kindLabel,
  plural,
} from "@/lib/format";

/**
 * One entry, as a case study: the capture at full width and full proportions,
 * then what is known about it on the column lines underneath.
 */
export default async function EntryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = await api.getContent(slug);
  if (!entry) notFound();

  const byKind = new Map<string, typeof entry.taxonomy>();
  for (const term of entry.taxonomy) {
    byKind.set(term.kind, [...(byKind.get(term.kind) ?? []), term]);
  }
  const isMobile = entry.deviceClass === "mobile";

  return (
    <>
      <PageHeader
        crumbs={[
          { label: "Websites", href: "/screens" },
          ...(entry.source
            ? [
                {
                  label: entry.source.name,
                  href: `/sources/${entry.source.slug}`,
                },
              ]
            : []),
          { label: entry.title },
        ]}
        label={[
          entry.source?.name,
          entry.stateLabel,
          entry.deviceClass ? humanise(entry.deviceClass) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        title={entry.title}
        note={entry.description ?? null}
      />

      {/* --- The capture ---------------------------------------------------- */}
      <div className="space-y-6 px-4 md:px-10">
        {entry.media.length === 0 ? (
          <Shot media={null} title={entry.title} className="rounded-lg" />
        ) : (
          entry.media.map((media, index) => (
            <Reveal key={media.id}>
              <figure
                className={isMobile ? "mx-auto max-w-[440px]" : undefined}
              >
                <Shot
                  media={media}
                  title={entry.title}
                  size="preview"
                  full
                  priority={index === 0}
                  className="rounded-lg"
                />
                {media.caption ? (
                  <figcaption className="t-label mt-3 text-muted-foreground">
                    {media.caption}
                  </figcaption>
                ) : null}
              </figure>
            </Reveal>
          ))
        )}
      </div>

      {/* --- What is known about it ----------------------------------------- */}
      <section className="page-grid mt-20 gap-y-14 border-t pt-10 md:mt-28">
        <div className="col-span-full md:col-span-4">
          {entry.source ? (
            <Link
              href={`/sources/${entry.source.slug}`}
              className="group inline-block"
            >
              <p className="t-label text-muted-foreground">Company</p>
              <p className="mt-3 flex items-start gap-2 text-[clamp(1.75rem,2.8vw,3rem)] leading-[0.9] font-semibold tracking-[-0.04em] break-words uppercase group-hover:opacity-60">
                <span className="min-w-0">{entry.source.name}</span>
                <ArrowUpRight className="mt-0.5 size-5 shrink-0" />
              </p>
            </Link>
          ) : null}
        </div>

        <div className="col-span-full md:col-span-4 md:col-start-5">
          <Facts
            items={[
              {
                label: "Device",
                value: entry.deviceClass ? humanise(entry.deviceClass) : null,
              },
              { label: "Added", value: formatDate(entry.publishedAt) },
              {
                label: "Website",
                value: entry.sourceUrl ? (
                  <a
                    href={entry.sourceUrl}
                    rel="nofollow noreferrer"
                    className="underline underline-offset-4 hover:opacity-60"
                  >
                    {displayUrl(entry.sourceUrl)}
                  </a>
                ) : null,
              },
              {
                label: "Part of",
                value:
                  entry.experience && entry.experience.slug !== entry.slug ? (
                    <Link
                      href={`/entry/${entry.experience.slug}`}
                      className="underline underline-offset-4"
                    >
                      {entry.experience.title}
                    </Link>
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

          {entry.flows.length > 0 ? (
            <div>
              <p className="t-label mb-3 text-muted-foreground">Appears in</p>
              <ul className="divide-y border-y">
                {entry.flows.map((flow) => (
                  <li key={flow.id}>
                    <Link
                      href={`/flow/${flow.slug}`}
                      className="flex items-baseline justify-between gap-4 py-3 hover:opacity-60"
                    >
                      <span className="text-[17px]">{flow.title}</span>
                      <span className="t-label text-muted-foreground">
                        {plural(flow.stepCount, "step")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Provenance
            sourceUrl={entry.sourceUrl}
            attribution={entry.attribution}
          />
        </div>
      </section>

      {entry.states.length > 0 ? (
        <section className="mt-32">
          <SectionHeader
            title="More of this page"
            note={plural(entry.states.length, "more view")}
          />
          <CardGrid columns={4}>
            {entry.states.map((state) => (
              <ScreenCard key={state.id} item={state} showSource={false} />
            ))}
          </CardGrid>
        </section>
      ) : null}

      {entry.interactions.length > 0 ? (
        <section className="mt-32">
          <SectionHeader title="Interactions" />
          <CardGrid columns={4}>
            {entry.interactions.map((interaction) => (
              <ScreenCard
                key={interaction.id}
                item={interaction}
                showSource={false}
              />
            ))}
          </CardGrid>
        </section>
      ) : null}

      {entry.relatedContent.length > 0 ? (
        <section className="mt-32">
          <SectionHeader
            title={entry.source ? `More from ${entry.source.name}` : "Related"}
            href={entry.source ? `/sources/${entry.source.slug}` : undefined}
            hrefLabel="View product"
          />
          <CardGrid columns={3}>
            {entry.relatedContent.map((related) => (
              <ScreenCard
                key={related.id}
                item={related}
                showSource={!entry.source}
              />
            ))}
          </CardGrid>
        </section>
      ) : null}
    </>
  );
}
