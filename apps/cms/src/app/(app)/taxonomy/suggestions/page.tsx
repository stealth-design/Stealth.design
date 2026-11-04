import { listPendingSuggestions, listTaxonomyTerms } from "@uxd/api";
import { DEFAULT_MIN_AUTO_APPLY_CONFIDENCE } from "@uxd/types";
import { EmptyState, LinkButton, PageHeader, Panel } from "@/components/ui/primitives";
import { Pagination } from "@/components/pagination";
import { getAdminContextWith } from "@/lib/server";
import { SuggestionQueue } from "./queue";

export const metadata = { title: "Classification suggestions" };

const PAGE_SIZE = 40;

/**
 * The classification review queue (§14).
 *
 * Ordered by confidence descending, which sounds backwards for a review queue
 * until you work one: the high-confidence suggestions are the ones a reviewer
 * can confirm in a keystroke, so putting them first clears the bulk quickly and
 * leaves the genuinely uncertain ones — where a person's judgement is actually
 * needed — as the remainder.
 *
 * Nothing on this screen applies automatically. The confidence figure is shown
 * so a reviewer can calibrate their own trust in the model, not so the system
 * can decide on their behalf.
 */
export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const context = await getAdminContextWith("classification.read");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const [{ rows, total }, terms] = await Promise.all([
    listPendingSuggestions(context.db, { page, pageSize: PAGE_SIZE }),
    // The full vocabulary, so a correction is a choice from a list rather than
    // free text — which is what keeps near-duplicate terms from accumulating.
    listTaxonomyTerms(context.db, { statuses: ["active"] }),
  ]);

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Taxonomy", href: "/taxonomy" }]}
        title="Classification suggestions"
        description="Machine suggestions waiting for a person. Nothing here is applied until someone confirms it."
        count={`${total.toLocaleString("en-US")} pending`}
        actions={<LinkButton href="/taxonomy">Back to taxonomy</LinkButton>}
      />

      <div className="space-y-3 p-4">
        {rows.length === 0 ? (
          <Panel>
            <EmptyState
              title="No suggestions waiting"
              description="Every machine suggestion has been confirmed, corrected or rejected."
              action={<LinkButton href="/reviews">Go to the review queue</LinkButton>}
            />
          </Panel>
        ) : (
          <SuggestionQueue
            suggestions={rows.map((row) => ({
              assignmentId: row.assignment.id,
              termId: row.term.id,
              termName: row.term.name,
              termKind: row.term.kind,
              termPath: row.term.path,
              confidence: row.assignment.confidence,
              model: row.assignment.model,
              contentId: row.contentId,
              contentTitle: row.contentTitle,
              contentKind: row.contentKind,
              contentStatus: row.contentStatus,
            }))}
            terms={terms.map((term) => ({
              id: term.id,
              name: term.name,
              kind: term.kind,
              path: term.path,
            }))}
            autoApplyFloor={DEFAULT_MIN_AUTO_APPLY_CONFIDENCE}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Pagination
            basePath="/taxonomy/suggestions"
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            searchParams={params}
          />
          <p className="max-w-xl text-2xs leading-relaxed text-ink-500">
            Confirming records the assignment as human-verified. Correcting records it as
            human-modified and keeps the model's original term, so how often a person had to fix a
            suggestion is answerable later. Rejecting keeps the row too — a suggestion someone
            refused is a more useful signal than a missing one.
          </p>
        </div>
      </div>
    </>
  );
}
