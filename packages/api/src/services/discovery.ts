/**
 * Discovery intake and triage (§1, §12, §13).
 *
 * This module is what a crawl is allowed to produce. It records that a URL
 * exists and what cheap metadata came back with it, and it stops there. There
 * is no path from here to `content_items` — creating a Screen goes through the
 * capture studio, driven by a person, and that is the whole point of the
 * separation.
 *
 * Everything written here came off an attacker-controlled page, so every text
 * field is sanitised and length-capped on the way in, and nothing is ever
 * interpolated into SQL, a shell, HTML or a model prompt without passing
 * through that same boundary (§25).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type Db,
  appendJobEvent,
  contentItems,
  discoveredPages,
  screenDetails,
  sources,
} from "@uxd/database";
import { AppError, ErrorCode, sanitizeText, uuidv7, validateUrl } from "@uxd/shared";
import { type IgnoreReason, IGNORE_REASONS } from "@uxd/types";
import { recordAudit } from "../audit.js";
import type { AdminContext, BaseContext } from "../context.js";
import { resolveSourceForUrl } from "./ingestion.js";

/** What a worker reports about one crawled URL. */
export interface DiscoveryReport {
  readonly jobId: string | null;
  readonly jobItemId: string | null;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly httpStatus: number | null;
  readonly pageTitle: string | null;
  readonly pageDescription: string | null;
  readonly ogTitle: string | null;
  readonly ogType: string | null;
  readonly langAttr: string | null;
  readonly h1: string | null;
  readonly wordCount: number | null;
  readonly depth: number;
  readonly discoveredFromUrl: string | null;
  /** Media id of the optional triage thumbnail. */
  readonly previewMediaId: string | null;
  readonly module?: string;
}

export interface DiscoveryIntakeResult {
  readonly discoveredPageId: string;
  readonly sourceId: string | null;
  /** False when this URL was already a candidate and we refreshed it. */
  readonly created: boolean;
  /** True when a person had already triaged it, so we left their decision alone. */
  readonly alreadyTriaged: boolean;
}

/**
 * Record (or refresh) one discovered URL.
 *
 * Upsert on the normalised hash, globally rather than per job. Crawling
 * linear.app in January and again in March should leave one candidate whose
 * details are current, not two rows a researcher has to notice are the same
 * page. `seen_count` carries the fact that we found it more than once, which
 * is a weak but real signal that a page is a stable part of the site rather
 * than a transient URL.
 *
 * A candidate a person has already triaged keeps its status. Re-crawling must
 * never resurrect something a researcher deliberately ignored — that would
 * make the ignore button useless on exactly the sites we crawl most often.
 */
export async function recordDiscoveredPage(
  context: BaseContext,
  report: DiscoveryReport,
): Promise<DiscoveryIntakeResult> {
  const parsed = validateUrl(report.finalUrl || report.requestedUrl);
  if (!parsed.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `Not a usable URL: ${parsed.error.message}`);
  }
  const url = parsed.value;

  const source = await resolveSourceForUrl(context.db, url, { module: report.module });

  // Sanitise everything that came off the page. `sanitizeText` strips control
  // characters and collapses whitespace; the caps are what stop a hostile page
  // from writing a megabyte of title into the triage list.
  const title = sanitizeText(report.pageTitle, { maxLength: 300 });
  const description = sanitizeText(report.pageDescription, { maxLength: 600 });
  const ogTitle = sanitizeText(report.ogTitle, { maxLength: 300 });
  const ogType = sanitizeText(report.ogType, { maxLength: 60 });
  const h1 = sanitizeText(report.h1, { maxLength: 300 });
  const langAttr = sanitizeText(report.langAttr, { maxLength: 20 });

  const now = new Date();
  const id = uuidv7();

  const [row] = await context.db
    .insert(discoveredPages)
    .values({
      id,
      status: "new",
      sourceId: source.sourceId,
      jobId: report.jobId,
      jobItemId: report.jobItemId,
      url: url.fetchUrl,
      normalizedUrl: url.normalized,
      normalizedUrlHash: url.hash,
      finalUrl: report.finalUrl,
      host: url.host,
      path: url.path + (url.search || ""),
      httpStatus: report.httpStatus,
      title,
      description,
      ogTitle,
      ogType,
      h1,
      langAttr,
      wordCount: report.wordCount,
      previewMediaId: report.previewMediaId,
      depth: report.depth,
      discoveredFromUrl: report.discoveredFromUrl,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    })
    .onConflictDoUpdate({
      target: discoveredPages.normalizedUrlHash,
      set: {
        // Metadata is refreshed — a page that changed its title should show the
        // new one. Status, triage fields and `first_seen_at` are deliberately
        // absent: those belong to the person who triaged it.
        jobId: report.jobId,
        jobItemId: report.jobItemId,
        finalUrl: report.finalUrl,
        httpStatus: report.httpStatus,
        title,
        description,
        ogTitle,
        ogType,
        h1,
        langAttr,
        wordCount: report.wordCount,
        // Only overwrite a preview when this crawl actually took one, so a
        // metadata-only re-crawl does not blank the thumbnail.
        previewMediaId: sql`coalesce(${report.previewMediaId ?? null}, ${discoveredPages.previewMediaId})`,
        lastSeenAt: now,
        seenCount: sql`${discoveredPages.seenCount} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      id: discoveredPages.id,
      status: discoveredPages.status,
      seenCount: discoveredPages.seenCount,
    });

  if (!row) {
    throw new AppError(ErrorCode.INTERNAL, "The discovered page could not be recorded.");
  }

  const created = row.id === id;

  if (report.jobId) {
    await appendJobEvent(context.db, {
      jobId: report.jobId,
      itemId: report.jobItemId,
      level: "info",
      code: created ? "page_discovered" : "page_rediscovered",
      data: { url: url.normalized, discoveredPageId: row.id, seenCount: row.seenCount },
      actor: "worker",
    });
  }

  return {
    discoveredPageId: row.id,
    sourceId: source.sourceId,
    created,
    alreadyTriaged: !created && row.status !== "new",
  };
}

// --- Triage ---------------------------------------------------------------

export interface TriageResult {
  readonly updated: number;
  readonly skipped: readonly { id: string; reason: string }[];
}

/**
 * Set candidates aside.
 *
 * Bulk by default, because triage is a bulk activity: a crawl of a docs site
 * returns 180 pages of API reference and a researcher wants them all gone in
 * one gesture, not 180 confirmations.
 *
 * A candidate that already produced a Screen is refused rather than ignored —
 * "ignored" would then be untrue of a page we demonstrably found worth
 * capturing, and the counts built on that status would quietly stop meaning
 * what they say.
 */
export async function ignoreDiscoveredPages(
  context: AdminContext,
  ids: readonly string[],
  options: { reason: IgnoreReason; note?: string },
): Promise<TriageResult> {
  if (ids.length === 0) return { updated: 0, skipped: [] };
  if (!(IGNORE_REASONS as readonly string[]).includes(options.reason)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "That is not a known reason for ignoring a page.");
  }

  const rows = await context.db
    .select({
      id: discoveredPages.id,
      status: discoveredPages.status,
      screenCount: discoveredPages.screenCount,
      url: discoveredPages.url,
    })
    .from(discoveredPages)
    .where(inArray(discoveredPages.id, [...ids]));

  const skipped: { id: string; reason: string }[] = [];
  const eligible: string[] = [];
  for (const row of rows) {
    if (row.screenCount > 0) {
      skipped.push({ id: row.id, reason: "Screens have already been captured from this page." });
      continue;
    }
    eligible.push(row.id);
  }

  if (eligible.length === 0) return { updated: 0, skipped };

  const now = new Date();
  await context.db
    .update(discoveredPages)
    .set({
      status: "ignored",
      ignoreReason: options.reason,
      ignoreNote: sanitizeText(options.note ?? null, { maxLength: 500 }),
      triagedBy: context.actor.id,
      triagedAt: now,
      updatedAt: now,
    })
    .where(inArray(discoveredPages.id, eligible));

  await recordAudit(context.db, context, {
    action: "discovered_page.ignored",
    entityType: "discovered_page",
    entityId: eligible[0] ?? null,
    context: { count: eligible.length, reason: options.reason, ids: eligible.slice(0, 50) },
  });

  return { updated: eligible.length, skipped };
}

/** Put ignored candidates back in the queue. */
export async function restoreDiscoveredPages(
  context: AdminContext,
  ids: readonly string[],
): Promise<TriageResult> {
  if (ids.length === 0) return { updated: 0, skipped: [] };

  const now = new Date();
  const restored = await context.db
    .update(discoveredPages)
    .set({
      status: "new",
      ignoreReason: null,
      ignoreNote: null,
      triagedBy: context.actor.id,
      triagedAt: now,
      updatedAt: now,
    })
    .where(and(inArray(discoveredPages.id, [...ids]), eq(discoveredPages.status, "ignored")))
    .returning({ id: discoveredPages.id });

  if (restored.length > 0) {
    await recordAudit(context.db, context, {
      action: "discovered_page.restored",
      entityType: "discovered_page",
      entityId: restored[0]?.id ?? null,
      context: { count: restored.length },
    });
  }

  return { updated: restored.length, skipped: [] };
}

/**
 * Add a URL to the queue by hand.
 *
 * The escape hatch for "I know the page I want and I do not need a crawl to
 * find it for me" — which is most of the time, once a researcher knows a
 * product. Goes through the same validation and the same source resolution as
 * a crawled URL, so a hand-added candidate is indistinguishable downstream.
 */
export async function addDiscoveredPageByHand(
  context: AdminContext,
  input: { url: string; sourceId?: string | null },
): Promise<DiscoveryIntakeResult> {
  const parsed = validateUrl(input.url);
  if (!parsed.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
  }

  const result = await recordDiscoveredPage(context, {
    jobId: null,
    jobItemId: null,
    requestedUrl: parsed.value.fetchUrl,
    finalUrl: parsed.value.fetchUrl,
    httpStatus: null,
    pageTitle: null,
    pageDescription: null,
    ogTitle: null,
    ogType: null,
    langAttr: null,
    h1: null,
    wordCount: null,
    depth: 0,
    discoveredFromUrl: null,
    previewMediaId: null,
  });

  // An explicit source overrides host resolution: a researcher adding
  // help.stripe.com to the Stripe source knows better than the domain match.
  if (input.sourceId && input.sourceId !== result.sourceId) {
    await context.db
      .update(discoveredPages)
      .set({ sourceId: input.sourceId, updatedAt: new Date() })
      .where(eq(discoveredPages.id, result.discoveredPageId));
  }

  await recordAudit(context.db, context, {
    action: "discovered_page.added",
    entityType: "discovered_page",
    entityId: result.discoveredPageId,
    context: { url: parsed.value.normalized, byHand: true },
  });

  return result;
}

/**
 * Recount `screen_count` from the Screens that actually exist.
 *
 * The counter is maintained incrementally on capture, which is right for the
 * common path and wrong the moment a Screen is deleted. This is the
 * reconciliation, called after a deletion and available to an operator when a
 * number looks wrong.
 */
export async function recomputeScreenCounts(db: Db, discoveredPageIds?: readonly string[]): Promise<void> {
  const scope =
    discoveredPageIds && discoveredPageIds.length > 0
      ? sql`where dp.id in (${sql.join(
          discoveredPageIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;

  await db.execute(sql`
    update ${discoveredPages} dp
       set screen_count = (
             select count(*)::int
               from ${screenDetails} sd
               join ${contentItems} ci on ci.id = sd.content_item_id
              where sd.discovered_page_id = dp.id
                and ci.deleted_at is null),
           updated_at = now()
     ${scope}
  `);

  // A candidate whose last Screen was deleted goes back to being untriaged,
  // rather than sitting at "captured" with nothing to show for it.
  await db
    .update(discoveredPages)
    .set({ status: "new", updatedAt: new Date() })
    .where(and(eq(discoveredPages.status, "captured"), eq(discoveredPages.screenCount, 0)));
}

/** Source-level discovery counts for the source detail page (§14). */
export async function discoveryCountsForSource(
  db: Db,
  sourceId: string,
): Promise<{ total: number; untriaged: number; captured: number; ignored: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      untriaged: sql<number>`count(*) filter (where ${discoveredPages.status} = 'new')::int`,
      captured: sql<number>`count(*) filter (where ${discoveredPages.status} = 'captured')::int`,
      ignored: sql<number>`count(*) filter (where ${discoveredPages.status} = 'ignored')::int`,
    })
    .from(discoveredPages)
    .where(eq(discoveredPages.sourceId, sourceId));

  return row ?? { total: 0, untriaged: 0, captured: 0, ignored: 0 };
}

/** Sources that have untriaged candidates, for the discovery landing page. */
export async function sourcesWithUntriagedPages(db: Db, limit = 50) {
  return db
    .select({
      sourceId: sources.id,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      domain: sources.domain,
      untriaged: sql<number>`count(*) filter (where ${discoveredPages.status} = 'new')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(discoveredPages)
    .innerJoin(sources, eq(sources.id, discoveredPages.sourceId))
    .where(isNull(sources.deletedAt))
    .groupBy(sources.id, sources.name, sources.slug, sources.domain)
    .having(sql`count(*) filter (where ${discoveredPages.status} = 'new') > 0`)
    .orderBy(sql`count(*) filter (where ${discoveredPages.status} = 'new') desc`)
    .limit(limit);
}
