/**
 * Human review of machine classifications (§14).
 *
 * The brief is unambiguous about who decides: "Humans are the final authority."
 * That is a claim about data, not about UI, so it is enforced here rather than
 * in a screen. Three things follow.
 *
 * **A suggestion is never silently promoted.** An `ai_suggested` assignment
 * sits at `review_status: 'pending'` until a person acts on it, and the public
 * queries filter on origin — so an unreviewed guess cannot appear publicly even
 * if a bug published the record.
 *
 * **A correction is recorded as a correction.** Accepting turns the origin into
 * `human_verified`; changing the term turns it into `human_modified` and keeps
 * the model's original term in `replaced_term_id`. That is what makes model
 * quality measurable later: "how often did a person have to fix this?" is a
 * query rather than a guess.
 *
 * **Rejection is not deletion.** A rejected suggestion keeps its row with
 * `review_status: 'rejected'`, because the fact that a model proposed something
 * a person refused is the useful signal. Deleting it would make the same wrong
 * suggestion look novel next time.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { requirePermission } from "@uxd/auth";
import {
  type Db,
  contentItems,
  taxonomyAssignments,
  taxonomyTerms,
} from "@uxd/database";
import { AppError, ErrorCode, notFound, uuidv7 } from "@uxd/shared";
import { TAXONOMY_KIND_META, type TaxonomyKind } from "@uxd/types";
import { recordAudit, recordBulkAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";

export type SuggestionDecision = "accept" | "reject" | "modify";

export interface ReviewSuggestionInput {
  readonly assignmentId: string;
  readonly decision: SuggestionDecision;
  /** Required for `modify`: the term the person actually means. */
  readonly termId?: string;
  readonly note?: string | null;
}

/**
 * Act on one suggestion.
 *
 * Single-value vocabularies are handled here rather than by a constraint: when
 * a kind is marked `singleValue`, accepting a term demotes any other confirmed
 * term of that kind on the same record to non-primary instead of failing. A
 * page has one page type; discovering that by way of a constraint violation
 * mid-review would be a bad way to learn it.
 */
export async function reviewSuggestion(
  context: AdminContext,
  input: ReviewSuggestionInput,
): Promise<void> {
  requirePermission(context.actor, "classification.review");

  if (input.decision === "modify" && !input.termId) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Choose the term you mean.", {
      issues: [{ path: "termId", message: "A correction needs a replacement term." }],
    });
  }

  await inTransaction(context, async (tx) => {
    const [existing] = await tx.db
      .select({
        id: taxonomyAssignments.id,
        termId: taxonomyAssignments.termId,
        contentItemId: taxonomyAssignments.contentItemId,
        origin: taxonomyAssignments.origin,
        reviewStatus: taxonomyAssignments.reviewStatus,
        confidence: taxonomyAssignments.confidence,
        model: taxonomyAssignments.model,
        termName: taxonomyTerms.name,
        termKind: taxonomyTerms.kind,
      })
      .from(taxonomyAssignments)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
      .where(eq(taxonomyAssignments.id, input.assignmentId))
      .limit(1);
    if (!existing) throw notFound("Suggestion");

    const now = new Date();

    if (input.decision === "reject") {
      await tx.db
        .update(taxonomyAssignments)
        .set({
          reviewStatus: "rejected",
          reviewedBy: context.actor.id,
          reviewedAt: now,
          note: input.note ?? null,
          updatedAt: now,
        })
        .where(eq(taxonomyAssignments.id, input.assignmentId));

      await recordAudit(tx.db, context, {
        action: "classification.rejected",
        entityType: "taxonomy_assignment",
        entityId: input.assignmentId,
        entityLabel: existing.termName,
        before: { origin: existing.origin, reviewStatus: existing.reviewStatus },
        after: { reviewStatus: "rejected" },
        context: {
          model: existing.model,
          confidence: existing.confidence,
          reason: input.note ?? null,
        },
      });
      return;
    }

    // Accept, or accept-with-a-different-term.
    const replacing = input.decision === "modify" && input.termId !== existing.termId;
    const finalTermId = replacing ? input.termId! : existing.termId;

    let finalKind = existing.termKind;
    if (replacing) {
      const [replacement] = await tx.db
        .select({ id: taxonomyTerms.id, name: taxonomyTerms.name, kind: taxonomyTerms.kind, status: taxonomyTerms.status })
        .from(taxonomyTerms)
        .where(eq(taxonomyTerms.id, finalTermId))
        .limit(1);
      if (!replacement) throw notFound("Term");
      if (replacement.status === "archived") {
        throw new AppError(ErrorCode.VALIDATION_FAILED, "That term is archived.", {
          issues: [
            { path: "termId", message: "Reactivate the term, or choose one that is still active." },
          ],
        });
      }
      finalKind = replacement.kind;
    }

    const kindMeta = TAXONOMY_KIND_META[finalKind as TaxonomyKind];

    // Moving the assignment to a term the record already carries would violate
    // the unique (term, content) index. Merging is the sensible reading of the
    // operator's intent — they want this record classified as that term, and it
    // already is — so the suggestion is closed as modified rather than failing.
    if (replacing && existing.contentItemId) {
      const [clash] = await tx.db
        .select({ id: taxonomyAssignments.id })
        .from(taxonomyAssignments)
        .where(
          and(
            eq(taxonomyAssignments.termId, finalTermId),
            eq(taxonomyAssignments.contentItemId, existing.contentItemId),
            sql`${taxonomyAssignments.id} <> ${input.assignmentId}`,
          ),
        )
        .limit(1);
      if (clash) {
        await tx.db
          .update(taxonomyAssignments)
          .set({
            reviewStatus: "modified",
            reviewedBy: context.actor.id,
            reviewedAt: now,
            note: input.note ?? "Superseded by an assignment the record already carried.",
            updatedAt: now,
          })
          .where(eq(taxonomyAssignments.id, input.assignmentId));

        await tx.db
          .update(taxonomyAssignments)
          .set({
            origin: "human_verified",
            reviewStatus: "accepted",
            reviewedBy: context.actor.id,
            reviewedAt: now,
            updatedAt: now,
          })
          .where(eq(taxonomyAssignments.id, clash.id));

        await recordAudit(tx.db, context, {
          action: "classification.modified",
          entityType: "taxonomy_assignment",
          entityId: input.assignmentId,
          entityLabel: existing.termName,
          before: { termId: existing.termId, origin: existing.origin },
          after: { termId: finalTermId, mergedInto: clash.id },
        });
        return;
      }
    }

    await tx.db
      .update(taxonomyAssignments)
      .set({
        termId: finalTermId,
        origin: replacing ? "human_modified" : "human_verified",
        reviewStatus: replacing ? "modified" : "accepted",
        replacedTermId: replacing ? existing.termId : null,
        reviewedBy: context.actor.id,
        reviewedAt: now,
        isPrimary: kindMeta?.singleValue ?? false,
        note: input.note ?? null,
        updatedAt: now,
      })
      .where(eq(taxonomyAssignments.id, input.assignmentId));

    // A single-value vocabulary: this term becomes the record's one term of its
    // kind, and any other confirmed term of that kind loses primacy.
    if (kindMeta?.singleValue && existing.contentItemId) {
      await tx.db
        .update(taxonomyAssignments)
        .set({ isPrimary: false, updatedAt: now })
        .where(
          and(
            eq(taxonomyAssignments.contentItemId, existing.contentItemId),
            sql`${taxonomyAssignments.id} <> ${input.assignmentId}`,
            sql`${taxonomyAssignments.termId} in (
              select ${taxonomyTerms}.id from ${taxonomyTerms}
              where ${taxonomyTerms}.kind = ${finalKind}
            )`,
          ),
        );
    }

    await recordAudit(tx.db, context, {
      action: replacing ? "classification.modified" : "classification.accepted",
      entityType: "taxonomy_assignment",
      entityId: input.assignmentId,
      entityLabel: existing.termName,
      before: { termId: existing.termId, origin: existing.origin, reviewStatus: existing.reviewStatus },
      after: {
        termId: finalTermId,
        origin: replacing ? "human_modified" : "human_verified",
        reviewStatus: replacing ? "modified" : "accepted",
      },
      context: { model: existing.model, confidence: existing.confidence },
    });

    await recomputeTermUsage(tx.db, [existing.termId, finalTermId]);
  });
}

/**
 * Accept several suggestions at once.
 *
 * Deliberately *not* offered as "accept everything above X confidence" without
 * the operator seeing what they are accepting: the CMS passes explicit ids from
 * a list the person has looked at. A confidence threshold applied to unseen
 * rows is auto-classification with an extra click, which is what §14 rules out.
 */
export async function bulkAcceptSuggestions(
  context: AdminContext,
  assignmentIds: readonly string[],
): Promise<{ accepted: number }> {
  requirePermission(context.actor, "classification.review");
  if (assignmentIds.length === 0) return { accepted: 0 };

  return inTransaction(context, async (tx) => {
    const rows = await tx.db
      .select({
        id: taxonomyAssignments.id,
        termId: taxonomyAssignments.termId,
        termName: taxonomyTerms.name,
      })
      .from(taxonomyAssignments)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
      .where(
        and(
          inArray(taxonomyAssignments.id, [...assignmentIds]),
          eq(taxonomyAssignments.reviewStatus, "pending"),
        ),
      );
    if (rows.length === 0) return { accepted: 0 };

    const now = new Date();
    await tx.db
      .update(taxonomyAssignments)
      .set({
        origin: "human_verified",
        reviewStatus: "accepted",
        reviewedBy: context.actor.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(inArray(taxonomyAssignments.id, rows.map((row) => row.id)));

    await recordBulkAudit(tx.db, context, {
      action: "classification.accepted",
      entityType: "taxonomy_assignment",
      items: rows.map((row) => ({ id: row.id, label: row.termName })),
      summary: `Accepted ${rows.length} classification suggestion${rows.length === 1 ? "" : "s"}`,
    });

    await recomputeTermUsage(tx.db, rows.map((row) => row.termId));
    return { accepted: rows.length };
  });
}

/** Reject several at once, with one reason recorded against each. */
export async function bulkRejectSuggestions(
  context: AdminContext,
  assignmentIds: readonly string[],
  reason: string,
): Promise<{ rejected: number }> {
  requirePermission(context.actor, "classification.review");
  if (assignmentIds.length === 0) return { rejected: 0 };

  return inTransaction(context, async (tx) => {
    const rows = await tx.db
      .select({
        id: taxonomyAssignments.id,
        termId: taxonomyAssignments.termId,
        termName: taxonomyTerms.name,
      })
      .from(taxonomyAssignments)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
      .where(
        and(
          inArray(taxonomyAssignments.id, [...assignmentIds]),
          eq(taxonomyAssignments.reviewStatus, "pending"),
        ),
      );
    if (rows.length === 0) return { rejected: 0 };

    const now = new Date();
    await tx.db
      .update(taxonomyAssignments)
      .set({
        reviewStatus: "rejected",
        reviewedBy: context.actor.id,
        reviewedAt: now,
        note: reason.trim().slice(0, 1_000) || null,
        updatedAt: now,
      })
      .where(inArray(taxonomyAssignments.id, rows.map((row) => row.id)));

    await recordBulkAudit(tx.db, context, {
      action: "classification.rejected",
      entityType: "taxonomy_assignment",
      items: rows.map((row) => ({ id: row.id, label: row.termName })),
      summary: `Rejected ${rows.length} classification suggestion${rows.length === 1 ? "" : "s"}`,
      context: { reason: reason.trim() },
    });

    await recomputeTermUsage(tx.db, rows.map((row) => row.termId));
    return { rejected: rows.length };
  });
}

/**
 * Attach a term to a record directly, with no model involved.
 *
 * `origin: 'human_added'` — the strongest provenance there is, and the only one
 * that needs no review step.
 */
export async function addAssignment(
  context: AdminContext,
  input: { contentItemId: string; termId: string; note?: string | null },
): Promise<{ assignmentId: string; alreadyPresent: boolean }> {
  requirePermission(context.actor, "taxonomy.assign");

  return inTransaction(context, async (tx) => {
    const [content] = await tx.db
      .select({ id: contentItems.id, title: contentItems.title })
      .from(contentItems)
      .where(and(eq(contentItems.id, input.contentItemId), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!content) throw notFound("Content");

    const [term] = await tx.db
      .select({ id: taxonomyTerms.id, name: taxonomyTerms.name, kind: taxonomyTerms.kind, status: taxonomyTerms.status })
      .from(taxonomyTerms)
      .where(eq(taxonomyTerms.id, input.termId))
      .limit(1);
    if (!term) throw notFound("Term");
    if (term.status === "archived") {
      throw new AppError(ErrorCode.VALIDATION_FAILED, "That term is archived.", {
        issues: [{ path: "termId", message: "Choose a term that is still active." }],
      });
    }

    const [existing] = await tx.db
      .select({ id: taxonomyAssignments.id })
      .from(taxonomyAssignments)
      .where(
        and(
          eq(taxonomyAssignments.termId, input.termId),
          eq(taxonomyAssignments.contentItemId, input.contentItemId),
        ),
      )
      .limit(1);

    // Already there, but possibly as an unreviewed suggestion — in which case a
    // person adding it by hand *is* the confirmation.
    if (existing) {
      await tx.db
        .update(taxonomyAssignments)
        .set({
          origin: "human_verified",
          reviewStatus: "accepted",
          reviewedBy: context.actor.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taxonomyAssignments.id, existing.id));
      return { assignmentId: existing.id, alreadyPresent: true };
    }

    const assignmentId = uuidv7();
    await tx.db.insert(taxonomyAssignments).values({
      id: assignmentId,
      termId: input.termId,
      target: "content",
      contentItemId: input.contentItemId,
      origin: "human_added",
      reviewStatus: "accepted",
      isPrimary: TAXONOMY_KIND_META[term.kind as TaxonomyKind]?.singleValue ?? false,
      note: input.note ?? null,
      createdBy: context.actor.id,
    });

    await recordAudit(tx.db, context, {
      action: "taxonomy.assigned",
      entityType: "taxonomy_assignment",
      entityId: assignmentId,
      entityLabel: term.name,
      after: { termId: input.termId, contentItemId: input.contentItemId, origin: "human_added" },
    });

    await recomputeTermUsage(tx.db, [input.termId]);
    return { assignmentId, alreadyPresent: false };
  });
}

/** Detach a term a person put there, or one they had confirmed. */
export async function removeAssignment(
  context: AdminContext,
  assignmentId: string,
): Promise<void> {
  requirePermission(context.actor, "taxonomy.assign");

  await inTransaction(context, async (tx) => {
    const [existing] = await tx.db
      .select({
        id: taxonomyAssignments.id,
        termId: taxonomyAssignments.termId,
        termName: taxonomyTerms.name,
        origin: taxonomyAssignments.origin,
      })
      .from(taxonomyAssignments)
      .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
      .where(eq(taxonomyAssignments.id, assignmentId))
      .limit(1);
    if (!existing) throw notFound("Assignment");

    await tx.db.delete(taxonomyAssignments).where(eq(taxonomyAssignments.id, assignmentId));

    await recordAudit(tx.db, context, {
      action: "taxonomy.unassigned",
      entityType: "taxonomy_assignment",
      entityId: assignmentId,
      entityLabel: existing.termName,
      before: { termId: existing.termId, origin: existing.origin },
    });

    await recomputeTermUsage(tx.db, [existing.termId]);
  });
}

/**
 * Recount `usage_count` for the terms whose assignments changed.
 *
 * Recomputed rather than incremented: an accept can move an assignment from one
 * term to another, a merge can remove one, and a bulk action can touch the same
 * term many times. A counter maintained by deltas across those paths drifts, and
 * a drifted count is worse than a slightly more expensive query, because it is
 * the number a curator uses to decide whether a term is worth keeping.
 *
 * It counts *accepted* assignments only. This used to count everything that was
 * not rejected, which was equivalent while nothing produced suggestions and
 * quietly wrong the moment something did: one classification run put 456 pending
 * suggestions in the table, and 20 of 224 terms started reporting a usage they
 * did not have — `button` showed 56 uses with no content actually carrying it.
 *
 * Accepted-only is also the definition the rest of the system already uses. The
 * public facets select on `HUMAN_CONFIRMED_ORIGINS`, so a term with pending
 * suggestions and no accepted ones genuinely surfaces nothing, and telling a
 * curator otherwise is the opposite of helpful. It has the useful property that
 * only review actions can change the count, which is why no capture path needs
 * to remember to call this.
 */
export async function recomputeTermUsage(db: Db, termIds: readonly string[]): Promise<void> {
  const unique = [...new Set(termIds)].filter((id): id is string => Boolean(id));
  if (unique.length === 0) return;

  await db
    .update(taxonomyTerms)
    .set({
      usageCount: sql`(
        select count(*)::int from ${taxonomyAssignments} ta
        where ta.term_id = ${taxonomyTerms}.id and ta.review_status = 'accepted'
      )`,
    })
    .where(inArray(taxonomyTerms.id, unique));
}
