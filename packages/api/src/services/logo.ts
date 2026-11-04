/**
 * A website's logo.
 *
 * Filled in three ways, in increasing order of authority:
 *
 *   icon    the moment a website is added, its home page is read (without
 *           running it) for the icons it publishes about itself; the largest
 *           raster one is stored
 *   header  the first time someone opens it in the studio, the capture
 *           browser photographs the logo in the page header — the real
 *           wordmark — and it replaces an icon
 *   manual  a person uploads one; nothing automatic ever replaces it
 *
 * Every image goes through `ingestMedia`, so it is type-sniffed, size-capped
 * and stored like any other media. SVG is never fetched or stored here: the
 * control plane does not parse attacker-supplied vector files.
 */
import { and, eq, isNull } from "drizzle-orm";
import { requirePermission } from "@uxd/auth";
import { mediaAssets, sources } from "@uxd/database";
import { notFound } from "@uxd/shared";
import { recordAudit } from "../audit.js";
import type { AdminContext, BaseContext } from "../context.js";
import { ingestMedia } from "./media-intake.js";

export type LogoOrigin = "icon" | "header" | "manual";

/** Presented to the website when reading its home page. Says who we are. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 uxdisrupt-research/0.1";

/** Smaller than this is a favicon, not a logo worth showing. */
const MIN_LOGO_PX = 48;

export async function getWebsiteLogo(context: BaseContext, sourceId: string) {
  const [row] = await context.db
    .select({ mediaId: sources.logoMediaId, origin: sources.logoOrigin, storageKey: mediaAssets.storageKey })
    .from(sources)
    .leftJoin(mediaAssets, eq(mediaAssets.id, sources.logoMediaId))
    .where(eq(sources.id, sourceId))
    .limit(1);
  return row?.mediaId ? { mediaId: row.mediaId, origin: row.origin as LogoOrigin | null, storageKey: row.storageKey } : null;
}

/**
 * Read a website's home page for the icons it publishes and store the best
 * one. Returns the stored media, or null when nothing usable was found.
 * Nothing is attached to the website — the caller decides that.
 */
export async function findWebsiteIcon(
  context: BaseContext,
  sourceId: string,
): Promise<{ mediaId: string; storageKey: string | null } | null> {
  const { fetchGuarded, findLogoCandidates, findManifestIcons } = await import("@uxd/crawler");

  const [source] = await context.db
    .select({ id: sources.id, canonicalUrl: sources.canonicalUrl, domain: sources.domain })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  if (!source) throw notFound("Product");
  const home = source.canonicalUrl ?? (source.domain ? `https://${source.domain}/` : null);
  if (!home) return null;

  const page = await fetchGuarded(home, {
    userAgent: USER_AGENT,
    maxBytes: 3 * 1024 * 1024,
    timeoutMs: 15_000,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  });
  if (!page.ok || !page.value.bodyText) return null;

  const { candidates, manifestUrl } = findLogoCandidates(page.value.bodyText, page.value.finalUrl);
  if (manifestUrl) {
    const manifest = await fetchGuarded(manifestUrl, {
      userAgent: USER_AGENT,
      maxBytes: 256 * 1024,
      timeoutMs: 10_000,
      accept: "application/manifest+json,application/json;q=0.9,*/*;q=0.5",
    });
    if (manifest.ok && manifest.value.bodyText) candidates.push(...findManifestIcons(manifest.value.bodyText, manifestUrl));
  }
  // Big, then Apple's, then whatever is left — and try a few, because sites
  // often declare icons that no longer exist.
  candidates.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

  for (const candidate of candidates.slice(0, 6)) {
    const image = await fetchGuarded(candidate.url, {
      userAgent: USER_AGENT,
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 10_000,
      accept: "image/png,image/webp,image/jpeg;q=0.9",
    });
    if (!image.ok || image.value.httpStatus >= 400) continue;
    try {
      const stored = await ingestMedia(context, {
        bytes: image.value.bodyBytes,
        originalFilename: `${source.domain ?? "logo"}-${candidate.kind}.png`,
        altText: `${source.domain ?? "Website"} logo`,
        maxBytes: 2 * 1024 * 1024,
        provenance: {
          sourceUrl: candidate.url,
          originDomain: source.domain,
          sourceId,
          uploadSource: "import",
          captureMethod: "http_fetch",
        },
      });
      if (stored.mimeType === "image/svg+xml") continue;
      if ((stored.width ?? 0) < MIN_LOGO_PX && (stored.height ?? 0) < MIN_LOGO_PX) continue;
      const [asset] = await context.db
        .select({ storageKey: mediaAssets.storageKey })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, stored.mediaId))
        .limit(1);
      return { mediaId: stored.mediaId, storageKey: asset?.storageKey ?? null };
    } catch (error) {
      context.logger.debug("A logo candidate was not a usable image", { url: candidate.url, error });
    }
  }
  return null;
}

/**
 * Fill in a website's logo from its published icons — only when it has none.
 * Run after a website is added; never replaces a logo someone chose.
 */
export async function prefillWebsiteLogo(context: BaseContext, sourceId: string): Promise<boolean> {
  const current = await getWebsiteLogo(context, sourceId);
  if (current) return false;
  const icon = await findWebsiteIcon(context, sourceId);
  if (!icon) return false;
  const updated = await context.db
    .update(sources)
    .set({ logoMediaId: icon.mediaId, logoOrigin: "icon", updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), isNull(sources.logoMediaId)))
    .returning({ id: sources.id });
  return updated.length > 0;
}

/**
 * Use the logo photographed from the page header, unless a person has chosen
 * one. Called on behalf of the capture worker.
 */
export async function useHeaderLogo(context: BaseContext, sourceId: string, mediaId: string): Promise<boolean> {
  const current = await getWebsiteLogo(context, sourceId);
  if (current?.origin === "manual" || current?.origin === "header") return false;
  await context.db
    .update(sources)
    .set({ logoMediaId: mediaId, logoOrigin: "header", updatedAt: new Date() })
    .where(eq(sources.id, sourceId));
  return true;
}

/** A person setting (or clearing) the logo. Marked manual, so it stays. */
export async function setWebsiteLogo(
  context: AdminContext,
  sourceId: string,
  mediaId: string | null,
  origin: LogoOrigin = "manual",
): Promise<void> {
  requirePermission(context.actor, "source.update");
  const [source] = await context.db
    .update(sources)
    .set({
      logoMediaId: mediaId,
      logoOrigin: mediaId ? origin : null,
      updatedBy: context.actor.id,
      updatedAt: new Date(),
    })
    .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
    .returning({ name: sources.name });
  if (!source) throw notFound("Product");
  await recordAudit(context.db, context, {
    action: "source.updated",
    entityType: "source",
    entityId: sourceId,
    entityLabel: source.name,
    after: { logoMediaId: mediaId, logoOrigin: mediaId ? origin : null },
  });
}
