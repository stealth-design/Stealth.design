import Link from "next/link";
import { ContactSheet, EmptyState, Filters, PageIntro, Pager, Room } from "@/components/gallery";
import { api } from "@/lib/api";
import { humanise, plural } from "@/lib/format";

export const metadata = { title: "Screens" };

const PAGE_SIZE = 40;

/** The vocabularies worth filtering screens by, in the order they are shown. */
const FACET_ORDER = [
  "screen_type",
  "page_type",
  "ux_pattern",
  "ui_pattern",
  "component",
  "state",
  "function",
  "industry",
  "design_style",
];

/**
 * Every published screen, as a contact sheet. Filters are query parameters,
 * so every view is a URL that can be shared and works without JavaScript.
 */
export default async function ScreensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const many = (key: string): string[] => {
    const value = params[key];
    return Array.isArray(value) ? value : value ? [value] : [];
  };

  const page = Math.max(1, Number(single("page") ?? 1) || 1);
  const terms = many("term");
  const q = single("q");
  const sourceSlug = single("source");
  const device = single("device");
  const sort = (single("sort") as "recent" | "captured" | "title" | undefined) ?? "recent";

  const [results, facets] = await Promise.all([
    api.listScreens({ q, source: sourceSlug, term: terms, device, sort, page, pageSize: PAGE_SIZE }),
    api.listFacets(),
  ]);

  const withParams = (changes: Record<string, string | string[] | undefined>): string => {
    const next = new URLSearchParams();
    const base: Record<string, string | string[] | undefined> = {
      q,
      source: sourceSlug,
      device,
      sort: sort === "recent" ? undefined : sort,
      term: terms,
      ...changes,
    };
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined || value === "") continue;
      if (Array.isArray(value)) for (const item of value) next.append(key, item);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `/screens?${query}` : "/screens";
  };

  const toggleTerm = (slug: string): string =>
    withParams({
      term: terms.includes(slug) ? terms.filter((t) => t !== slug) : [...terms, slug],
      page: undefined,
    });

  const activeCount = terms.length + (q ? 1 : 0) + (sourceSlug ? 1 : 0) + (device ? 1 : 0);
  const totalPages = Math.max(1, Math.ceil(results.total / PAGE_SIZE));
  const groups = facets
    .filter((group) => FACET_ORDER.includes(group.kind) && group.terms.length > 0)
    .sort((a, b) => FACET_ORDER.indexOf(a.kind) - FACET_ORDER.indexOf(b.kind));

  return (
    <>
      <PageIntro
        title={q ? `“${q}”` : "Screens"}
        count={plural(results.total, "screen")}
        description={q ? null : "Every screen in the library, captured at full resolution and approved by a person."}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Filters
              label="Device"
              options={[
                { label: "All", href: withParams({ device: undefined, page: undefined }), active: !device },
                { label: "Desktop", href: withParams({ device: "desktop", page: undefined }), active: device === "desktop" },
                { label: "Mobile", href: withParams({ device: "mobile", page: undefined }), active: device === "mobile" },
              ]}
            />
            <Filters
              label="Sort"
              options={[
                { label: "Recent", href: withParams({ sort: undefined }), active: sort === "recent" },
                { label: "A–Z", href: withParams({ sort: "title" }), active: sort === "title" },
              ]}
            />
          </div>
          {groups.map((group) => (
            <Filters
              key={group.kind}
              label={humanise(group.kind)}
              options={group.terms.map((entry) => ({
                label: entry.term.name,
                href: toggleTerm(entry.term.slug),
                count: entry.count,
                active: terms.includes(entry.term.slug),
                title: entry.term.description ?? undefined,
              }))}
            />
          ))}
          {activeCount > 0 ? (
            <Link href="/screens" className="inline-block pt-1 text-[12px] text-dim underline underline-offset-4 hover:text-lit">
              Clear {plural(activeCount, "filter")}
            </Link>
          ) : null}
        </div>
      </PageIntro>

      {results.items.length === 0 ? (
        <EmptyState title="Nothing matches">Try fewer filters.</EmptyState>
      ) : (
        <Room>
          <ContactSheet items={results.items} numberFrom={(page - 1) * PAGE_SIZE + 1} />
        </Room>
      )}

      <Pager page={page} totalPages={totalPages} href={(target) => withParams({ page: target === 1 ? undefined : String(target) })} />
    </>
  );
}
