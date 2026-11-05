"use server";

/**
 * Product actions. Thin wrappers: the permission check, the URL policy and
 * the audit write live in the service; this translates an `AppError` into a
 * line the form can show.
 */
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  addProduct,
  addProducts,
  discardScreen,
  findWebsiteIcon,
  ingestMedia,
  prefillWebsiteLogo,
  setWebsiteLogo,
  previewProducts,
  removeProduct,
  renameProduct,
  restoreWebsite,
  setWebsiteIndustry,
  takeDownWebsite,
  type BulkLine,
} from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContext, resolveMediaUrls } from "@/lib/server";
import type { AdminContext } from "@uxd/api";

/**
 * Look for each new website's logo once the response has gone, so adding a
 * hundred websites is not slowed by a hundred home pages. A few at a time.
 */
function prefillLogosLater(context: AdminContext, sourceIds: readonly string[]): void {
  if (sourceIds.length === 0) return;
  after(async () => {
    const queue = [...sourceIds];
    const work = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await prefillWebsiteLogo(context, next).catch((error: unknown) =>
          context.logger.warn("Could not find a logo for a new website", { sourceId: next, error }),
        );
      }
    };
    await Promise.all([work(), work(), work()]);
  });
}

export interface AddProductState {
  readonly ok: boolean;
  readonly message: string | null;
  readonly error: string | null;
}

export async function addProductAction(_previous: AddProductState, formData: FormData): Promise<AddProductState> {
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return { ok: false, message: null, error: "Paste a website address first." };

  try {
    const context = await getAdminContext();
    const result = await addProduct(context, url);
    prefillLogosLater(context, [result.sourceId]);
    refresh();
    return {
      ok: true,
      message: result.created ? `Added ${result.name}.` : `${result.name} is already here — moved it to the top.`,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      message: null,
      error: AppError.is(error) ? error.publicMessage : "That address could not be added.",
    };
  }
}

export interface ProductActionResult {
  readonly ok: boolean;
  readonly error: string | null;
}

const failed = (error: unknown, fallback: string): ProductActionResult => ({
  ok: false,
  error: AppError.is(error) ? error.publicMessage : fallback,
});

export async function renameProductAction(sourceId: string, name: string): Promise<ProductActionResult> {
  try {
    await renameProduct(await getAdminContext(), sourceId, name);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "The name could not be saved.");
  }
}

/** Archive, then go back to the list — the product's page has nothing to show any more. */
export async function removeProductAction(sourceId: string): Promise<ProductActionResult> {
  try {
    await removeProduct(await getAdminContext(), sourceId);
  } catch (error) {
    return failed(error, "The product could not be removed.");
  }
  redirect("/products");
}

export async function discardScreenAction(contentId: string): Promise<ProductActionResult> {
  try {
    await discardScreen(await getAdminContext(), contentId);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "That capture could not be discarded.");
  }
}

/** Check a pasted list. Nothing is added. */
export async function previewProductsAction(
  raw: string,
): Promise<{ ok: boolean; error: string | null; lines: BulkLine[] }> {
  try {
    return { ok: true, error: null, lines: await previewProducts(await getAdminContext(), raw) };
  } catch (error) {
    return { ok: false, error: AppError.is(error) ? error.publicMessage : "That list couldn't be read.", lines: [] };
  }
}

/** Add the addresses kept from the preview. */
export async function addProductsAction(urls: string[]): Promise<{
  ok: boolean;
  error: string | null;
  added: number;
  restored: number;
  failed: { url: string; error: string | null }[];
}> {
  try {
    const context = await getAdminContext();
    const results = await addProducts(context, urls);
    prefillLogosLater(
      context,
      results.flatMap((result) => (result.ok && result.sourceId ? [result.sourceId] : [])),
    );
    refresh();
    return {
      ok: true,
      error: null,
      added: results.filter((result) => result.ok && result.created).length,
      restored: results.filter((result) => result.ok && !result.created).length,
      failed: results.filter((result) => !result.ok).map((result) => ({ url: result.url, error: result.error })),
    };
  } catch (error) {
    return {
      ok: false,
      error: AppError.is(error) ? error.publicMessage : "Those couldn't be added.",
      added: 0,
      restored: 0,
      failed: [],
    };
  }
}

/** Take a whole website off the public site and block new captures. */
export async function takeDownWebsiteAction(
  sourceId: string,
  reason: string,
): Promise<{ ok: boolean; error: string | null; unpublished: number }> {
  try {
    const { unpublished } = await takeDownWebsite(await getAdminContext(), sourceId, reason);
    refresh();
    return { ok: true, error: null, unpublished };
  } catch (error) {
    return { ok: false, error: AppError.is(error) ? error.publicMessage : "That website couldn't be taken down.", unpublished: 0 };
  }
}

/** Allow a taken-down website to be captured again. */
export async function restoreWebsiteAction(sourceId: string): Promise<ProductActionResult> {
  try {
    await restoreWebsite(await getAdminContext(), sourceId);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "That couldn't be changed.");
  }
}

/** File a website under an industry, or none. */
export async function setWebsiteIndustryAction(sourceId: string, termId: string | null): Promise<ProductActionResult> {
  try {
    await setWebsiteIndustry(await getAdminContext(), sourceId, termId);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "The industry couldn't be saved.");
  }
}

export interface LogoResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly mediaId?: string;
  readonly url?: string | null;
}

/** Look for the website's icon again. Returned, not saved — Save decides. */
export async function findLogoAction(sourceId: string): Promise<LogoResult> {
  try {
    const context = await getAdminContext();
    const found = await findWebsiteIcon(context, sourceId);
    if (!found) return { ok: false, error: "No usable logo found on the website. Upload one instead." };
    const urls = await resolveMediaUrls([found.storageKey]);
    return { ok: true, error: null, mediaId: found.mediaId, url: found.storageKey ? (urls.get(found.storageKey) ?? null) : null };
  } catch (error) {
    return { ok: false, error: AppError.is(error) ? error.publicMessage : "The website couldn't be read." };
  }
}

/** Upload a logo. Stored, not yet used — Save decides. PNG, JPG or WebP. */
export async function uploadLogoAction(formData: FormData): Promise<LogoResult> {
  try {
    const context = await getAdminContext();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image." };
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
      return { ok: false, error: "Use a PNG, JPG or WebP — SVG files can carry code, so they're not accepted." };
    }
    if (file.size > 2 * 1024 * 1024) return { ok: false, error: "Keep it under 2MB." };
    const stored = await ingestMedia(context, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalFilename: file.name,
      altText: "Logo",
      maxBytes: 2 * 1024 * 1024,
      uploadedBy: context.actor.id,
      provenance: { uploadSource: "manual_upload", captureMethod: "manual_upload" },
    });
    const media = await context.db.query.mediaAssets.findFirst({
      columns: { storageKey: true },
      where: (asset, { eq }) => eq(asset.id, stored.mediaId),
    });
    const urls = await resolveMediaUrls([media?.storageKey]);
    return { ok: true, error: null, mediaId: stored.mediaId, url: media?.storageKey ? (urls.get(media.storageKey) ?? null) : null };
  } catch (error) {
    return { ok: false, error: AppError.is(error) ? error.publicMessage : "That image couldn't be used." };
  }
}

/** Save the logo chosen in the editor (or none). A person chose it, so it stays. */
export async function saveLogoAction(sourceId: string, mediaId: string | null): Promise<ProductActionResult> {
  try {
    await setWebsiteLogo(await getAdminContext(), sourceId, mediaId, "manual");
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "The logo couldn't be saved.");
  }
}
