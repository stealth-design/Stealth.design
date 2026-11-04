import { notFound } from "next/navigation";
import { ContactSheet, EmptyState, PageIntro, Room, SectionLabel, toSlide } from "@/components/gallery";
import { Viewer } from "@/components/viewer";
import { api } from "@/lib/api";
import { displayUrl, humanise, plural } from "@/lib/format";

/**
 * One product: a lightbox of everything captured from it, then its flows.
 */
export default async function SourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const source = await api.getSource(slug);
  if (!source) notFound();

  const [screens, flows] = await Promise.all([
    api.listScreens({ source: slug, pageSize: 100 }),
    api.listFlows({ source: slug, pageSize: 24 }),
  ]);
  const website = source.canonicalUrl ?? (source.domain ? `https://${source.domain}` : null);

  return (
    <>
      <PageIntro
        crumbs={[{ label: "Products", href: "/sources" }, { label: source.name }]}
        title={source.name}
        count={plural(screens.total, "screen")}
        description={
          <>
            {source.description ? <p>{source.description}</p> : null}
            <p className="text-faint">
              {humanise(source.type)}
              {website ? (
                <>
                  {" · "}
                  <a href={website} rel="nofollow noreferrer" target="_blank" className="text-dim underline underline-offset-4 hover:text-lit">
                    {displayUrl(website)}
                  </a>
                </>
              ) : null}
              {flows.total > 0 ? ` · ${plural(flows.total, "flow")}` : null}
            </p>
          </>
        }
      />

      {screens.items.length === 0 ? (
        <EmptyState title="Nothing published yet" />
      ) : (
        <Viewer
          slides={screens.items.map((item) => ({ ...toSlide(item), title: item.title, subtitle: item.stateLabel }))}
        />
      )}

      {flows.items.length > 0 ? (
        <Room className="mt-24">
          <SectionLabel title="Flows" count={flows.total} />
          <ContactSheet items={flows.items} showSource={false} />
        </Room>
      ) : null}

      {source.attribution ? (
        <Room className="mt-16">
          <p className="max-w-xl text-[12px] text-faint">{source.attribution}</p>
        </Room>
      ) : null}
    </>
  );
}
