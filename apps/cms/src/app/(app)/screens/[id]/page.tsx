import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { mediaAssets, mediaDerivatives } from "@uxd/database";
import { getContentDetail, getScreenDetail, listTaxonomyTerms } from "@uxd/api";
import {
  DEVICE_PROFILES,
  LIFECYCLE_STATUS_META,
  SCREEN_ACQUISITION_LABELS,
  type DeviceProfileKey,
  type LifecycleStatus,
  type ScreenAcquisition,
  type TaxonomyKind,
} from "@uxd/types";
import { Badge, Field, FieldList, MonoValue, PageHeader, Timestamp } from "@/components/ui/primitives";
import { getAdminContextWith, mediaUrl } from "@/lib/server";
import { ScreenReview, type SuggestionRow, type TermOption } from "./review";

export const metadata = { title: "Screen" };

/**
 * Screen review (§7).
 *
 * The two-column arrangement the brief asks for, and the reason for it: the
 * left column is the evidence and the right is the judgement. A reviewer looks
 * at the capture and decides whether each proposed tag is true of what they can
 * see — so the image has to be large enough to actually read, which is why it
 * gets the wider column and why the preview rendition is used rather than the
 * thumbnail.
 */
export default async function ScreenPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContextWith("content.read");
  const { id } = await params;

  const screen = await getScreenDetail(context.db, id);
  if (!screen) notFound();

  const [detail, terms] = await Promise.all([
    getContentDetail(context.db, id),
    listTaxonomyTerms(context.db, { statuses: ["active"] }),
  ]);

  // The research image: the widest rendition available, falling back to the
  // master. A reviewer judging "is this a pricing comparison?" needs to read
  // the page, and a 480px card crop cannot answer that.
  const [largeKey] = screen.primaryMediaId
    ? await context.db
        .select({ key: mediaDerivatives.storageKey })
        .from(mediaDerivatives)
        .where(
          and(
            eq(mediaDerivatives.mediaId, screen.primaryMediaId),
            eq(mediaDerivatives.kind, "large"),
          ),
        )
        .limit(1)
    : [];

  const [master] = screen.primaryMediaId
    ? await context.db
        .select({ key: mediaAssets.storageKey, width: mediaAssets.width, height: mediaAssets.height })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, screen.primaryMediaId))
        .limit(1)
    : [];

  const imageUrl = (await mediaUrl(largeKey?.key)) ?? (await mediaUrl(master?.key));
  const originalUrl = await mediaUrl(master?.key);

  const meta = LIFECYCLE_STATUS_META[screen.status as LifecycleStatus];
  const profile = screen.deviceProfile
    ? DEVICE_PROFILES[screen.deviceProfile as DeviceProfileKey]
    : undefined;

  const suggestions: SuggestionRow[] = (detail?.taxonomy ?? []).map((row) => ({
    assignmentId: row.assignment.id,
    termId: row.term.id,
    termName: row.term.name,
    termKind: row.term.kind as TaxonomyKind,
    termPath: row.term.path,
    confidence: row.assignment.confidence,
    origin: row.assignment.origin,
    reviewStatus: row.assignment.reviewStatus,
    model: row.assignment.model,
    suggestedAt: row.assignment.suggestedAt?.toISOString() ?? null,
    reviewerName: row.reviewerName,
    replacedTermName: null,
  }));

  const termOptions: TermOption[] = terms.map((term) => ({
    id: term.id,
    name: term.name,
    kind: term.kind as TaxonomyKind,
    path: term.path,
  }));

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Screens", href: "/screens" }]}
        title={screen.title ?? "Untitled screen"}
        count={profile?.label}
        description={screen.description ?? undefined}
        actions={
          <>
            <Badge tone={meta.tone} title={meta.description} dot>
              {meta.label}
            </Badge>
            {screen.discoveredPageId ? (
              <Link
                href={`/discovered/${screen.discoveredPageId}`}
                className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
              >
                Candidate
              </Link>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* --- Evidence --------------------------------------------------- */}
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-md border border-ink-200 bg-ink-100">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={screen.title ?? "Captured screen"}
                className="block w-full"
              />
            ) : (
              <div className="flex h-96 items-center justify-center text-xs text-ink-500">
                This screen has no image.
              </div>
            )}
          </div>

          <FieldList>
            <Field label="URL">
              {screen.url ? (
                <a
                  href={screen.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all font-mono text-2xs text-ink-700 underline hover:text-ink-900"
                >
                  {screen.url}
                </a>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Source">
              {screen.sourceId ? (
                <Link href={`/sources/${screen.sourceId}`} className="hover:underline">
                  {screen.sourceName}
                </Link>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Captured">
              <Timestamp value={screen.capturedAt} />
            </Field>
            <Field label="How">
              {SCREEN_ACQUISITION_LABELS[screen.acquisition as ScreenAcquisition] ??
                screen.acquisition}
            </Field>
            <Field label="Viewport">
              <MonoValue
                value={`${screen.viewportWidth}×${screen.viewportHeight} CSS${
                  screen.deviceScaleFactor ? ` at ×${screen.deviceScaleFactor}` : ""
                }`}
              />
            </Field>
            <Field label="Image">
              <MonoValue
                value={master?.width && master?.height ? `${master.width}×${master.height}` : "—"}
              />
            </Field>
            {originalUrl ? (
              <Field label="Master">
                <a
                  href={originalUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-2xs underline hover:text-ink-900"
                >
                  Open the lossless original
                </a>
              </Field>
            ) : null}
            {screen.flows.length > 0 ? (
              <Field label="In flows">
                {screen.flows.map((flow) => (
                  <Link
                    key={flow.flowId}
                    href={`/flows/${flow.flowId}`}
                    className="mr-2 hover:underline"
                  >
                    {flow.flowTitle} (step {flow.position})
                  </Link>
                ))}
              </Field>
            ) : null}
          </FieldList>
        </div>

        {/* --- Judgement -------------------------------------------------- */}
        <ScreenReview
          contentItemId={screen.id}
          status={screen.status as LifecycleStatus}
          screenName={screen.screenName ?? screen.title ?? "Untitled screen"}
          stateLabel={screen.stateLabel}
          description={screen.description}
          notes={screen.notes}
          suggestions={suggestions}
          terms={termOptions}
        />
      </div>
    </>
  );
}
