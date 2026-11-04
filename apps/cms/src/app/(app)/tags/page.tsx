import { listTaxonomyTerms } from "@uxd/api";
import { can } from "@uxd/auth";
import { Page } from "@/components/page";
import { getAdminContextWith } from "@/lib/server";
import { TagManager } from "./tag-manager";

export const metadata = { title: "Tags" };

/**
 * The tags screens are filed under, in the two groups the public site filters
 * by: Industry, and Types — everything about the design itself.
 *
 * Everyone can see them; only admins change them. Tags are put on screens by
 * hand, in the Studio, Inbox and Library — this page is the vocabulary.
 */
export default async function TagsPage() {
  const context = await getAdminContextWith("taxonomy.read");
  const terms = await listTaxonomyTerms(context.db, { statuses: ["active"] });

  return (
    <Page title="Tags" description="What screens are filed under, and what the public site filters by.">
      <TagManager
        tags={terms.map((term) => ({
          id: term.id,
          kind: term.kind,
          name: term.name,
          aliases: term.aliases,
          depth: term.depth,
          path: term.path,
          usage: term.usageCount,
        }))}
        permissions={{
          create: can(context.actor, "taxonomy.create"),
          update: can(context.actor, "taxonomy.update"),
          remove: can(context.actor, "taxonomy.archive"),
        }}
      />
    </Page>
  );
}
