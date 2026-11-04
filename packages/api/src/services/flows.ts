/**
 * Flows — ordered journeys assembled from Screens (§10, §11).
 *
 * A Flow owns no pixels. It is a name, a goal, and an ordered list of pointers
 * at Screens that already exist, which is what makes the same Screen usable in
 * three different journeys without being photographed three times. "Do not
 * duplicate Screen records unnecessarily" is not a guideline here; it is a
 * consequence of the shape.
 *
 *   Flow --(flow_steps, ordered)--> Screen
 *
 * `flow_steps` carries the order and a per-step label, because the same Screen
 * means different things at different points: "Dashboard" is the destination of
 * a signup flow and the origin of a settings flow, and the step label is where
 * that difference lives.
 *
 * Positions are 1-based and contiguous. They are rewritten wholesale on every
 * structural change rather than patched, because a unique index on
 * (flow_id, position) turns any clever incremental shuffle into a constraint
 * violation halfway through — and a flow whose steps are numbered 1, 2, 4, 7
 * is a bug a reviewer has to notice before they can trust anything else.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  contentItems,
  flowDetails,
  flowSteps,
  screenDetails,
  sources,
} from "@uxd/database";
import { AppError, ErrorCode, dedupeSlug, sanitizeText, slugify, uuidv7 } from "@uxd/shared";
import { recordAudit } from "../audit.js";
import { type AdminContext, type BaseContext, inTransaction } from "../context.js";
import { sendToReview } from "./publishing.js";

export interface CreateFlowInput {
  readonly name: string;
  readonly goal?: string | null;
  readonly description?: string | null;
  readonly sourceId?: string | null;
}

export async function createFlow(
  context: AdminContext,
  input: CreateFlowInput,
): Promise<{ flowId: string; slug: string }> {
  const name = sanitizeText(input.name, { maxLength: 200 });
  if (!name) throw new AppError(ErrorCode.VALIDATION_FAILED, "A flow needs a name.");

  const [source] = input.sourceId
    ? await context.db
        .select({ name: sources.name })
        .from(sources)
        .where(eq(sources.id, input.sourceId))
        .limit(1)
    : [];

  const base = slugify([source?.name, name].filter(Boolean).join(" ")) || "flow";
  const taken = await existingFlowSlugs(context.db, base);
  const slug = dedupeSlug(base, taken);

  const flowId = uuidv7();
  await inTransaction(context, async (tx) => {
    await tx.db.insert(contentItems).values({
      id: flowId,
      kind: "flow",
      // A flow starts as a draft, not `needs_review`: it is genuinely
      // incomplete until it has steps, and putting an empty flow in the review
      // queue wastes the reviewer's turn.
      status: "draft",
      sourceId: input.sourceId ?? null,
      title: name,
      slug,
      description: sanitizeText(input.description ?? null, { maxLength: 2_000 }),
      originalCompany: source?.name ?? null,
      platform: "web",
      createdBy: context.actor.id,
      updatedBy: context.actor.id,
    });

    await tx.db.insert(flowDetails).values({
      contentItemId: flowId,
      goal: sanitizeText(input.goal ?? null, { maxLength: 500 }),
      stepCount: 0,
    });
  });

  await recordAudit(context.db, context, {
    action: "flow.created",
    entityType: "flow",
    entityId: flowId,
    entityLabel: name,
    context: { sourceId: input.sourceId ?? null },
  });

  return { flowId, slug };
}

/**
 * Put a Screen at the end of a flow.
 *
 * Called by the studio on every capture when a session is capturing into a
 * flow, which is what makes "create the flow, then walk the product" work
 * without a separate assembly step afterwards.
 *
 * Takes a `Db` rather than a context because the studio calls it from inside
 * its capture transaction: the Screen and its flow step have to land together
 * or a flow ends up with a gap nobody can explain.
 */
export async function appendFlowStep(
  db: Db,
  input: { flowId: string; contentItemId: string; label?: string | null; note?: string | null },
): Promise<number> {
  const inserted = await db.execute<{ position: number }>(sql`
    insert into ${flowSteps} (id, flow_id, content_item_id, position, label, note)
    select ${uuidv7()}, ${input.flowId}, ${input.contentItemId},
           coalesce(max(s.position), 0) + 1,
           ${sanitizeText(input.label ?? null, { maxLength: 200 })},
           ${sanitizeText(input.note ?? null, { maxLength: 1_000 })}
      from ${flowSteps} s
     where s.flow_id = ${input.flowId}
    returning position
  `);

  await syncFlowShape(db, input.flowId);
  return inserted.rows[0]?.position ?? 1;
}

/** Add existing Screens to a flow from the CMS, in the order given. */
export async function addScreensToFlow(
  context: AdminContext,
  flowId: string,
  screenIds: readonly string[],
): Promise<{ added: number }> {
  if (screenIds.length === 0) return { added: 0 };

  const screens = await context.db
    .select({ id: contentItems.id, title: contentItems.title })
    .from(contentItems)
    .where(and(inArray(contentItems.id, [...screenIds]), eq(contentItems.kind, "screen")));

  const byId = new Map(screens.map((s) => [s.id, s]));
  let added = 0;

  await inTransaction(context, async (tx) => {
    // In the order the caller gave, not the order the database returned them.
    for (const id of screenIds) {
      const screen = byId.get(id);
      if (!screen) continue;
      await appendFlowStep(tx.db, { flowId, contentItemId: id, label: screen.title });
      added += 1;
    }
  });

  await recordAudit(context.db, context, {
    action: "flow.steps_changed",
    entityType: "flow",
    entityId: flowId,
    context: { added, screenIds: screenIds.slice(0, 50) },
  });

  return { added };
}

/**
 * Rewrite a flow's order.
 *
 * Takes step ids in their new order and renumbers everything. Two-phase,
 * because the unique index on (flow_id, position) will reject a direct swap:
 * moving step 2 to position 1 collides with the step already there. Offsetting
 * every position into a range nothing occupies, then bringing them back down,
 * is the standard way through and is why this is not a single UPDATE.
 */
export async function reorderFlowSteps(
  context: AdminContext,
  flowId: string,
  orderedStepIds: readonly string[],
): Promise<{ reordered: number }> {
  const steps = await context.db
    .select({ id: flowSteps.id })
    .from(flowSteps)
    .where(eq(flowSteps.flowId, flowId));

  const known = new Set(steps.map((s) => s.id));
  const ordered = orderedStepIds.filter((id) => known.has(id));

  if (ordered.length !== steps.length) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      "The new order must list every step in this flow exactly once.",
    );
  }

  await inTransaction(context, async (tx) => {
    const offset = steps.length + 1000;
    await tx.db
      .update(flowSteps)
      .set({ position: sql`${flowSteps.position} + ${offset}` })
      .where(eq(flowSteps.flowId, flowId));

    for (const [index, stepId] of ordered.entries()) {
      await tx.db
        .update(flowSteps)
        .set({ position: index + 1 })
        .where(and(eq(flowSteps.id, stepId), eq(flowSteps.flowId, flowId)));
    }
  });

  await syncFlowShape(context.db, flowId);

  await recordAudit(context.db, context, {
    action: "flow.steps_changed",
    entityType: "flow",
    entityId: flowId,
    context: { reordered: ordered.length },
  });

  return { reordered: ordered.length };
}

export async function removeFlowStep(
  context: AdminContext,
  flowId: string,
  stepId: string,
): Promise<{ removed: boolean }> {
  const deleted = await context.db
    .delete(flowSteps)
    .where(and(eq(flowSteps.id, stepId), eq(flowSteps.flowId, flowId)))
    .returning({ id: flowSteps.id });

  if (deleted.length === 0) return { removed: false };

  // Close the gap the removal left, so positions stay contiguous.
  await renumberFlow(context.db, flowId);
  await syncFlowShape(context.db, flowId);

  await recordAudit(context.db, context, {
    action: "flow.steps_changed",
    entityType: "flow",
    entityId: flowId,
    context: { removed: stepId },
  });

  return { removed: true };
}

export async function updateFlowStep(
  context: AdminContext,
  flowId: string,
  stepId: string,
  input: { label?: string | null; note?: string | null },
): Promise<void> {
  await context.db
    .update(flowSteps)
    .set({
      label: sanitizeText(input.label ?? null, { maxLength: 200 }),
      note: sanitizeText(input.note ?? null, { maxLength: 1_000 }),
    })
    .where(and(eq(flowSteps.id, stepId), eq(flowSteps.flowId, flowId)));

  await recordAudit(context.db, context, {
    action: "flow.steps_changed",
    entityType: "flow",
    entityId: flowId,
    context: { stepId, relabelled: true },
  });
}

export async function updateFlow(
  context: AdminContext,
  flowId: string,
  input: { name?: string; goal?: string | null; description?: string | null; observations?: string | null },
): Promise<void> {
  await inTransaction(context, async (tx) => {
    if (input.name !== undefined || input.description !== undefined) {
      await tx.db
        .update(contentItems)
        .set({
          ...(input.name !== undefined
            ? { title: sanitizeText(input.name, { maxLength: 200 }) ?? undefined }
            : {}),
          ...(input.description !== undefined
            ? { description: sanitizeText(input.description, { maxLength: 2_000 }) }
            : {}),
          updatedBy: context.actor.id,
          updatedAt: new Date(),
        })
        .where(and(eq(contentItems.id, flowId), eq(contentItems.kind, "flow")));
    }

    if (input.goal !== undefined || input.observations !== undefined) {
      await tx.db
        .update(flowDetails)
        .set({
          ...(input.goal !== undefined
            ? { goal: sanitizeText(input.goal, { maxLength: 500 }) }
            : {}),
          ...(input.observations !== undefined
            ? { observations: sanitizeText(input.observations, { maxLength: 4_000 }) }
            : {}),
        })
        .where(eq(flowDetails.contentItemId, flowId));
    }
  });

  await recordAudit(context.db, context, {
    action: "flow.updated",
    entityType: "flow",
    entityId: flowId,
    context: { fields: Object.keys(input) },
  });
}

/**
 * Send a flow to the review queue (§11).
 *
 * A flow's lifecycle is draft → needs_review → approved → published, and this
 * is the step that was missing: a flow is genuinely incomplete until it has
 * steps, so it starts as a draft, and nothing should be able to approve it
 * straight out of that state. The refusal below is the product rule stated
 * once — an empty flow in the review queue wastes a reviewer's turn and
 * produces a published journey with nothing in it.
 */
export async function submitFlowForReview(
  context: AdminContext,
  flowId: string,
): Promise<{ stepCount: number }> {
  const [flow] = await context.db
    .select({
      id: contentItems.id,
      status: contentItems.status,
      title: contentItems.title,
      stepCount: flowDetails.stepCount,
    })
    .from(contentItems)
    .innerJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
    .where(and(eq(contentItems.id, flowId), eq(contentItems.kind, "flow")))
    .limit(1);

  if (!flow) throw new AppError(ErrorCode.NOT_FOUND, "That flow does not exist.");
  if (flow.stepCount === 0) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      "This flow has no steps yet. Walk the journey and capture its screens first.",
    );
  }

  await sendToReview(context.db, flowId, "new_capture");

  await recordAudit(context.db, context, {
    action: "content.status_changed",
    entityType: "content",
    entityId: flowId,
    entityLabel: flow.title,
    context: { to: "needs_review", stepCount: flow.stepCount },
  });

  return { stepCount: flow.stepCount };
}

/** Contiguous 1..n, in current position order. */
async function renumberFlow(db: Db, flowId: string): Promise<void> {
  await db.execute(sql`
    with ranked as (
      select id, row_number() over (order by position) rn
        from ${flowSteps}
       where flow_id = ${flowId}
    )
    update ${flowSteps} s
       set position = ranked.rn + 100000
      from ranked
     where s.id = ranked.id
  `);
  await db.execute(sql`
    update ${flowSteps} set position = position - 100000
     where flow_id = ${flowId} and position > 100000
  `);
}

/**
 * Recompute a flow's derived shape: step count, entry and exit.
 *
 * Denormalised onto `flow_details` because every list of flows shows "5 steps"
 * and every flow card shows its first screen — counting and re-joining for each
 * row turns one list query into two per flow.
 */
export async function syncFlowShape(db: Db, flowId: string): Promise<void> {
  const steps = await db
    .select({ contentItemId: flowSteps.contentItemId })
    .from(flowSteps)
    .where(eq(flowSteps.flowId, flowId))
    .orderBy(asc(flowSteps.position));

  const entry = steps[0]?.contentItemId ?? null;
  const exit = steps.length > 0 ? (steps[steps.length - 1]?.contentItemId ?? null) : null;

  await db
    .update(flowDetails)
    .set({ stepCount: steps.length, entryContentId: entry, exitContentId: exit })
    .where(eq(flowDetails.contentItemId, flowId));

  // The flow's cover image is its first screen. Set here rather than chosen by
  // an operator, because a flow's identity really is "where it starts".
  if (entry) {
    await db.execute(sql`
      update ${contentItems} f
         set primary_media_id = e.primary_media_id,
             updated_at = now()
        from ${contentItems} e
       where f.id = ${flowId}
         and e.id = ${entry}
         and f.primary_media_id is distinct from e.primary_media_id
    `);
  }
}

/** A flow with its steps resolved to Screens, for the CMS and the public API. */
export async function flowWithSteps(context: BaseContext, flowId: string) {
  const [flow] = await context.db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      slug: contentItems.slug,
      description: contentItems.description,
      status: contentItems.status,
      sourceId: contentItems.sourceId,
      goal: flowDetails.goal,
      observations: flowDetails.observations,
      stepCount: flowDetails.stepCount,
      updatedAt: contentItems.updatedAt,
      publishedAt: contentItems.publishedAt,
    })
    .from(contentItems)
    .innerJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
    .where(and(eq(contentItems.id, flowId), sql`${contentItems.deletedAt} is null`))
    .limit(1);

  if (!flow) return null;

  const steps = await context.db
    .select({
      stepId: flowSteps.id,
      position: flowSteps.position,
      label: flowSteps.label,
      note: flowSteps.note,
      screenId: contentItems.id,
      screenTitle: contentItems.title,
      screenSlug: contentItems.slug,
      screenStatus: contentItems.status,
      mediaId: contentItems.primaryMediaId,
      screenName: screenDetails.screenName,
      stateLabel: screenDetails.stateLabel,
      url: screenDetails.url,
      deviceProfile: screenDetails.deviceProfile,
    })
    .from(flowSteps)
    .innerJoin(contentItems, eq(contentItems.id, flowSteps.contentItemId))
    .leftJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
    .where(eq(flowSteps.flowId, flowId))
    .orderBy(asc(flowSteps.position));

  return { ...flow, steps };
}

async function existingFlowSlugs(db: Db, base: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: contentItems.slug })
    .from(contentItems)
    .where(and(eq(contentItems.kind, "flow"), sql`${contentItems.slug} like ${base + "%"}`));
  return new Set(rows.map((r) => r.slug).filter((s): s is string => s !== null));
}
