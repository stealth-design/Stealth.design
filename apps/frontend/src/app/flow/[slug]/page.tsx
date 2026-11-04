import { notFound } from "next/navigation";
import { PageIntro, Provenance, Room } from "@/components/gallery";
import { Viewer } from "@/components/viewer";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";

/**
 * One flow, in the lightbox: its steps in order in the filmstrip, ← → to
 * walk the journey the way someone using the product would.
 */
export default async function FlowPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const flow = await api.getFlow(slug);
  if (!flow) notFound();

  const slides = flow.steps.map((step, index) => ({
    id: `${step.position}-${step.content.id}`,
    href: `/entry/${step.content.slug}`,
    title: `Step ${String(index + 1).padStart(2, "0")}`,
    subtitle: step.label ?? step.content.title,
    media: step.content.primaryMedia,
  }));

  return (
    <>
      <PageIntro
        crumbs={[
          { label: "Flows", href: "/flows" },
          ...(flow.source ? [{ label: flow.source.name, href: `/sources/${flow.source.slug}` }] : []),
        ]}
        title={flow.title}
        count={plural(flow.steps.length, "step")}
        description={
          <>
            {flow.goal ?? flow.description}
            {flow.stepCount > flow.steps.length ? ` ${plural(flow.stepCount, "step")} in total; ${flow.steps.length} published.` : null}
          </>
        }
      />
      {slides.length > 0 ? <Viewer slides={slides} /> : null}
      <Room className="mt-12">
        <Provenance
          sourceUrl={flow.steps[0]?.content.sourceUrl ?? null}
          attribution={flow.steps[0]?.content.attribution ?? null}
        />
      </Room>
    </>
  );
}
