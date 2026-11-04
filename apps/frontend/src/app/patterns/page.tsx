import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/gallery";
import { Reveal } from "@/components/reveal";
import { api } from "@/lib/api";
import { kindLabel, plural } from "@/lib/format";

export const metadata = { title: "Patterns" };

const ORDER = [
  "ux_pattern",
  "ui_pattern",
  "component",
  "page_type",
  "screen_type",
  "function",
  "state",
  "design_style",
  "industry",
  "platform",
  "device",
];

/**
 * The vocabularies screens are classified with: one centred title per
 * vocabulary, its terms beneath as a dotted line of links.
 */
export default async function PatternsPage() {
  const facets = await api.listFacets();
  const total = facets.reduce((sum, group) => sum + group.terms.length, 0);
  const groups = [
    ...ORDER.filter((kind) => facets.some((group) => group.kind === kind)).map(
      (kind) => facets.find((group) => group.kind === kind)!,
    ),
    ...facets.filter((group) => !ORDER.includes(group.kind)),
  ].filter((group) => group.terms.length > 0);

  return (
    <>
      <PageHeader
        label={plural(total, "tag")}
        title="Tags"
        note="Every tag on the site. Pick one to see the websites that have it."
      />

      {groups.length === 0 ? (
        <EmptyState title="No patterns yet">
          Tags show up here once websites have them.
        </EmptyState>
      ) : (
        <div className="border-b">
          {groups.map((group) => (
            <Reveal
              key={group.kind}
              className="border-t px-4 py-14 text-center md:px-10 md:py-20"
            >
              <h2 className="t-title">{kindLabel(group.kind)}</h2>
              <p className="t-label mx-auto mt-7 flex max-w-5xl flex-wrap justify-center gap-x-6 gap-y-3">
                {group.terms.map(({ term, count }) => (
                  <Link
                    key={term.id}
                    href={`/screens?term=${encodeURIComponent(term.slug)}`}
                    title={term.description ?? undefined}
                    className="flex items-center gap-2 hover:opacity-60"
                  >
                    <span
                      aria-hidden
                      className="size-1 rounded-full bg-muted-foreground"
                    />
                    {term.name}
                    <span className="text-muted-foreground">{count}</span>
                  </Link>
                ))}
              </p>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );
}
