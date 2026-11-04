import Link from "next/link";
import { notFound } from "next/navigation";
import { ContactSheet, Facts, Provenance, Room, SectionLabel, toSlide } from "@/components/gallery";
import { Viewer } from "@/components/viewer";
import { api } from "@/lib/api";
import { displayUrl, formatDate, humanise, plural } from "@/lib/format";

/**
 * One screen, in the viewer. The filmstrip is everything else from the same
 * product, so ← → walks through the product one URL at a time; `i` opens
 * what is known about the screen on the stage.
 */
export default async function EntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = await api.getContent(slug);
  if (!entry) notFound();

  const siblings = entry.source ? (await api.listScreens({ source: entry.source.slug, pageSize: 100 })).items : [];
  const items = siblings.some((item) => item.id === entry.id) ? siblings : [entry, ...siblings];
  const index = items.findIndex((item) => item.id === entry.id);

  const byKind = new Map<string, typeof entry.taxonomy>();
  for (const term of entry.taxonomy) {
    byKind.set(term.kind, [...(byKind.get(term.kind) ?? []), term]);
  }

  const info = (
    <div className="space-y-8">
      <div>
        <p className="text-[17px] text-lit">{entry.source?.name ?? entry.title}</p>
        <p className="mt-1 text-[13px] text-dim">{[entry.title, entry.stateLabel].filter(Boolean).join(", ")}</p>
        {entry.description ? <p className="mt-3 text-[13px] leading-relaxed text-dim">{entry.description}</p> : null}
      </div>

      <Facts
        items={[
          {
            label: "Product",
            value: entry.source ? (
              <Link href={`/sources/${entry.source.slug}`} className="underline underline-offset-4 hover:opacity-70">
                {entry.source.name}
              </Link>
            ) : null,
          },
          { label: "Platform", value: entry.platform ? humanise(entry.platform) : null },
          { label: "Device", value: entry.deviceClass ? humanise(entry.deviceClass) : null },
          {
            label: "Page",
            value: entry.sourceUrl ? (
              <a href={entry.sourceUrl} rel="nofollow noreferrer" className="underline underline-offset-4 hover:opacity-70">
                {displayUrl(entry.sourceUrl)}
              </a>
            ) : null,
          },
          {
            label: "Viewport",
            value:
              entry.screen?.viewportWidth && entry.screen.viewportHeight
                ? <span className="num">{`${entry.screen.viewportWidth}×${entry.screen.viewportHeight} @${entry.screen.deviceScaleFactor ?? 1}x`}</span>
                : null,
          },
          { label: "Published", value: formatDate(entry.publishedAt) },
        ]}
      />

      {[...byKind.entries()].map(([kind, group]) => (
        <div key={kind}>
          <p className="mb-2 text-[12px] text-faint">{humanise(kind)}</p>
          <div className="flex flex-wrap gap-1">
            {group.map((term) => (
              <Link
                key={term.id}
                href={`/screens?term=${encodeURIComponent(term.slug)}`}
                title={term.description ?? undefined}
                className="rounded-md bg-accent px-2 py-1 text-[12px] text-dim hover:text-lit"
              >
                {term.name}
              </Link>
            ))}
          </div>
        </div>
      ))}

      {entry.flows.length > 0 ? (
        <div>
          <p className="mb-2 text-[12px] text-faint">Appears in</p>
          <ul className="space-y-1.5 text-[13px]">
            {entry.flows.map((flow) => (
              <li key={flow.id}>
                <Link href={`/flow/${flow.slug}`} className="text-lit hover:opacity-70">
                  {flow.title}
                </Link>{" "}
                <span className="num text-[11px] text-faint">{plural(flow.stepCount, "step")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Provenance sourceUrl={entry.sourceUrl} attribution={entry.attribution} />
    </div>
  );

  return (
    <>
      <Room className="pt-6 pb-2 text-[12px] text-faint">
        <Link href="/screens" className="hover:text-lit">Screens</Link>
        {entry.source ? (
          <>
            <span className="mx-2">/</span>
            <Link href={`/sources/${entry.source.slug}`} className="hover:text-lit">{entry.source.name}</Link>
          </>
        ) : null}
        <span className="ml-4 hidden text-faint md:inline">← → to step · i for details</span>
      </Room>

      <Viewer slides={items.map(toSlide)} initialIndex={index} mode="route" info={info} infoTitle="About this screen" />

      {entry.states.length > 0 ? (
        <Room className="mt-24">
          <SectionLabel title="Other states of this page" count={entry.states.length} />
          <ContactSheet items={entry.states} showSource={false} />
        </Room>
      ) : null}

      {entry.interactions.length > 0 ? (
        <Room className="mt-24">
          <SectionLabel title="Interactions" count={entry.interactions.length} />
          <ContactSheet items={entry.interactions} showSource={false} />
        </Room>
      ) : null}
    </>
  );
}
