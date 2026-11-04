/**
 * Products: the creation side of the CMS.
 *
 * Adding a product, correcting its name, taking it off the list, and throwing
 * away a capture that did not come out right. Nothing here can make anything
 * public — publishing lives with review, behind its own permission, so a role
 * with creation access only can do all of this and still never publish.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { can, requirePermission } from "@uxd/auth";
import {
  captureSessions,
  captures,
  classificationSuggestions,
  contentItems,
  crawlJobs,
  discoveredPages,
  mediaAssets,
  screenDetails,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
  urlRegistry,
} from "@uxd/database";
import { AppError, ErrorCode, notFound, registrableDomain, sanitizeText, uuidv7, validateUrl } from "@uxd/shared";
import { recordAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";
import { recomputeScreenCounts } from "./discovery.js";
import { resolveSourceForUrl } from "./ingestion.js";
import { recomputeTermUsage } from "./classification-review.js";

export interface AddProductResult {
  readonly sourceId: string;
  readonly name: string;
  /** False when the address belonged to a product we already had. */
  readonly created: boolean;
}

/**
 * Add a product from a website address.
 *
 * Everything else — its name, its slug, which domain it answers to — is
 * derived, and can be corrected later. Goes through the same URL policy and
 * the same find-or-create as capture intake, so `www.` and the bare domain
 * resolve to one product rather than two.
 */
export async function addProduct(context: AdminContext, url: string): Promise<AddProductResult> {
  requirePermission(context.actor, "source.create");

  const parsed = validateUrl(url.trim(), { assumeHttps: true });
  if (!parsed.ok) throw new AppError(ErrorCode.VALIDATION_FAILED, parsed.error.message);

  return inTransaction(context, async (tx) => {
    const resolved = await resolveSourceForUrl(tx.db, parsed.value, { createdBy: context.actor.id });
    const [row] = await tx.db
      .select({ name: sources.name, status: sources.status })
      .from(sources)
      .where(eq(sources.id, resolved.sourceId))
      .limit(1);
    if (!row) throw new AppError(ErrorCode.INTERNAL, "The product could not be saved.");

    if (resolved.created) {
      await recordAudit(tx.db, context, {
        action: "source.created",
        entityType: "source",
        entityId: resolved.sourceId,
        entityLabel: row.name,
        context: { url: parsed.value.normalized },
      });
    } else if (row.status === "archived") {
      // An archived product is off the list, not gone: adding it again lists it.
      await tx.db
        .update(sources)
        .set({ status: "draft", updatedBy: context.actor.id, updatedAt: new Date() })
        .where(eq(sources.id, resolved.sourceId));
      await recordAudit(tx.db, context, {
        action: "source.updated",
        entityType: "source",
        entityId: resolved.sourceId,
        entityLabel: row.name,
        before: { status: "archived" },
        after: { status: "draft" },
      });
    } else {
      // Already listed. Touch it, so it moves to the top where the researcher
      // is looking, rather than appearing to have done nothing.
      await tx.db.update(sources).set({ updatedAt: new Date() }).where(eq(sources.id, resolved.sourceId));
    }

    return { sourceId: resolved.sourceId, name: row.name, created: resolved.created };
  });
}

/** Correct a product's name — "Soundcloud" to "SoundCloud". */
export async function renameProduct(context: AdminContext, sourceId: string, name: string): Promise<void> {
  requirePermission(context.actor, "source.update");
  const next = sanitizeText(name, { maxLength: 120, singleLine: true });
  if (!next) throw new AppError(ErrorCode.VALIDATION_FAILED, "A product needs a name.");

  await inTransaction(context, async (tx) => {
    const [row] = await tx.db
      .select({ name: sources.name })
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Product");
    if (row.name === next) return;

    await tx.db
      .update(sources)
      .set({ name: next, updatedBy: context.actor.id, updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
    await recordAudit(tx.db, context, {
      action: "source.updated",
      entityType: "source",
      entityId: sourceId,
      entityLabel: next,
      before: { name: row.name },
      after: { name: next },
    });
  });
}

/**
 * Take a product off the Products list. Archives it: everything captured from
 * it is kept, published screens stay published, and adding its address again
 * lists it.
 */
export async function removeProduct(context: AdminContext, sourceId: string): Promise<void> {
  requirePermission(context.actor, "source.update");

  await inTransaction(context, async (tx) => {
    const [row] = await tx.db
      .select({ name: sources.name, status: sources.status })
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Product");
    if (row.status === "archived") return;

    await tx.db
      .update(sources)
      .set({ status: "archived", updatedBy: context.actor.id, updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
    await recordAudit(tx.db, context, {
      action: "source.updated",
      entityType: "source",
      entityId: sourceId,
      entityLabel: row.name,
      before: { status: row.status },
      after: { status: "archived" },
    });
  });
}

/** Whether this actor may throw a capture away. Shared by the check and the UI. */
export function canDiscardScreen(
  actor: AdminContext["actor"],
  screen: { readonly createdBy: string | null; readonly status: string; readonly everPublished: boolean },
): boolean {
  if (screen.status === "published" || screen.everPublished) return false;
  if (can(actor, "content.delete")) return true;
  return can(actor, "content.discard_own") && screen.createdBy === actor.id;
}

/**
 * Throw away a capture that did not come out right.
 *
 * Only before it has ever been public: a screen that was published may be
 * linked or cached on the public site, so taking it down is an unpublish — a
 * review decision — not a discard. Without `content.delete`, only your own
 * captures. A soft delete, so the audit trail and the media survive it.
 */
export async function discardScreen(context: AdminContext, contentId: string): Promise<void> {
  await inTransaction(context, async (tx) => {
    const [row] = await tx.db
      .select({
        id: contentItems.id,
        kind: contentItems.kind,
        title: contentItems.title,
        status: contentItems.status,
        createdBy: contentItems.createdBy,
        firstPublishedAt: contentItems.firstPublishedAt,
        discoveredPageId: screenDetails.discoveredPageId,
      })
      .from(contentItems)
      .leftJoin(screenDetails, eq(screenDetails.contentItemId, contentItems.id))
      .where(and(eq(contentItems.id, contentId), isNull(contentItems.deletedAt)))
      .limit(1);
    if (!row || row.kind !== "screen") throw notFound("Screen");

    const screen = { createdBy: row.createdBy, status: row.status, everPublished: row.firstPublishedAt !== null };
    if (screen.status === "published" || screen.everPublished) {
      throw new AppError(
        ErrorCode.CONFLICT,
        "This screen has been public, so it cannot be discarded. Unpublish it from the Inbox instead.",
      );
    }
    if (!canDiscardScreen(context.actor, screen)) {
      throw new AppError(ErrorCode.FORBIDDEN, "You can only discard captures you made yourself.");
    }

    await tx.db
      .update(contentItems)
      .set({ deletedAt: new Date(), updatedBy: context.actor.id, updatedAt: new Date() })
      .where(eq(contentItems.id, contentId));
    await recordAudit(tx.db, context, {
      action: "content.deleted",
      entityType: "content",
      entityId: contentId,
      entityLabel: row.title,
      before: { status: row.status },
      after: { deleted: true },
      context: { discarded: true },
    });
    if (row.discoveredPageId) await recomputeScreenCounts(tx.db, [row.discoveredPageId]);
  });
}

// --- The website profile --------------------------------------------------

/** The industry a website is filed under, or null. */
export async function getWebsiteIndustry(context: AdminContext, sourceId: string): Promise<string | null> {
  const [row] = await context.db
    .select({ termId: taxonomyAssignments.termId })
    .from(taxonomyAssignments)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, taxonomyAssignments.termId))
    .where(
      and(
        eq(taxonomyAssignments.sourceId, sourceId),
        eq(taxonomyTerms.kind, "industry"),
        eq(taxonomyAssignments.reviewStatus, "accepted"),
      ),
    )
    .limit(1);
  return row?.termId ?? null;
}

/**
 * File a website under one industry — or none.
 *
 * Industry describes the company, not a screenshot, so it lives on the
 * website: every screen from it is found under that industry on the public
 * site without anyone tagging each screen. One per website, which is what a
 * dropdown means; choosing another replaces it.
 */
export async function setWebsiteIndustry(
  context: AdminContext,
  sourceId: string,
  termId: string | null,
): Promise<void> {
  requirePermission(context.actor, "taxonomy.assign");

  await inTransaction(context, async (tx) => {
    const [source] = await tx.db
      .select({ id: sources.id, name: sources.name })
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .limit(1);
    if (!source) throw notFound("Product");

    if (termId) {
      const [term] = await tx.db
        .select({ kind: taxonomyTerms.kind, status: taxonomyTerms.status })
        .from(taxonomyTerms)
        .where(eq(taxonomyTerms.id, termId))
        .limit(1);
      if (!term || term.kind !== "industry" || term.status !== "active") {
        throw new AppError(ErrorCode.VALIDATION_FAILED, "Choose one of the industries on the Tags page.");
      }
    }

    const previous = await tx.db
      .delete(taxonomyAssignments)
      .where(
        and(
          eq(taxonomyAssignments.sourceId, sourceId),
          sql`${taxonomyAssignments.termId} in (select id from ${taxonomyTerms} where kind = 'industry')`,
        ),
      )
      .returning({ termId: taxonomyAssignments.termId });

    if (termId) {
      await tx.db.insert(taxonomyAssignments).values({
        id: uuidv7(),
        termId,
        target: "source",
        sourceId,
        origin: "human_added",
        reviewStatus: "accepted",
        reviewedBy: context.actor.id,
        reviewedAt: new Date(),
        isPrimary: true,
        createdBy: context.actor.id,
      });
    }

    await recomputeTermUsage(tx.db, [...previous.map((row) => row.termId), ...(termId ? [termId] : [])]);
    await recordAudit(tx.db, context, {
      action: termId ? "taxonomy.assigned" : "taxonomy.unassigned",
      entityType: "source",
      entityId: sourceId,
      entityLabel: source.name,
      before: { industry: previous[0]?.termId ?? null },
      after: { industry: termId },
    });
  });
}

// --- Taking a website down -------------------------------------------------

/**
 * Take a whole website off the public site, in one step — for when a company
 * asks to be removed.
 *
 * Everything from it that is live goes back to Drafts (nothing is deleted:
 * the captures, their tags and their history stay), its featured section is
 * emptied, and the website is blocked from being captured again until an
 * admin lifts the block. The reason is kept on the product and in the audit
 * log.
 */
export async function takeDownWebsite(
  context: AdminContext,
  sourceId: string,
  reason: string,
): Promise<{ unpublished: number }> {
  requirePermission(context.actor, "content.unpublish");
  const why = sanitizeText(reason, { maxLength: 500, singleLine: true });
  if (!why) throw new AppError(ErrorCode.VALIDATION_FAILED, "Say why, for the record.");

  return inTransaction(context, async (tx) => {
    const [source] = await tx.db
      .select({ id: sources.id, name: sources.name })
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .limit(1);
    if (!source) throw notFound("Product");

    const now = new Date();
    const note = `Taken down ${now.toISOString()} by ${context.actor.name}: ${why}`;
    const unpublished = await tx.db
      .update(contentItems)
      .set({
        status: "approved",
        publishedAt: null,
        unpublishedAt: now,
        featuredAt: null,
        internalNotes: sql`coalesce(${contentItems.internalNotes} || E'\n\n', '') || ${note}`,
        updatedBy: context.actor.id,
        updatedAt: now,
      })
      .where(
        and(eq(contentItems.sourceId, sourceId), eq(contentItems.status, "published"), isNull(contentItems.deletedAt)),
      )
      .returning({ id: contentItems.id });

    await tx.db
      .update(sources)
      .set({
        takedownStatus: "actioned",
        crawlBlockedAt: now,
        crawlBlockedReason: why,
        updatedBy: context.actor.id,
        updatedAt: now,
      })
      .where(eq(sources.id, sourceId));

    await recordAudit(tx.db, context, {
      action: "source.taken_down",
      entityType: "source",
      entityId: sourceId,
      entityLabel: source.name,
      context: { reason: why, unpublished: unpublished.length },
    });
    return { unpublished: unpublished.length };
  });
}

/**
 * Lift a takedown's block, so the website can be captured again. Nothing is
 * republished: what was live is in Drafts, to be published again one by one.
 */
export async function restoreWebsite(context: AdminContext, sourceId: string): Promise<void> {
  requirePermission(context.actor, "content.unpublish");
  await inTransaction(context, async (tx) => {
    const [source] = await tx.db
      .update(sources)
      .set({
        takedownStatus: "none",
        crawlBlockedAt: null,
        crawlBlockedReason: null,
        updatedBy: context.actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .returning({ name: sources.name });
    if (!source) throw notFound("Product");
    await recordAudit(tx.db, context, {
      action: "source.restored",
      entityType: "source",
      entityId: sourceId,
      entityLabel: source.name,
    });
  });
}

// --- Adding many at once ---------------------------------------------------

export const BULK_ADD_LIMIT = 200;

export type BulkLineStatus = "new" | "exists" | "archived" | "repeat" | "invalid";

export interface BulkLine {
  /** What was pasted, trimmed. */
  readonly input: string;
  readonly status: BulkLineStatus;
  /** The website this line resolves to: `notion.com`. */
  readonly site: string | null;
  /** The address that will be added, normalised. */
  readonly url: string | null;
  /** The product it matches, when it already exists. */
  readonly existing: { readonly id: string; readonly name: string } | null;
  readonly reason: string | null;
}

/**
 * Check a pasted list before anything is added.
 *
 * Each line is read as an address, resolved to its website, and compared with
 * the products we have — so "notion.so" and "www.notion.com" and a second
 * "linear.app" further down the list are all caught here, where the person can
 * see them, rather than surfacing as duplicates later. Blank lines and lines
 * starting with # are skipped, so a list with headings pastes as it is.
 */
export async function previewProducts(context: AdminContext, raw: string): Promise<BulkLine[]> {
  requirePermission(context.actor, "source.create");

  const inputs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (inputs.length > BULK_ADD_LIMIT) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `That's ${inputs.length} lines. Add up to ${BULK_ADD_LIMIT} at a time.`,
    );
  }

  const parsed = inputs.map((input) => {
    const address = addressIn(input);
    if (!address) return { input, site: null, url: null, reason: "No website address on this line." };
    const result = validateUrl(address, { assumeHttps: true });
    return result.ok
      ? { input, site: registrableDomain(result.value.host), url: result.value.normalized, reason: null }
      : { input, site: null, url: null, reason: result.error.message };
  });

  const sites = [...new Set(parsed.map((line) => line.site).filter((site): site is string => site !== null))];
  const known = sites.length
    ? await context.db
        .select({ id: sources.id, name: sources.name, site: sources.site, status: sources.status })
        .from(sources)
        .where(and(inArray(sources.site, sites), isNull(sources.deletedAt)))
    : [];
  const bySite = new Map(known.map((row) => [row.site, row]));

  const seen = new Set<string>();
  return parsed.map((line): BulkLine => {
    if (!line.site) return { ...line, status: "invalid", existing: null };
    if (seen.has(line.site)) {
      return { ...line, status: "repeat", existing: null, reason: `${line.site} is already higher up the list.` };
    }
    seen.add(line.site);
    const match = bySite.get(line.site);
    if (!match) return { ...line, status: "new", existing: null };
    return {
      ...line,
      status: match.status === "archived" ? "archived" : "exists",
      existing: { id: match.id, name: match.name },
    };
  });
}

/**
 * The address on a pasted line, wherever it sits: a bare "linear.app", a full
 * URL, or one cell of a spreadsheet row ("12,Lovable,https://lovable.dev,AI").
 * A full URL wins; otherwise the first word that looks like a domain.
 */
function addressIn(line: string): string | null {
  const url = /https?:\/\/[^\s,;"'<>]+/i.exec(line);
  if (url) return url[0];
  const domain = line
    .split(/[\s,;|\t"']+/)
    .find((word) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(word));
  return domain ?? null;
}

/**
 * Add the addresses a person kept from the preview. Each is added on its own,
 * so one bad line cannot stop the other ninety-nine.
 */
export async function addProducts(
  context: AdminContext,
  urls: readonly string[],
): Promise<
  { url: string; ok: boolean; sourceId: string | null; name: string | null; created: boolean; error: string | null }[]
> {
  requirePermission(context.actor, "source.create");
  if (urls.length > BULK_ADD_LIMIT) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `Add up to ${BULK_ADD_LIMIT} at a time.`);
  }

  const results = [];
  for (const url of urls) {
    try {
      const added = await addProduct(context, url);
      results.push({ url, ok: true, sourceId: added.sourceId, name: added.name, created: added.created, error: null });
    } catch (error) {
      results.push({
        url,
        ok: false,
        sourceId: null,
        name: null,
        created: false,
        error: AppError.is(error) ? error.publicMessage : "Couldn't be added.",
      });
    }
  }
  return results;
}

// --- One website, one product ---------------------------------------------

export interface ConsolidationResult {
  /** Websites that had more than one product, and which one was kept. */
  readonly merged: readonly { site: string; kept: string; absorbed: readonly string[] }[];
  /** Products whose site key was filled in. */
  readonly backfilled: number;
}

/**
 * Fold every duplicate product into one per website, and give every product
 * its site key.
 *
 * Duplicates happened because a product was found by its exact host: a page on
 * app.notion.com missed the product added as www.notion.com and started a
 * second Notion. Now that `resolveSourceForUrl` matches on the site, this
 * repairs what already exists, after which `sources_site_key` keeps it that
 * way.
 *
 * For each website the product kept is the live one (not archived) with the
 * most content, then the oldest. Everything that pointed at the others —
 * screens, flows, captures, media, sessions, tags — is moved onto it, and the
 * others are soft-deleted with an audit entry naming where they went. Nothing
 * captured is lost. Safe to run again: a second run finds nothing to do.
 */
export async function consolidateProducts(
  context: AdminContext,
  options: { readonly dryRun?: boolean } = {},
): Promise<ConsolidationResult> {
  requirePermission(context.actor, "source.update");

  const rows = await context.db
    .select({
      id: sources.id,
      name: sources.name,
      domain: sources.domain,
      site: sources.site,
      status: sources.status,
      createdAt: sources.createdAt,
      contentCount: sql<number>`(
        select count(*)::int from ${contentItems}
        where ${contentItems.sourceId} = ${sources}.id and ${contentItems.deletedAt} is null
      )`,
    })
    .from(sources)
    .where(isNull(sources.deletedAt));

  const bySite = new Map<string, typeof rows>();
  for (const row of rows) {
    const site = row.site ?? (row.domain ? registrableDomain(row.domain) : null);
    if (!site) continue;
    bySite.set(site, [...(bySite.get(site) ?? []), row]);
  }

  const merged: { site: string; kept: string; absorbed: string[] }[] = [];
  let backfilled = 0;

  for (const [site, group] of bySite) {
    const ranked = [...group].sort(
      (a, b) =>
        Number(a.status === "archived") - Number(b.status === "archived") ||
        b.contentCount - a.contentCount ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const keeper = ranked[0]!;
    const losers = ranked.slice(1);

    if (losers.length > 0) {
      merged.push({
        site,
        kept: `${keeper.name} (${keeper.domain})`,
        absorbed: losers.map((loser) => `${loser.name} (${loser.domain})`),
      });
    }
    if (options.dryRun) {
      if (keeper.site !== site) backfilled += 1;
      continue;
    }

    await inTransaction(context, async (tx) => {
      const db = tx.db;
      const loserIds = losers.map((loser) => loser.id);

      if (loserIds.length > 0) {
        // A tag on both products would collide on (term, source) once moved;
        // the keeper's copy stands and the duplicate goes.
        await db.execute(sql`
          delete from ${taxonomyAssignments} ta
           where ta.source_id in ${loserIds}
             and exists (
               select 1 from ${taxonomyAssignments} k
                where k.source_id = ${keeper.id} and k.term_id = ta.term_id
             )
        `);
        for (const table of [
          taxonomyAssignments,
          classificationSuggestions,
          contentItems,
          captures,
          mediaAssets,
          discoveredPages,
          captureSessions,
          crawlJobs,
          urlRegistry,
        ] as const) {
          await db.update(table).set({ sourceId: keeper.id }).where(inArray(table.sourceId, loserIds));
        }

        const now = new Date();
        await db
          .update(sources)
          .set({ deletedAt: now, status: "archived", updatedAt: now })
          .where(inArray(sources.id, loserIds));

        for (const loser of losers) {
          await recordAudit(db, context, {
            action: "source.merged",
            entityType: "source",
            entityId: loser.id,
            entityLabel: `${loser.name} (${loser.domain})`,
            after: { mergedInto: keeper.id },
            context: { site, keptName: keeper.name, keptDomain: keeper.domain },
          });
        }

        // The keeper's counters were counted without the absorbed rows.
        await db
          .update(sources)
          .set({
            contentCount: sql`(select count(*)::int from ${contentItems} c where c.source_id = ${keeper.id} and c.deleted_at is null)`,
            captureCount: sql`(select count(*)::int from ${captures} c where c.source_id = ${keeper.id})`,
            mediaCount: sql`(select count(*)::int from ${mediaAssets} m where m.source_id = ${keeper.id})`,
            // A live product stays live: absorbing an archived duplicate must
            // not archive the one people are using, and vice versa.
            status: keeper.status === "archived" && losers.some((loser) => loser.status !== "archived")
              ? "draft"
              : keeper.status,
            updatedAt: now,
          })
          .where(eq(sources.id, keeper.id));
      }

      if (keeper.site !== site) {
        await db.update(sources).set({ site }).where(eq(sources.id, keeper.id));
        backfilled += 1;
      }
    });
  }

  return { merged, backfilled };
}
