import type { PublicMedia } from "@uxd/api/client";

/**
 * Which rendition of a capture to load, and how to describe the choice to
 * the browser. Shared by the server-rendered frames and the client viewer so
 * both pick the same files.
 */

/** The cropped 16:10 thumbnail, for frames in a sheet or a filmstrip. */
export function thumbSrc(media: PublicMedia): string {
  return media.thumbnailUrl ?? media.previewUrl ?? media.url;
}

/** The whole capture at the largest web rendition, for the stage. */
export function stageSrc(media: PublicMedia): string {
  return media.largeUrl ?? media.previewUrl ?? media.url;
}

/**
 * The whole-capture renditions as a srcset, ascending. The original master
 * is excluded: a lossless PNG that can run to many megabytes. The cropped
 * thumbnail is excluded too — srcset candidates must be the same picture at
 * different resolutions, and a crop is a different picture.
 */
export function stageSrcSet(media: PublicMedia): string | undefined {
  const originalWidth = media.width ?? null;
  const candidates: { url: string; width: number }[] = [];
  const seen = new Set<number>();

  for (const [url, cap] of [
    [media.previewUrl, 1024],
    [media.largeUrl, 2048],
  ] as const) {
    if (!url) continue;
    const width = originalWidth === null ? cap : Math.min(cap, originalWidth);
    if (seen.has(width)) continue;
    seen.add(width);
    candidates.push({ url, width });
  }

  if (candidates.length < 2) return undefined;
  return candidates
    .sort((a, b) => a.width - b.width)
    .map((c) => `${c.url} ${c.width}w`)
    .join(", ");
}
