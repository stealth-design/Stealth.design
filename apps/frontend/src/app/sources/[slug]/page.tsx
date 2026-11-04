import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CardGrid,
  EmptyState,
  PageHeader,
  Pager,
  ScreenCard,
  SectionHeader,
  Shot,
} from "@/components/gallery";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import { displayUrl, humanise, plural } from "@/lib/format";

const PAGE_SIZE = 30;

/**
 * One product, laid out like a case study: the name, the facts on the
 * column lines, its most recent capture at full width, then everything else.
 */
export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const page = Math.max(1, Number(query.page ?? 1) || 1);

  const source = await api.getSource(slug);
  if (!source) notFound();

  const [screens, flows] = await Promise.all([
    api.listScreens({ source: slug, page, pageSize: PAGE_SIZE }),
    api.listFlows({ source: slug, pageSize: 12 }),
  ]);
  const totalPages = Math.max(1, Math.ceil(screens.total / PAGE_SIZE));
  const website =
    source.canonicalUrl ?? (source.domain ? `https://${source.domain}` : null);
  const [lead, ...rest] = page === 1 ? screens.items : [null, ...screens.items];

  const facts = [
    { label: "Type", value: humanise(source.type) },
    { label: "Screens", value: screens.total.toLocaleString("en-US") },
    { label: "Flows", value: flows.total.toLocaleString("en-US") },
    {
      label: "Company",
      value:
        source.companyName && source.companyName !== source.name
          ? source.companyName
          : null,
    },
  ].filter((fact) => fact.value);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: "Companies", href: "/sources" },
          { label: source.name },
        ]}
        title={source.name}
        note={source.description ?? null}
        actions={
          website ? (
            <a
              href={website}
              rel="nofollow noreferrer"
              target="_blank"
              className="t-nav inline-flex h-11 items-center gap-2 rounded-[4px] bg-ink px-4 text-ink-foreground hover:opacity-80"
            >
              Visit {displayUrl(website)} <ArrowUpRight className="size-4" />
            </a>
          ) : null
        }
      />

      {/* The facts, one per column line. */}
      <section className="page-grid gap-y-8 border-t pt-6 pb-16 md:pb-20">
        {facts.map((fact) => (
          <div key={fact.label} className="col-span-2 md:col-span-3">
            <p className="t-label text-muted-foreground">{fact.label}</p>
            <p className="t-card mt-2">{fact.value}</p>
          </div>
        ))}
      </section>

      {screens.items.length === 0 ? (
        <EmptyState title="Coming soon" />
      ) : (
        <>
          {lead ? (
            <Reveal className="mb-20 px-4 md:mb-28 md:px-10">
              <Link
                href={`/entry/${lead.slug}`}
                className="group block overflow-hidden rounded-lg"
              >
                <Shot
                  media={lead.primaryMedia}
                  title={lead.title}
                  size="preview"
                  full
                  priority
                  className="transition-transform duration-700 ease-out group-hover:scale-[1.01]"
                />
              </Link>
              <div className="mt-4 flex items-baseline justify-between gap-6">
                <p className="t-card">{lead.title}</p>
                <p className="t-label text-muted-foreground">
                  {lead.stateLabel ?? "Latest"}
                </p>
              </div>
            </Reveal>
          ) : null}

          {rest.length > 0 ? (
            <section>
              <SectionHeader
                title="All screens"
                note={plural(screens.total, "screen")}
              />
              <CardGrid columns={3}>
                {rest
                  .filter((item) => item !== null)
                  .map((item) => (
                    <ScreenCard key={item.id} item={item} showSource={false} />
                  ))}
              </CardGrid>
            </section>
          ) : null}
        </>
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        href={(target) =>
          target === 1 ? `/sources/${slug}` : `/sources/${slug}?page=${target}`
        }
      />

      {flows.items.length > 0 ? (
        <section className="mt-32">
          <SectionHeader title="Flows" note={plural(flows.total, "flow")} />
          <CardGrid columns={3}>
            {flows.items.map((flow) => (
              <ScreenCard key={flow.id} item={flow} showSource={false} />
            ))}
          </CardGrid>
        </section>
      ) : null}

      {source.attribution ? (
        <div className="page-grid mt-20">
          <p className="t-label col-span-full text-muted-foreground md:col-span-6">
            {source.attribution}
          </p>
        </div>
      ) : null}
    </>
  );
}
