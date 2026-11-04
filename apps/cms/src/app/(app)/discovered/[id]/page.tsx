import Link from "next/link";
import { notFound } from "next/navigation";
import { getDiscoveredPage, screensForDiscoveredPage } from "@uxd/api";
import {
  DISCOVERED_PAGE_STATUS_META,
  IGNORE_REASON_LABELS,
  LIFECYCLE_STATUS_META,
  type DiscoveredPageStatus,
  type IgnoreReason,
  type LifecycleStatus,
} from "@uxd/types";
import {
  Badge,
  Field,
  FieldList,
  MonoValue,
  PageHeader,
  Panel,
  Thumbnail,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";
import { CandidateActions } from "./actions";

export const metadata = { title: "Discovered page" };

/**
 * One candidate (§1).
 *
 * Everything the crawler learned about a URL, in one place, so the decision
 * "is this worth capturing?" can be made without opening the site. The
 * metadata is all attacker-controlled and is rendered as text — never as
 * markup — which is why the title reads as plain prose even when the page
 * supplied HTML in it.
 */
export default async function DiscoveredPageDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContextWith("content.read");
  const { id } = await params;

  const page = await getDiscoveredPage(context.db, id);
  if (!page) notFound();

  const screens = await screensForDiscoveredPage(context.db, id);
  const mediaUrls = await resolveMediaUrls(screens.map((screen) => screen.thumbnailKey));
  const meta = DISCOVERED_PAGE_STATUS_META[page.status as DiscoveredPageStatus];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Discovered pages", href: "/discovered" }]}
        title={page.title ?? page.path ?? page.url}
        count={page.host}
        description={page.description ?? undefined}
        actions={
          <>
            <Badge tone={meta.tone} title={meta.description} dot>
              {meta.label}
            </Badge>
            <CandidateActions
              id={page.id}
              url={page.url}
              status={page.status as DiscoveredPageStatus}
              sourceId={page.sourceId}
              screenCount={page.screenCount}
            />
          </>
        }
      />

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <Panel title="What the crawl found">
          <FieldList>
            <Field label="URL">
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all font-mono text-2xs underline hover:text-ink-900"
              >
                {page.url}
              </a>
            </Field>
            {page.finalUrl && page.finalUrl !== page.url ? (
              <Field label="Redirected to" hint="Where the request actually landed.">
                <MonoValue value={page.finalUrl} />
              </Field>
            ) : null}
            <Field label="HTTP status">
              <MonoValue value={page.httpStatus ? String(page.httpStatus) : "—"} />
            </Field>
            <Field label="Title">{page.title ?? "—"}</Field>
            <Field label="H1">{page.h1 ?? "—"}</Field>
            <Field label="Words" hint="A very low count usually means the page renders client side.">
              {page.wordCount === null ? "—" : page.wordCount.toLocaleString("en-US")}
            </Field>
            <Field label="Language">{page.langAttr ?? "—"}</Field>
            <Field label="Source">
              {page.sourceId ? (
                <Link href={`/sources/${page.sourceId}`} className="hover:underline">
                  {page.sourceName}
                </Link>
              ) : (
                "—"
              )}
            </Field>
          </FieldList>
        </Panel>

        <Panel title="How we found it">
          <FieldList>
            <Field label="Depth" hint="0 means it was submitted rather than discovered.">
              {String(page.depth)}
            </Field>
            <Field label="Linked from">
              {page.discoveredFromUrl ? <MonoValue value={page.discoveredFromUrl} /> : "—"}
            </Field>
            <Field label="First seen">
              <Timestamp value={page.firstSeenAt} />
            </Field>
            <Field label="Last seen">
              <Timestamp value={page.lastSeenAt} />
            </Field>
            <Field
              label="Times seen"
              hint="A URL several crawls have returned is a stable part of the site."
            >
              {String(page.seenCount)}
            </Field>
            {page.jobId ? (
              <Field label="Crawl job">
                <Link href={`/crawl-jobs/${page.jobId}`} className="hover:underline">
                  Open the job
                </Link>
              </Field>
            ) : null}
            {page.ignoreReason ? (
              <Field label="Set aside because">
                {IGNORE_REASON_LABELS[page.ignoreReason as IgnoreReason] ?? page.ignoreReason}
                {page.ignoreNote ? ` — ${page.ignoreNote}` : ""}
                {page.triagedByName ? ` (${page.triagedByName})` : ""}
              </Field>
            ) : null}
          </FieldList>
        </Panel>

        <Panel
          title="Screens captured from this page"
          description="A page can yield several: the default view, the navigation open, a modal up."
          className="lg:col-span-2"
        >
          {screens.length === 0 ? (
            <p className="px-3 py-4 text-2xs text-ink-500">
              None yet. Capturing opens a live browser so you can reach the state worth keeping.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-3 p-3">
              {screens.map((screen) => {
                const status = LIFECYCLE_STATUS_META[screen.status as LifecycleStatus];
                return (
                  <li key={screen.id} className="w-48">
                    <Link href={`/screens/${screen.id}`} className="group block">
                      <Thumbnail
                        url={
                          screen.thumbnailKey ? (mediaUrls.get(screen.thumbnailKey) ?? null) : null
                        }
                        alt={screen.title ?? "Screen"}
                        width={192}
                        height={120}
                        className="w-full group-hover:border-ink-400"
                      />
                      <p className="mt-1 truncate text-2xs font-medium text-ink-900">
                        {screen.title ?? "Untitled"}
                      </p>
                    </Link>
                    <p className="mt-0.5 flex items-center gap-1.5">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-2xs text-ink-500">{screen.deviceProfile}</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
