"use server";

import { globalSearch } from "@uxd/api";
import { can, requirePermission } from "@uxd/auth";
import { LIFECYCLE_STATUS_META, TAXONOMY_KIND_META, type LifecycleStatus, type TaxonomyKind } from "@uxd/types";
import { getAdminContext } from "@/lib/server";

export interface SearchResults {
  readonly groups: readonly {
    readonly label: string;
    readonly items: readonly { readonly label: string; readonly href: string; readonly hint?: string }[];
  }[];
}

/**
 * Cross-entity search for the command palette.
 *
 * Re-checks the actor's permission per entity type: a Researcher who cannot
 * read the audit log should not find audit rows through search either, and the
 * palette is exactly the kind of surface where that gets forgotten.
 */
export async function searchAction(query: string): Promise<SearchResults> {
  const context = await getAdminContext();
  requirePermission(context.actor, "content.read");

  const results = await globalSearch(context.db, query, 5);
  const canSeeCollections = can(context.actor, "collection.read");
  const canSeeMedia = can(context.actor, "media.read");
  const canSeeSources = can(context.actor, "source.read");
  const canSeeJobs = can(context.actor, "ingestion.read");
  const canSeeTaxonomy = can(context.actor, "taxonomy.read");

  return {
    groups: [
      {
        label: "Content",
        items: results.content.map((row) => ({
          label: row.title ?? "Untitled",
          href: `/content/${row.id}`,
          hint: `${row.kind} · ${LIFECYCLE_STATUS_META[row.status as LifecycleStatus].label}`,
        })),
      },
      {
        label: "Matched by URL",
        items: (results.byUrl ?? [])
          .filter((row) => row.contentItemId !== null)
          .map((row) => ({
            label: row.normalizedUrl,
            href: `/content/${row.contentItemId}`,
            hint: "captured page",
          })),
      },
      {
        label: "Sources",
        items: !canSeeSources ? [] : results.sources.map((row) => ({
          label: row.name,
          href: `/sources/${row.id}`,
          hint: row.domain ?? undefined,
        })),
      },
      {
        label: "Media",
        items: !canSeeMedia ? [] : results.media.map((row) => ({
          label: row.originalFilename ?? row.id,
          href: `/media/${row.id}`,
          hint: row.mimeType,
        })),
      },
      {
        label: "Taxonomy",
        items: !canSeeTaxonomy ? [] : results.terms.map((row) => ({
          label: row.name,
          href: `/taxonomy?kind=${row.kind}&q=${encodeURIComponent(row.name)}`,
          hint: `${TAXONOMY_KIND_META[row.kind as TaxonomyKind].label} · used ${row.usageCount}×`,
        })),
      },
      {
        label: "Crawl jobs",
        items: !canSeeJobs ? [] : results.jobs.map((row) => ({
          label: row.name,
          href: `/crawl-jobs/${row.id}`,
          hint: `${row.reference} · ${row.status}`,
        })),
      },
      {
        label: "Collections",
        items: !canSeeCollections
          ? []
          : results.collections.map((row) => ({
              label: row.name,
              href: `/collections/${row.id}`,
              hint: row.visibility,
            })),
      },
    ],
  };
}
