/**
 * Finding a website's logo in its HTML, without running any of it.
 *
 * This is the cheap first pass, done the moment a website is added: the icons
 * a site publishes about itself — `apple-touch-icon`, a large `icon`, the
 * icons in its web app manifest. They are square and usually clean, and they
 * are raster images, which matters: SVG is deliberately never processed on
 * the control plane (see `canDeriveThumbnails` for SVG in `@uxd/types`).
 *
 * The real wordmark in the page header is found later, by the capture
 * browser, which can render and photograph it safely.
 */
import * as cheerio from "cheerio";

export interface LogoCandidate {
  /** Absolute URL of the image. */
  readonly url: string;
  /** Where it was found, for the record. */
  readonly kind: "apple-touch-icon" | "icon" | "manifest";
  /** Its declared size in pixels (the larger side), when known. */
  readonly size: number | null;
}

/** Raster types we can store. SVG and ICO are skipped on purpose. */
const RASTER = /\.(png|jpe?g|webp)(\?|#|$)/i;
const RASTER_TYPE = /^image\/(png|jpe?g|webp)$/i;

/**
 * The icons a page declares, best first: the largest raster icons, Apple's
 * touch icon before a generic one when sizes tie. Also returns the manifest's
 * address, when there is one, so the caller can read its icons next.
 */
export function findLogoCandidates(
  html: string,
  pageUrl: string,
): { candidates: LogoCandidate[]; manifestUrl: string | null } {
  const $ = cheerio.load(html);
  const candidates: LogoCandidate[] = [];
  const seen = new Set<string>();

  $("link[rel][href]").each((_, element) => {
    const rel = ($(element).attr("rel") ?? "").toLowerCase().split(/\s+/);
    const href = $(element).attr("href");
    if (!href) return;
    const kind = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")
      ? "apple-touch-icon"
      : rel.includes("icon")
        ? "icon"
        : null;
    if (!kind) return;

    const url = absolute(href, pageUrl);
    if (!url || seen.has(url)) return;
    const type = $(element).attr("type");
    if (!(type ? RASTER_TYPE.test(type) : RASTER.test(url))) return;

    seen.add(url);
    candidates.push({ url, kind, size: largestSize($(element).attr("sizes")) ?? (kind === "apple-touch-icon" ? 180 : null) });
  });

  const manifestHref = $('link[rel="manifest"][href]').first().attr("href");
  return { candidates: rank(candidates), manifestUrl: manifestHref ? absolute(manifestHref, pageUrl) : null };
}

/** The raster icons a web app manifest lists, largest first. */
export function findManifestIcons(manifestJson: string, manifestUrl: string): LogoCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return [];
  }
  const icons = (parsed as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return [];

  const out: LogoCandidate[] = [];
  for (const icon of icons.slice(0, 30)) {
    if (!icon || typeof icon !== "object") continue;
    const { src, sizes, type } = icon as { src?: unknown; sizes?: unknown; type?: unknown };
    if (typeof src !== "string") continue;
    const url = absolute(src, manifestUrl);
    if (!url) continue;
    if (!(typeof type === "string" ? RASTER_TYPE.test(type) : RASTER.test(url))) continue;
    out.push({ url, kind: "manifest", size: typeof sizes === "string" ? largestSize(sizes) : null });
  }
  return rank(out);
}

/**
 * Best first: bigger is better up to 512 (beyond that it is a splash image,
 * not an icon), unknown sizes last, Apple's touch icon ahead on a tie.
 */
export function rank(candidates: readonly LogoCandidate[]): LogoCandidate[] {
  const score = (candidate: LogoCandidate) => {
    const size = candidate.size ?? 0;
    const fit = size > 512 ? 512 - (size - 512) / 4 : size;
    return fit + (candidate.kind === "apple-touch-icon" ? 1 : 0);
  };
  return [...candidates].sort((a, b) => score(b) - score(a));
}

function largestSize(sizes: string | undefined | null): number | null {
  if (!sizes) return null;
  let best: number | null = null;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d{1,4})x(\d{1,4})$/.exec(token);
    if (!match) continue;
    const size = Math.max(Number(match[1]), Number(match[2]));
    if (best === null || size > best) best = size;
  }
  return best;
}

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
