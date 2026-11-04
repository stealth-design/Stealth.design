import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Provenance, Shot } from "@/components/gallery";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One flow, as a filmstrip: its steps side by side, numbered, so consecutive
 * screens can be compared without leaving the page.
 */
export default async function FlowPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const flow = await api.getFlow(slug);
  if (!flow) notFound();

  const isMobile = flow.steps[0]?.content.deviceClass === "mobile";

  return (
    <>
      <PageHeader
        crumbs={[
          { label: "Flows", href: "/flows" },
          ...(flow.source
            ? [
                {
                  label: flow.source.name,
                  href: `/sources/${flow.source.slug}`,
                },
              ]
            : []),
          { label: flow.title },
        ]}
        label={[flow.source?.name, plural(flow.steps.length, "step")]
          .filter(Boolean)
          .join(" · ")}
        title={flow.title}
        note={
          <>
            {flow.goal ?? flow.description}
            {flow.stepCount > flow.steps.length
              ? ` ${plural(flow.stepCount, "step")} in total.`
              : null}
          </>
        }
      />

      <div className="no-scrollbar overflow-x-auto px-4 pb-6 md:px-10">
        <ol className="flex w-max items-start gap-4">
          {flow.steps.map((step, index) => (
            <li
              key={`${step.position}-${step.content.id}`}
              className="flex items-start gap-4"
            >
              <div
                className={cn(
                  "group shrink-0",
                  isMobile ? "w-[280px]" : "w-[520px] max-w-[84vw]",
                )}
              >
                <Link
                  href={`/entry/${step.content.slug}`}
                  className="block overflow-hidden rounded-lg"
                >
                  <Shot
                    media={step.content.primaryMedia}
                    title={step.content.title}
                    size="preview"
                    ratio={isMobile ? "9 / 19.5" : "16 / 10"}
                    priority={index < 3}
                    className="transition-transform duration-700 group-hover:scale-[1.02]"
                  />
                </Link>
                <p className="t-label mt-4 text-muted-foreground">
                  Step {String(index + 1).padStart(2, "0")}
                </p>
                <h2 className="t-card mt-1">
                  <Link
                    href={`/entry/${step.content.slug}`}
                    className="hover:opacity-60"
                  >
                    {step.label ?? step.content.title}
                  </Link>
                </h2>
              </div>
              {index < flow.steps.length - 1 ? (
                <div
                  aria-hidden
                  className={cn(
                    "flex shrink-0 items-center text-muted-foreground",
                    isMobile ? "h-[600px]" : "h-[325px]",
                  )}
                >
                  <ArrowRight className="size-5" />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="page-grid mt-16 border-t pt-6">
        <div className="col-span-full md:col-span-6">
          <Provenance
            sourceUrl={flow.steps[0]?.content.sourceUrl ?? null}
            attribution={flow.steps[0]?.content.attribution ?? null}
          />
        </div>
      </div>
    </>
  );
}
