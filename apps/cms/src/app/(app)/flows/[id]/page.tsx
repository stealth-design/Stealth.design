import Link from "next/link";
import { notFound } from "next/navigation";
import { getContentDetail, getFlowSteps } from "@uxd/api";
import {
  CONTENT_KIND_META,
  LIFECYCLE_STATUS_META,
  type ContentKind,
  type LifecycleStatus,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  Field,
  FieldList,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  Thumbnail,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { FlowBuilder } from "./builder";

export const metadata = { title: "Flow" };

/**
 * The flow viewer (§2, §10).
 *
 * A horizontal filmstrip in step order, because the thing a researcher is
 * trying to see is the *sequence* — how many screens, what changes between
 * them, where the friction is — and a vertical list of thumbnails does not
 * show a sequence, it shows a list.
 *
 * Deliberately plain: no transitions, no lightbox, no animation. §"do not build
 * elaborate animations" applies to the public site, and there is no reason for
 * the CMS to be different — a reviewer comparing step 3 to step 4 wants both on
 * screen at once, which is what horizontal scroll gives and a carousel takes
 * away.
 *
 * Each step shows its own lifecycle status, because that is what determines
 * whether the public flow is complete.
 */
export default async function FlowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContextWith("content.read");
  const { id } = await params;

  const [detail, steps] = await Promise.all([
    getContentDetail(context.db, id),
    getFlowSteps(context.db, id),
  ]);
  if (!detail) notFound();

  const { content, flow } = detail;
  if (content.kind !== "flow") {
    // Not a flow. Send the operator to the right screen rather than rendering
    // an empty filmstrip that looks like a broken flow.
    notFound();
  }

  const statusMeta = LIFECYCLE_STATUS_META[content.status as LifecycleStatus];
  const urls = await resolveMediaUrls([
    ...steps.map((step) => step.thumbnailKey),
    ...steps.map((step) => step.fullKey),
  ]);

  const publishedSteps = steps.filter((step) => step.status === "published").length;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Flows", href: "/flows" }]}
        title={content.title ?? "Untitled flow"}
        description={flow?.goal ?? CONTENT_KIND_META.flow.description}
        count={`${steps.length} step${steps.length === 1 ? "" : "s"}`}
        actions={<LinkButton href={`/content/${id}`}>Open as a content record</LinkButton>}
      />

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusMeta.tone} title={statusMeta.description}>
            {statusMeta.label}
          </Badge>
          {steps.length > 0 && publishedSteps < steps.length ? (
            <span className="text-2xs text-[var(--color-tone-warning)]">
              {steps.length - publishedSteps} of {steps.length} steps are not published, so a
              visitor would see an incomplete journey.
            </span>
          ) : null}
          {steps.length > 0 && publishedSteps === steps.length ? (
            <span className="text-2xs text-[var(--color-tone-success)]">
              Every step is published.
            </span>
          ) : null}
        </div>

        <FlowBuilder
          flowId={id}
          status={content.status}
          sourceId={content.sourceId}
          steps={steps.map((step) => ({
            stepId: step.stepId,
            position: step.position,
            label: step.label,
            title: step.title,
          }))}
        />

        {/* --- The filmstrip ------------------------------------------ */}
        <Panel
          title="Steps, in order"
          description="Scrolls horizontally so consecutive steps stay side by side."
        >
          {steps.length === 0 ? (
            <EmptyState
              title="This flow has no steps"
              description="Walk the flow above to capture its steps, or add screens you have already captured."
              action={<LinkButton href="/screens">Browse screens</LinkButton>}
            />
          ) : (
            <div className="overflow-x-auto">
              <ol className="flex min-w-max items-stretch gap-3 p-3">
                {steps.map((step, index) => {
                  const stepStatus = LIFECYCLE_STATUS_META[step.status as LifecycleStatus];
                  return (
                    <li key={step.stepId} className="flex items-stretch gap-3">
                      <div className="flex w-56 flex-col">
                        <Link
                          href={`/content/${step.contentId}`}
                          className="group block"
                          title={step.sourceUrl ?? undefined}
                        >
                          <Thumbnail
                            url={
                              (step.thumbnailKey ? urls.get(step.thumbnailKey) : undefined) ??
                              (step.fullKey ? urls.get(step.fullKey) : undefined) ??
                              null
                            }
                            alt={step.label ?? step.title ?? `Step ${step.position}`}
                            width={224}
                            height={150}
                            className="w-full group-hover:border-ink-400"
                          />
                        </Link>
                        <div className="mt-1.5 min-w-0">
                          <p className="flex items-baseline gap-1.5">
                            <span className="mono text-2xs text-ink-400">{index + 1}</span>
                            <Link
                              href={`/content/${step.contentId}`}
                              className="truncate text-xs font-medium text-ink-900 hover:underline"
                            >
                              {step.label ?? step.title ?? "Untitled"}
                            </Link>
                          </p>
                          <p className="mt-0.5 flex items-center gap-1.5">
                            <Badge tone={stepStatus.tone}>{stepStatus.label}</Badge>
                            <span className="truncate text-2xs text-ink-500">
                              {CONTENT_KIND_META[step.kind as ContentKind]?.label ?? step.kind}
                            </span>
                          </p>
                          {step.note ? (
                            <p className="mt-0.5 text-2xs leading-relaxed text-ink-600">
                              {step.note}
                            </p>
                          ) : null}
                          <InlineMeta items={[step.sourceUrl]} />
                        </div>
                      </div>

                      {index < steps.length - 1 ? (
                        <div
                          aria-hidden
                          className="flex w-4 items-center justify-center pt-16 text-ink-300"
                        >
                          →
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Flow">
            <FieldList>
              <Field label="Goal">{flow?.goal}</Field>
              <Field
                label="Recorded step count"
                hint="Maintained on the flow record. The filmstrip above counts the actual step rows."
              >
                {flow?.stepCount !== undefined && flow.stepCount !== steps.length ? (
                  <span className="text-[var(--color-tone-warning)]">
                    {flow.stepCount} recorded, {steps.length} actual
                  </span>
                ) : (
                  String(flow?.stepCount ?? steps.length)
                )}
              </Field>
              <Field label="Observations">
                {flow?.observations ? (
                  <span className="whitespace-pre-wrap">{flow.observations}</span>
                ) : null}
              </Field>
              <Field label="Captured">
                <Timestamp value={content.capturedAt} />
              </Field>
              <Field label="Published">
                <Timestamp value={content.publishedAt} />
              </Field>
              <Field label="Flow ID" mono>
                {content.id}
              </Field>
            </FieldList>
          </Panel>

          <Panel title="How flows relate to their steps">
            <div className="space-y-2 p-3 text-2xs leading-relaxed text-ink-600">
              <p>
                A step is a reference to a content record, not a copy of it. The same page can
                appear in several flows, and editing it once updates every flow that uses it.
              </p>
              <p>
                Publishing a flow does not publish its steps, and publishing a step does not publish
                the flow. Each record passes the publish gate on its own, which is what makes it
                possible to hold back one screen of a journey — a payment page still awaiting a
                rights decision, say — without withdrawing the whole flow.
              </p>
              <p>
                Step order lives in <MonoValue value="flow_steps.position" />, so reordering a flow
                does not touch the records it points at.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
