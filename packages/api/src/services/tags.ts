/**
 * Managing the tags themselves: create, rename, merge, delete.
 *
 * Tags are always put on screens by hand, one screen at a time (see
 * `addAssignment`); this module is about the vocabulary, not about tagging.
 *
 * Three decisions worth knowing:
 *
 *   - **A rename keeps the slug.** The slug is the tag's public address, and a
 *     filter link someone shared should keep working after "Hero" becomes
 *     "Hero section". The old name is kept as an alias, so search still finds
 *     it.
 *   - **Delete removes the tag from every screen.** Assignments cascade. A
 *     tag's sub-tags are not deleted with it; they move up to its parent.
 *   - **Merge moves everything across.** Every screen carrying the old tag
 *     carries the new one instead, the old name becomes an alias of the new
 *     one, and the old tag is deleted. Used for duplicates: "3D" into "3D
 *     components".
 */
import { and, eq, like, ne, sql } from "drizzle-orm";
import { requirePermission } from "@uxd/auth";
import { taxonomyAssignments, taxonomyTerms } from "@uxd/database";
import { AppError, ErrorCode, notFound, sanitizeText, slugify, uuidv7 } from "@uxd/shared";
import { TAXONOMY_KINDS, TAXONOMY_KIND_META, type TaxonomyKind } from "@uxd/types";
import { recordAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";
import { recomputeTermUsage } from "./classification-review.js";

export async function createTag(
  context: AdminContext,
  input: { kind: string; name: string; parentId?: string | null },
): Promise<{ id: string }> {
  requirePermission(context.actor, "taxonomy.create");
  if (!(TAXONOMY_KINDS as readonly string[]).includes(input.kind)) {
    throw fieldError("kind", "Choose where this tag belongs.");
  }
  const kind = input.kind as TaxonomyKind;
  const name = tagName(input.name);
  const slug = slugify(name);
  if (!slug) throw fieldError("name", "Use letters or numbers in the name.");

  return inTransaction(context, async (tx) => {
    await assertNameFree(tx, kind, name, slug, null);

    let path = slug;
    let depth = 0;
    if (input.parentId) {
      const parent = await loadTag(tx, input.parentId);
      if (parent.kind !== kind) throw fieldError("parentId", "A sub-tag must be in the same group as its parent.");
      path = `${parent.path}/${slug}`;
      depth = parent.depth + 1;
    }

    const id = uuidv7();
    await tx.db.insert(taxonomyTerms).values({
      id,
      kind,
      name,
      slug,
      parentId: input.parentId ?? null,
      path,
      depth,
      status: "active",
      createdBy: context.actor.id,
      updatedBy: context.actor.id,
    });
    await recordAudit(tx.db, tx, {
      action: "taxonomy.created",
      entityType: "taxonomy_term",
      entityId: id,
      entityLabel: name,
      after: { kind, name },
    });
    return { id };
  });
}

/** Rename a tag. The slug — its public address — stays; the old name becomes an alias. */
export async function renameTag(context: AdminContext, tagId: string, nextName: string): Promise<void> {
  requirePermission(context.actor, "taxonomy.update");
  const name = tagName(nextName);

  await inTransaction(context, async (tx) => {
    const tag = await loadTag(tx, tagId);
    if (tag.name === name) return;
    await assertNameFree(tx, tag.kind, name, slugify(name), tag.id);

    const aliases = uniqueAliases([...tag.aliases, tag.name], name);
    await tx.db
      .update(taxonomyTerms)
      .set({ name, aliases, updatedBy: context.actor.id, updatedAt: new Date() })
      .where(eq(taxonomyTerms.id, tagId));
    await recordAudit(tx.db, tx, {
      action: "taxonomy.updated",
      entityType: "taxonomy_term",
      entityId: tagId,
      entityLabel: name,
      before: { name: tag.name },
      after: { name },
    });
  });
}

/** Delete a tag and take it off every screen. Its sub-tags move up a level. */
export async function deleteTag(context: AdminContext, tagId: string): Promise<{ removedFrom: number }> {
  requirePermission(context.actor, "taxonomy.archive");

  return inTransaction(context, async (tx) => {
    const tag = await loadTag(tx, tagId);
    await liftChildren(tx, tag);

    const [{ n } = { n: 0 }] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(taxonomyAssignments)
      .where(eq(taxonomyAssignments.termId, tagId));

    await tx.db.delete(taxonomyTerms).where(eq(taxonomyTerms.id, tagId));
    await recordAudit(tx.db, tx, {
      action: "taxonomy.deleted",
      entityType: "taxonomy_term",
      entityId: tagId,
      entityLabel: tag.name,
      before: { kind: tag.kind, name: tag.name },
      context: { removedFrom: n },
    });
    return { removedFrom: n };
  });
}

/** Fold one tag into another: its screens, its sub-tags and its name all move. */
export async function mergeTags(
  context: AdminContext,
  fromId: string,
  intoId: string,
): Promise<{ moved: number }> {
  requirePermission(context.actor, "taxonomy.update");
  if (fromId === intoId) throw new AppError(ErrorCode.CONFLICT, "Choose a different tag to merge into.");

  return inTransaction(context, async (tx) => {
    const from = await loadTag(tx, fromId);
    const into = await loadTag(tx, intoId);

    // Anything already carrying both keeps the one it has; the duplicate goes,
    // or the move below would collide on (term, content).
    await tx.db.execute(sql`
      delete from ${taxonomyAssignments} ta
       where ta.term_id = ${fromId}
         and exists (
           select 1 from ${taxonomyAssignments} k
            where k.term_id = ${intoId}
              and k.content_item_id is not distinct from ta.content_item_id
              and k.source_id is not distinct from ta.source_id
              and k.media_id is not distinct from ta.media_id
         )
    `);
    const moved = await tx.db
      .update(taxonomyAssignments)
      .set({ termId: intoId, updatedAt: new Date() })
      .where(eq(taxonomyAssignments.termId, fromId))
      .returning({ id: taxonomyAssignments.id });
    await tx.db
      .update(taxonomyAssignments)
      .set({ replacedTermId: intoId })
      .where(eq(taxonomyAssignments.replacedTermId, fromId));

    await liftChildren(tx, from, into.kind === from.kind ? into : null);

    await tx.db
      .update(taxonomyTerms)
      .set({
        aliases: uniqueAliases([...into.aliases, from.name, ...from.aliases], into.name),
        updatedBy: context.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(taxonomyTerms.id, intoId));
    await tx.db.delete(taxonomyTerms).where(eq(taxonomyTerms.id, fromId));
    await recomputeTermUsage(tx.db, [intoId]);

    await recordAudit(tx.db, tx, {
      action: "taxonomy.merged",
      entityType: "taxonomy_term",
      entityId: intoId,
      entityLabel: into.name,
      before: { from: from.name, into: into.name },
      context: { fromId, moved: moved.length },
    });
    return { moved: moved.length };
  });
}

// --- Helpers --------------------------------------------------------------

type TagRow = {
  id: string;
  kind: TaxonomyKind;
  name: string;
  slug: string;
  aliases: string[];
  parentId: string | null;
  path: string;
  depth: number;
};

async function loadTag(context: AdminContext, tagId: string): Promise<TagRow> {
  const [tag] = await context.db
    .select({
      id: taxonomyTerms.id,
      kind: taxonomyTerms.kind,
      name: taxonomyTerms.name,
      slug: taxonomyTerms.slug,
      aliases: taxonomyTerms.aliases,
      parentId: taxonomyTerms.parentId,
      path: taxonomyTerms.path,
      depth: taxonomyTerms.depth,
    })
    .from(taxonomyTerms)
    .where(eq(taxonomyTerms.id, tagId))
    .limit(1);
  if (!tag) throw notFound("Tag");
  return tag as TagRow;
}

/**
 * Move a tag's sub-tags to a new parent — the tag's own parent by default —
 * and rewrite the materialised paths of everything beneath it.
 */
async function liftChildren(context: AdminContext, tag: TagRow, newParent?: TagRow | null): Promise<void> {
  const parent =
    newParent === undefined ? (tag.parentId ? await loadTag(context, tag.parentId) : null) : newParent;
  const children = await context.db
    .select({ id: taxonomyTerms.id, slug: taxonomyTerms.slug, path: taxonomyTerms.path })
    .from(taxonomyTerms)
    .where(eq(taxonomyTerms.parentId, tag.id));

  for (const child of children) {
    const path = parent ? `${parent.path}/${child.slug}` : child.slug;
    const depth = parent ? parent.depth + 1 : 0;
    await context.db
      .update(taxonomyTerms)
      .set({ parentId: parent?.id ?? null, path, depth, updatedAt: new Date() })
      .where(eq(taxonomyTerms.id, child.id));
    // Everything under the child keeps its tail; only the prefix changes.
    const descendants = await context.db
      .select({ id: taxonomyTerms.id, path: taxonomyTerms.path, depth: taxonomyTerms.depth })
      .from(taxonomyTerms)
      .where(and(like(taxonomyTerms.path, `${child.path}/%`), ne(taxonomyTerms.id, child.id)));
    for (const descendant of descendants) {
      const tail = descendant.path.slice(child.path.length);
      await context.db
        .update(taxonomyTerms)
        .set({ path: `${path}${tail}`, depth: depth + tail.split("/").length - 1 })
        .where(eq(taxonomyTerms.id, descendant.id));
    }
  }
}

async function assertNameFree(
  context: AdminContext,
  kind: TaxonomyKind,
  name: string,
  slug: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await context.db
    .select({ id: taxonomyTerms.id, name: taxonomyTerms.name })
    .from(taxonomyTerms)
    .where(
      and(
        eq(taxonomyTerms.kind, kind),
        sql`(lower(${taxonomyTerms.name}) = ${name.toLowerCase()} or ${taxonomyTerms.slug} = ${slug})`,
        exceptId ? ne(taxonomyTerms.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (clash[0]) {
    throw fieldError(
      "name",
      `There's already a tag called "${clash[0].name}" in ${TAXONOMY_KIND_META[kind].plural}. Merge into it instead.`,
    );
  }
}

function tagName(value: string): string {
  const name = sanitizeText(value, { maxLength: 80, singleLine: true });
  if (!name) throw fieldError("name", "Give the tag a name.");
  return name;
}

function uniqueAliases(aliases: readonly string[], name: string): string[] {
  const seen = new Set([name.toLowerCase()]);
  const out: string[] = [];
  for (const alias of aliases) {
    const key = alias.toLowerCase();
    if (!alias.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out.slice(0, 40);
}

function fieldError(path: string, message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, message, { issues: [{ path, message }] });
}

