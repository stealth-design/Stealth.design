/**
 * The capture studio (§2, §3, §4, §10).
 *
 * Three responsibilities, in the order they happen:
 *
 *   1. `openSession`     — an operator asks for a live browser on a URL
 *   2. `enqueueCommand`  — the operator steers it
 *   3. `createScreenFromCapture` — the operator presses Capture, and a Screen
 *                                  record comes into existence
 *
 * Step 3 is the only place in this system that creates a `screen` content
 * record, and it can only be reached from a command a signed-in person issued.
 * That is the architectural claim the whole change rests on: there is no
 * automated path to a Screen, not because a flag is set to false somewhere,
 * but because no other caller exists.
 *
 * Every Screen starts at `needs_review`. Not `draft`, not `approved` — the
 * researcher who captured it still has to name it and confirm its tags, and a
 * capture that skipped that would be a pile of unlabelled screenshots, which is
 * the thing this product is not.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  captureSessionCommands,
  captureSessions,
  captures,
  contentItems,
  discoveredPages,
  flowDetails,
  mediaDerivatives,
  flowSteps,
  screenDetails,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
} from "@uxd/database";
import {
  AppError,
  ErrorCode,
  addMs,
  dedupeSlug,
  registrableDomain,
  sanitizeText,
  slugify,
  uuidv7,
  validateUrl,
} from "@uxd/shared";
import {
  DEVICE_PROFILES,
  STUDIO_LIMITS,
  TAXONOMY_KIND_META,
  type TaxonomyKind,
  type SessionCommandPayload,
  type StudioProfile,
  sessionCommandPayloadSchema,
} from "@uxd/types";
import { recordAudit } from "../audit.js";
import { type AdminContext, type BaseContext, inTransaction } from "../context.js";
import { attachMedia } from "./media-intake.js";
import { resolveSourceForUrl } from "./ingestion.js";
import { classifyAndQueueForReview } from "./capture-intake.js";
import { appendFlowStep } from "./flows.js";
import { recomputeTermUsage } from "./classification-review.js";
import { requirePermission } from "@uxd/auth";
import { endLiveSession, notifyLiveCommand } from "./studio-live.js";

// --- Opening a session ----------------------------------------------------

export interface OpenSessionInput {
  readonly url: string;
  readonly profile: StudioProfile;
  readonly discoveredPageId?: string | null;
  readonly sourceId?: string | null;
  /** Capture into this flow: every Screen becomes its next step. */
  readonly flowId?: string | null;
  /** Tags every Screen from this session starts with. */
  readonly termIds?: readonly string[];
}

export interface OpenSessionResult {
  readonly sessionId: string;
  readonly reusedExisting: boolean;
}

/**
 * Ask a worker to open a browser on a URL.
 *
 * The URL is validated here, before a session row exists, so an operator who
 * pastes something the guard refuses gets the refusal immediately rather than
 * a session that fails thirty seconds later for reasons they cannot see. The
 * worker validates again — it must, since it is the side that actually dials
 * out — but a refusal at this end is a much better experience.
 *
 * An operator who already has a live session on the same URL and profile is
 * handed it back instead of getting a second browser. Two live sessions on one
 * page is never what someone meant; it is what happens when a tab is reopened.
 */
export async function openSession(
  context: AdminContext,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  const parsed = validateUrl(input.url);
  if (!parsed.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
  }

  const profile = DEVICE_PROFILES[input.profile];
  if (!profile) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "That is not a capture profile the studio offers.");
  }

  const [existing] = await context.db
    .select({ id: captureSessions.id, status: captureSessions.status, heartbeatAt: captureSessions.heartbeatAt })
    .from(captureSessions)
    .where(
      and(
        eq(captureSessions.createdBy, context.actor.id),
        eq(captureSessions.targetUrl, parsed.value.fetchUrl),
        eq(captureSessions.deviceProfile, input.profile),
        sql`${captureSessions.status} in ('pending','starting','live')`,
      ),
    )
    .orderBy(desc(captureSessions.createdAt))
    .limit(1);

  const termIds = await resolveSessionTerms(context, input.termIds ?? []);

  // Only a session whose browser is still checking in is worth reusing. One
  // whose worker died — a restart, a crash — would show its last saved frame
  // and never answer, so it is closed and a fresh browser is asked for.
  const alive =
    existing &&
    (existing.status === "pending" ||
      (existing.heartbeatAt !== null && Date.now() - existing.heartbeatAt.getTime() < STUDIO_LIMITS.reuseHeartbeatMs));
  if (existing && !alive) {
    await context.db
      .update(captureSessions)
      .set({
        status: "expired",
        closedAt: new Date(),
        leaseToken: null,
        frame: null,
        frameBytes: null,
        errorCode: "SESSION_ABANDONED",
        errorMessage: "The browser stopped responding; a new one was opened.",
        updatedAt: new Date(),
      })
      .where(eq(captureSessions.id, existing.id));
    endLiveSession(existing.id);
  }

  if (existing && alive) {
    // Reopening the same page is usually "carry on", but with whatever was
    // just chosen in the picker — so the choice is not silently ignored.
    await context.db
      .update(captureSessions)
      .set({ defaultTermIds: termIds, flowId: input.flowId ?? null, updatedAt: new Date() })
      .where(eq(captureSessions.id, existing.id));
    return { sessionId: existing.id, reusedExisting: true };
  }

  // Resolve the source now rather than at capture time, so every Screen from
  // this session lands under the same product even if the operator navigates
  // to a different host mid-session.
  const sourceId =
    input.sourceId ??
    (await resolveSourceForUrl(context.db, parsed.value, { createdBy: context.actor.id })).sourceId;
  // A website that was taken down stays down until an admin lifts the block.
  // (Captures are refused too, in `createScreenFromCapture`, so a session
  // already open when it was taken down cannot add to it.)
  await assertNotTakenDown(context, sourceId);

  const id = uuidv7();
  await context.db.insert(captureSessions).values({
    id,
    status: "pending",
    targetUrl: parsed.value.fetchUrl,
    deviceProfile: input.profile,
    deviceClass: profile.deviceClass,
    viewportWidth: profile.width,
    viewportHeight: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    sourceId,
    discoveredPageId: input.discoveredPageId ?? null,
    flowId: input.flowId ?? null,
    defaultTermIds: termIds,
    createdBy: context.actor.id,
    expiresAt: addMs(new Date(), STUDIO_LIMITS.maxSessionMs),
  });

  await recordAudit(context.db, context, {
    action: "capture_session.opened",
    entityType: "capture_session",
    entityId: id,
    entityLabel: parsed.value.normalized,
    context: { profile: input.profile, flowId: input.flowId ?? null },
  });

  return { sessionId: id, reusedExisting: false };
}

async function assertNotTakenDown(context: BaseContext, sourceId: string | null): Promise<void> {
  if (!sourceId) return;
  const [source] = await context.db
    .select({ name: sources.name, blockedAt: sources.crawlBlockedAt, reason: sources.crawlBlockedReason })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  if (source?.blockedAt) {
    throw new AppError(
      ErrorCode.CONFLICT,
      `${source.name} was taken down${source.reason ? ` (${source.reason})` : ""}. An admin can allow capturing again from its product page.`,
    );
  }
}

/**
 * Check tags chosen for a session: they must exist and be active, and the
 * person choosing them must be allowed to tag. Duplicates are dropped and the
 * list is capped, because the tags are copied onto every Screen captured.
 */
async function resolveSessionTerms(context: AdminContext, termIds: readonly string[]): Promise<string[]> {
  const unique = [...new Set(termIds)].slice(0, 24);
  if (unique.length === 0) return [];
  requirePermission(context.actor, "taxonomy.assign");

  const found = await context.db
    .select({ id: taxonomyTerms.id })
    .from(taxonomyTerms)
    .where(and(inArray(taxonomyTerms.id, unique), eq(taxonomyTerms.status, "active")));
  const active = new Set(found.map((row) => row.id));
  return unique.filter((id) => active.has(id));
}

/**
 * Change the tags new captures in this session start with. Screens already
 * captured keep their own tags; retagging one of those is done on the Screen.
 */
export async function setSessionTags(
  context: AdminContext,
  sessionId: string,
  termIds: readonly string[],
): Promise<string[]> {
  const resolved = await resolveSessionTerms(context, termIds);
  const updated = await context.db
    .update(captureSessions)
    .set({ defaultTermIds: resolved, updatedAt: new Date() })
    .where(eq(captureSessions.id, sessionId))
    .returning({ id: captureSessions.id });
  if (updated.length === 0) throw new AppError(ErrorCode.NOT_FOUND, "That capture session does not exist.");
  return resolved;
}

// --- Steering it ----------------------------------------------------------

/**
 * Queue one instruction for the live page.
 *
 * Sequence numbers come from a `max(seq) + 1` inside the same statement as the
 * insert, so two commands issued from two tabs at the same instant cannot
 * collide — the unique index on (session, seq) is what would catch it, and
 * computing the number in application code is what would trip it.
 */
export async function enqueueCommand(
  context: AdminContext,
  sessionId: string,
  payload: SessionCommandPayload,
): Promise<{ commandId: string; seq: number }> {
  const parsedPayload = sessionCommandPayloadSchema.parse(payload);

  const [session] = await context.db
    .select({ id: captureSessions.id, status: captureSessions.status })
    .from(captureSessions)
    .where(eq(captureSessions.id, sessionId))
    .limit(1);

  if (!session) throw new AppError(ErrorCode.NOT_FOUND, "That capture session does not exist.");
  if (!["pending", "starting", "live"].includes(session.status)) {
    throw new AppError(
      ErrorCode.CONFLICT,
      "That capture session has ended. Open a new one to keep capturing.",
    );
  }

  const id = uuidv7();
  const inserted = await context.db.execute<{ seq: number }>(sql`
    insert into ${captureSessionCommands} (id, session_id, seq, type, payload, created_by)
    select ${id}, ${sessionId},
           coalesce(max(c.seq), 0) + 1,
           ${parsedPayload.type},
           ${JSON.stringify(parsedPayload)}::jsonb,
           ${context.actor.id}
      from ${captureSessionCommands} c
     where c.session_id = ${sessionId}
    returning seq
  `);

  await context.db
    .update(captureSessions)
    .set({ commandCount: sql`${captureSessions.commandCount} + 1`, updatedAt: new Date() })
    .where(eq(captureSessions.id, sessionId));

  // The worker is parked in a long poll; this is what gets it moving now
  // rather than on its next check-in.
  notifyLiveCommand(sessionId);

  return { commandId: id, seq: inserted.rows[0]?.seq ?? 0 };
}

/**
 * Record that a person is watching.
 *
 * Drives the idle expiry: a session nobody has looked at for a while releases
 * its browser. The studio's live stream calls this while it is connected.
 */
export async function markViewerPresent(context: BaseContext, sessionId: string): Promise<void> {
  await context.db
    .update(captureSessions)
    .set({ viewerSeenAt: new Date() })
    .where(eq(captureSessions.id, sessionId));
}

export async function closeSession(
  context: AdminContext,
  sessionId: string,
): Promise<{ closed: boolean }> {
  // Ask the worker to shut the browser down cleanly first. If it never picks
  // the command up the reaper will expire the session anyway, so this is a
  // courtesy rather than the mechanism.
  await enqueueCommand(context, sessionId, { type: "close" }).catch(() => undefined);

  const now = new Date();
  const updated = await context.db
    .update(captureSessions)
    .set({ status: "closed", closedAt: now, leaseToken: null, frame: null, frameBytes: null, updatedAt: now })
    .where(
      and(eq(captureSessions.id, sessionId), sql`${captureSessions.status} in ('pending','starting','live')`),
    )
    .returning({ id: captureSessions.id });

  endLiveSession(sessionId);

  if (updated.length > 0) {
    await recordAudit(context.db, context, {
      action: "capture_session.closed",
      entityType: "capture_session",
      entityId: sessionId,
    });
  }

  return { closed: updated.length > 0 };
}

// --- The capture itself ---------------------------------------------------

/** What the worker reports when a `capture` command completes. */
export interface ScreenCaptureReport {
  readonly sessionId: string;
  readonly leaseToken: string;
  readonly commandId: string;
  readonly mediaId: string;
  readonly screenName: string;
  readonly description: string | null;
  readonly stateLabel: string | null;
  readonly url: string;
  readonly pageTitle: string | null;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly browserName: string | null;
  readonly browserVersion: string | null;
  readonly userAgent: string | null;
  readonly workerName: string;
  readonly signals: Record<string, unknown>;
}

export interface ScreenCaptureResult {
  readonly contentItemId: string;
  readonly slug: string;
  readonly captureId: string;
  readonly flowStepPosition: number | null;
}

/**
 * Turn a captured viewport into a Screen record (§4).
 *
 * Everything lands in one transaction: the content row, its detail row, the
 * capture provenance row, the media attachment, the candidate's counters and
 * the flow step. A half-written Screen — a content row with no media, or a
 * capture with no content — is the kind of thing that survives for months and
 * makes every count slightly wrong, so it is made unreachable rather than
 * cleaned up later.
 *
 * Classification runs *after* the transaction commits, deliberately: it may
 * call a model over the network, and holding a transaction open across a
 * network call is how a connection pool dies.
 */
export async function createScreenFromCapture(
  context: BaseContext & { readonly workerName?: string },
  report: ScreenCaptureReport,
): Promise<ScreenCaptureResult> {
  const [session] = await context.db
    .select({
      id: captureSessions.id,
      status: captureSessions.status,
      leaseToken: captureSessions.leaseToken,
      sourceId: captureSessions.sourceId,
      discoveredPageId: captureSessions.discoveredPageId,
      flowId: captureSessions.flowId,
      deviceProfile: captureSessions.deviceProfile,
      deviceClass: captureSessions.deviceClass,
      screensCaptured: captureSessions.screensCaptured,
      createdBy: captureSessions.createdBy,
      defaultTermIds: captureSessions.defaultTermIds,
    })
    .from(captureSessions)
    .where(eq(captureSessions.id, report.sessionId))
    .limit(1);

  if (!session) throw new AppError(ErrorCode.NOT_FOUND, "That capture session does not exist.");
  if (session.leaseToken !== report.leaseToken) {
    throw new AppError(ErrorCode.CONFLICT, "This session's lease is no longer valid.");
  }
  if (session.screensCaptured >= STUDIO_LIMITS.maxScreensPerSession) {
    throw new AppError(
      ErrorCode.LIMIT_EXCEEDED,
      `A single session may capture at most ${STUDIO_LIMITS.maxScreensPerSession} screens.`,
    );
  }

  const parsed = validateUrl(report.url);
  const normalizedUrl = parsed.ok ? parsed.value.normalized : report.url.slice(0, 2048);

  /**
   * Which product this Screen belongs to: the website it was taken on.
   *
   * A researcher in Notion's studio who follows a link to linear.app and
   * captures has captured Linear, and the Screen goes to Linear's profile —
   * found by its site, or created once. One website, one profile, whichever
   * session the capture came from. A flow is the exception: it is one
   * product's journey even when a step passes through someone else's page (a
   * Google sign-in), so its Screens stay with the flow's product.
   */
  let sourceId = session.sourceId;
  if (!session.flowId && parsed.ok) {
    const pageSite = registrableDomain(parsed.value.host);
    const [current] = sourceId
      ? await context.db
          .select({ site: sources.site, domain: sources.domain })
          .from(sources)
          .where(eq(sources.id, sourceId))
          .limit(1)
      : [];
    const currentSite = current?.site ?? (current?.domain ? registrableDomain(current.domain) : null);
    if (currentSite !== pageSite) {
      sourceId = (await resolveSourceForUrl(context.db, parsed.value, { createdBy: session.createdBy })).sourceId;
    }
  }
  await assertNotTakenDown(context, sourceId);

  /**
   * Which candidate this Screen came from.
   *
   * The session's own candidate when it started from one, and otherwise a
   * lookup by URL. The lookup matters: a researcher who opens the studio on a
   * URL directly — from a source page, or while walking a flow — produces
   * Screens whose candidate would otherwise sit in the triage queue marked
   * "new" forever, with the work already done. A queue that shows work still
   * to do when it has been done is a queue people stop trusting.
   */
  const discoveredPageId =
    session.discoveredPageId ??
    (parsed.ok
      ? ((
          await context.db
            .select({ id: discoveredPages.id })
            .from(discoveredPages)
            .where(eq(discoveredPages.normalizedUrlHash, parsed.value.hash))
            .limit(1)
        )[0]?.id ?? null)
      : null);

  // Everything below is operator-typed or page-derived. Sanitised on the way
  // in, so nothing downstream has to remember to.
  const screenName = sanitizeText(report.screenName, { maxLength: 200 }) ?? "Untitled screen";
  const stateLabel = sanitizeText(report.stateLabel, { maxLength: 120 });
  const description = sanitizeText(report.description, { maxLength: 2_000 });
  const pageTitle = sanitizeText(report.pageTitle, { maxLength: 300 });

  // The title carries the state, because a list of eight Screens all called
  // "Pricing" is a list a researcher cannot use.
  const title = stateLabel ? `${screenName} — ${stateLabel}` : screenName;

  const [source] = sourceId
    ? await context.db
        .select({ name: sources.name })
        .from(sources)
        .where(eq(sources.id, sourceId))
        .limit(1)
    : [];

  const slugBase = slugify([source?.name, title].filter(Boolean).join(" ")) || "screen";
  const taken = await existingScreenSlugs(context, slugBase);
  const slug = dedupeSlug(slugBase, taken);

  const contentItemId = uuidv7();
  const captureId = uuidv7();
  const now = new Date();

  const flowStepPosition = await inTransaction(context, async (tx) => {
    await tx.db.insert(contentItems).values({
      id: contentItemId,
      kind: "screen",
      // The mandatory review gate (§7). A Screen is never born approved.
      status: "needs_review",
      sourceId,
      title,
      slug,
      description,
      sourceUrl: normalizedUrl,
      originalCompany: source?.name ?? null,
      platform: "web",
      deviceClass: session.deviceClass,
      primaryMediaId: report.mediaId,
      capturedAt: now,
      // Set after the capture row exists. `content_items.latest_capture_id`
      // and `captures.content_item_id` point at each other, so whichever goes
      // in first has to go in without its half of the pair.
      latestCaptureId: null,
      createdBy: session.createdBy,
      updatedBy: session.createdBy,
    });

    await tx.db.insert(screenDetails).values({
      contentItemId,
      screenName,
      stateLabel,
      url: normalizedUrl,
      acquisition: "interactive_capture",
      deviceProfile: session.deviceProfile,
      viewportWidth: report.viewportWidth,
      viewportHeight: report.viewportHeight,
      deviceScaleFactor: report.deviceScaleFactor,
      captureSessionId: session.id,
      discoveredPageId,
    });

    await tx.db.insert(captures).values({
      id: captureId,
      sourceId,
      contentItemId,
      method: "browser_interaction",
      captureLevel: 3,
      status: "succeeded",
      requestedUrl: normalizedUrl,
      finalUrl: normalizedUrl,
      viewportWidth: report.viewportWidth,
      viewportHeight: report.viewportHeight,
      deviceScaleFactor: report.deviceScaleFactor,
      deviceProfile: session.deviceProfile,
      deviceClass: session.deviceClass,
      // Viewport only, always. A Screen is a state, and a 20,000-pixel-tall
      // strip of a whole page is not a state anyone can look at (§2).
      fullPage: false,
      browserName: report.browserName,
      browserVersion: report.browserVersion,
      userAgent: report.userAgent,
      workerName: report.workerName,
      pageTitle,
      pageWidth: report.imageWidth,
      pageHeight: report.imageHeight,
      startedAt: now,
      finishedAt: now,
    });

    await tx.db
      .update(contentItems)
      .set({ latestCaptureId: captureId })
      .where(eq(contentItems.id, contentItemId));

    await attachMedia(tx.db, {
      mediaId: report.mediaId,
      contentItemId,
      role: "screenshot_viewport",
      createdBy: session.createdBy,
    });

    await tx.db
      .update(captureSessions)
      .set({
        screensCaptured: sql`${captureSessions.screensCaptured} + 1`,
        updatedAt: now,
      })
      .where(eq(captureSessions.id, session.id));

    if (discoveredPageId) {
      // An ignored candidate stays ignored: a person decided that, and a
      // capture from the same URL is new information about the page, not a
      // reversal of their decision. `new` becomes `captured`, which is the
      // transition that keeps the triage queue honest.
      await tx.db
        .update(discoveredPages)
        .set({
          status: sql`case when ${discoveredPages.status} = 'new' then 'captured'::discovered_page_status else ${discoveredPages.status} end`,
          screenCount: sql`${discoveredPages.screenCount} + 1`,
          updatedAt: now,
        })
        .where(eq(discoveredPages.id, discoveredPageId));
    }

    // The tags chosen before capturing. A person chose them for exactly this,
    // so they land as human tags, accepted — not as suggestions to review.
    if (session.defaultTermIds.length > 0) {
      const terms = await tx.db
        .select({ id: taxonomyTerms.id, kind: taxonomyTerms.kind })
        .from(taxonomyTerms)
        .where(and(inArray(taxonomyTerms.id, session.defaultTermIds), eq(taxonomyTerms.status, "active")));
      if (terms.length > 0) {
        await tx.db
          .insert(taxonomyAssignments)
          .values(
            terms.map((term) => ({
              id: uuidv7(),
              termId: term.id,
              target: "content" as const,
              contentItemId,
              origin: "human_added" as const,
              reviewStatus: "accepted" as const,
              reviewedBy: session.createdBy,
              reviewedAt: now,
              isPrimary: TAXONOMY_KIND_META[term.kind as TaxonomyKind]?.singleValue ?? false,
              createdBy: session.createdBy,
            })),
          )
          .onConflictDoNothing();
        await recomputeTermUsage(tx.db, terms.map((term) => term.id));
      }
    }

    if (session.flowId) {
      return appendFlowStep(tx.db, {
        flowId: session.flowId,
        contentItemId,
        label: stateLabel ?? screenName,
      });
    }
    return null;
  });

  await recordAudit(context.db, context, {
    action: "screen.captured",
    entityType: "content",
    entityId: contentItemId,
    entityLabel: title,
    context: {
      sessionId: session.id,
      url: normalizedUrl,
      profile: session.deviceProfile,
      flowId: session.flowId,
    },
  });

  // Suggestions, outside the transaction. A failure here leaves a captured,
  // stored, reviewable Screen with no tags — which a person can still fix.
  await classifyAndQueueForReview(context, {
    contentItemId,
    jobId: null,
    autoClassify: true,
    // Already `needs_review` from birth; `sendToReview` would be a no-op
    // transition from a state it is already in.
    sendToReviewQueue: false,
    signals: report.signals,
    isUnchangedRecapture: false,
  }).catch((error) => {
    context.logger.warn("Could not classify a captured screen", { contentItemId, error });
  });

  return { contentItemId, slug, captureId, flowStepPosition };
}

/**
 * Edit a Screen's own fields (§7).
 *
 * Name, state and description — the three things a reviewer corrects most, and
 * the reason the review screen is not read-only. The state label is folded back
 * into the title, because the title is what every list shows and a screen whose
 * displayed name disagrees with its recorded state is a screen nobody can find.
 *
 * The slug deliberately does not move. It may already be published and linked
 * to, and renaming a record is not a reason to break a URL somebody saved.
 */
export async function updateScreen(
  context: AdminContext,
  contentItemId: string,
  input: { screenName?: string; stateLabel?: string | null; description?: string | null; notes?: string | null },
): Promise<void> {
  const [existing] = await context.db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      slug: contentItems.slug,
      firstPublishedAt: contentItems.firstPublishedAt,
      sourceName: sources.name,
      screenName: screenDetails.screenName,
      stateLabel: screenDetails.stateLabel,
    })
    .from(contentItems)
    .innerJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(eq(contentItems.id, contentItemId), eq(contentItems.kind, "screen")))
    .limit(1);

  if (!existing) throw new AppError(ErrorCode.NOT_FOUND, "That screen does not exist.");

  const screenName =
    input.screenName !== undefined
      ? (sanitizeText(input.screenName, { maxLength: 200 }) ?? existing.screenName)
      : existing.screenName;
  const stateLabel =
    input.stateLabel !== undefined
      ? sanitizeText(input.stateLabel, { maxLength: 120 })
      : existing.stateLabel;

  const title = stateLabel ? `${screenName ?? "Untitled screen"} — ${stateLabel}` : (screenName ?? "Untitled screen");

  // The public address follows the name until the screen has been public.
  // After that it stays put: someone may have shared or bookmarked it, and a
  // rename must not break their link.
  let slug: string | undefined;
  if (existing.firstPublishedAt === null && title !== existing.title) {
    const base = slugify([existing.sourceName, title].filter(Boolean).join(" ")) || "screen";
    const taken = await existingScreenSlugs(context, base);
    // Its own current address is not a clash.
    if (existing.slug) taken.delete(existing.slug);
    slug = dedupeSlug(base, taken);
  }

  await inTransaction(context, async (tx) => {
    await tx.db
      .update(contentItems)
      .set({
        title,
        ...(slug ? { slug } : {}),
        ...(input.description !== undefined
          ? { description: sanitizeText(input.description, { maxLength: 2_000 }) }
          : {}),
        ...(input.notes !== undefined
          ? { notes: sanitizeText(input.notes, { maxLength: 4_000 }) }
          : {}),
        updatedBy: context.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, contentItemId));

    await tx.db
      .update(screenDetails)
      .set({ screenName, stateLabel })
      .where(eq(screenDetails.contentItemId, contentItemId));
  });

  await recordAudit(context.db, context, {
    action: "content.updated",
    entityType: "content",
    entityId: contentItemId,
    entityLabel: title,
    context: { fields: Object.keys(input) },
  });
}

async function existingScreenSlugs(context: BaseContext, base: string): Promise<Set<string>> {
  const rows = await context.db
    .select({ slug: contentItems.slug })
    .from(contentItems)
    .where(and(eq(contentItems.kind, "screen"), sql`${contentItems.slug} like ${base + "%"}`));
  return new Set(rows.map((r) => r.slug).filter((s): s is string => s !== null));
}

/**
 * Screens captured in one session, newest first.
 *
 * The studio's filmstrip. Ordered by capture time rather than by flow position
 * because a session may not be capturing into a flow at all, and when it is,
 * the two orders agree anyway.
 */
export async function sessionScreens(context: BaseContext, sessionId: string) {
  return context.db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      slug: contentItems.slug,
      status: contentItems.status,
      capturedAt: contentItems.capturedAt,
      mediaId: contentItems.primaryMediaId,
      screenName: screenDetails.screenName,
      stateLabel: screenDetails.stateLabel,
      sourceId: contentItems.sourceId,
      sourceName: sources.name,
      thumbnailKey: sql<string | null>`(
        select ${mediaDerivatives.storageKey} from ${mediaDerivatives}
        where ${mediaDerivatives.mediaId} = ${contentItems}.primary_media_id
          and ${mediaDerivatives.kind} = 'thumbnail'
        limit 1
      )`,
    })
    .from(screenDetails)
    .innerJoin(contentItems, eq(contentItems.id, screenDetails.contentItemId))
    .leftJoin(sources, eq(sources.id, contentItems.sourceId))
    .where(and(eq(screenDetails.captureSessionId, sessionId), sql`${contentItems.deletedAt} is null`))
    .orderBy(desc(contentItems.capturedAt));
}

/**
 * The tags a person put on each of these Screens — not the machine's pending
 * suggestions, which belong to review. For the studio's capture tray.
 */
export async function screenTags(context: BaseContext, contentItemIds: readonly string[]) {
  if (contentItemIds.length === 0) return [];
  return context.db
    .select({
      assignmentId: taxonomyAssignments.id,
      contentItemId: taxonomyAssignments.contentItemId,
      termId: taxonomyTerms.id,
      name: taxonomyTerms.name,
      kind: taxonomyTerms.kind,
    })
    .from(taxonomyAssignments)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
    .where(
      and(
        inArray(taxonomyAssignments.contentItemId, [...contentItemIds]),
        eq(taxonomyAssignments.reviewStatus, "accepted"),
        isNull(taxonomyTerms.archivedAt),
      ),
    )
    .orderBy(taxonomyTerms.kind, taxonomyTerms.name);
}

/** Flows this session could be capturing into, for the studio's picker. */
export async function openFlowsForSource(context: BaseContext, sourceId: string | null) {
  return context.db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      stepCount: flowDetails.stepCount,
      status: contentItems.status,
    })
    .from(contentItems)
    .innerJoin(flowDetails, eq(flowDetails.contentItemId, contentItems.id))
    .where(
      and(
        eq(contentItems.kind, "flow"),
        sql`${contentItems.deletedAt} is null`,
        sql`${contentItems.status} in ('draft','needs_review')`,
        sourceId ? eq(contentItems.sourceId, sourceId) : sql`true`,
      ),
    )
    .orderBy(desc(contentItems.updatedAt))
    .limit(25);
}

/** Steps already in a flow, so the studio can show where the next one lands. */
export async function flowStepSummary(context: BaseContext, flowId: string) {
  return context.db
    .select({
      position: flowSteps.position,
      label: flowSteps.label,
      contentItemId: flowSteps.contentItemId,
      title: contentItems.title,
      mediaId: contentItems.primaryMediaId,
    })
    .from(flowSteps)
    .innerJoin(contentItems, eq(contentItems.id, flowSteps.contentItemId))
    .where(eq(flowSteps.flowId, flowId))
    .orderBy(flowSteps.position);
}
