import Link from "next/link";
import { EmptyState, PageIntro, Room } from "@/components/gallery";
import { api } from "@/lib/api";
import { humanise, plural } from "@/lib/format";

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

/** The vocabularies screens are classified with, as an index. */
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
      <PageIntro
        title="Patterns"
        count={plural(total, "term")}
        description="What these screens are classified by. Only terms a person has confirmed on published screens appear here."
      />
      {groups.length === 0 ? (
        <EmptyState title="No patterns yet">Terms appear once a person has confirmed them on published screens.</EmptyState>
      ) : (
        <Room className="grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {groups.map((group) => (
            <section key={group.kind}>
              <h2 className="mb-3 text-[12px] text-faint">{humanise(group.kind)}</h2>
              <ul className="space-y-1.5">
                {group.terms.map(({ term, count }) => (
                  <li key={term.id}>
                    <Link
                      href={`/screens?term=${encodeURIComponent(term.slug)}`}
                      title={term.description ?? undefined}
                      className="group flex items-baseline gap-3 text-[13px]"
                    >
                      <span className="text-dim transition-colors group-hover:text-lit">{term.name}</span>
                      <span className="num text-[11px] text-faint">{count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </Room>
      )}
    </>
  );
}
