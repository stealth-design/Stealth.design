/**
 * Media (§9, §10, §30).
 *
 * The allowlist below is the whole upload security model in one place: a file
 * is accepted only if its *sniffed* content type (from magic bytes, not the
 * client's claim and not the filename) appears here. Anything else is refused.
 *
 * SVG is present but flagged `requiresSanitization`, because an SVG is a
 * document that can carry script and external references. It is stored, served
 * with a restrictive `Content-Disposition` and CSP, and never inlined into a
 * CMS or public page. No format here is ever executed.
 */

export const MEDIA_KINDS = ["image", "video", "document", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaFormat {
  readonly mimeType: string;
  readonly kind: MediaKind;
  readonly extensions: readonly string[];
  readonly label: string;
  /** Uploadable by an operator through the media library. */
  readonly uploadable: boolean;
  /** Produced by the capture pipeline. */
  readonly captureOutput: boolean;
  /** Can be resized/transcoded by sharp to make derivatives. */
  readonly canDeriveThumbnails: boolean;
  /** Needs extra handling before it is safe to serve. */
  readonly requiresSanitization: boolean;
  readonly maxBytes: number;
}

const MB = 1024 * 1024;

export const MEDIA_FORMATS: readonly MediaFormat[] = [
  {
    mimeType: "image/png",
    kind: "image",
    extensions: ["png"],
    label: "PNG",
    uploadable: true,
    captureOutput: true,
    canDeriveThumbnails: true,
    requiresSanitization: false,
    maxBytes: 64 * MB,
  },
  {
    mimeType: "image/jpeg",
    kind: "image",
    extensions: ["jpg", "jpeg"],
    label: "JPEG",
    uploadable: true,
    captureOutput: true,
    canDeriveThumbnails: true,
    requiresSanitization: false,
    maxBytes: 64 * MB,
  },
  {
    mimeType: "image/webp",
    kind: "image",
    extensions: ["webp"],
    label: "WebP",
    uploadable: true,
    captureOutput: true,
    canDeriveThumbnails: true,
    requiresSanitization: false,
    maxBytes: 64 * MB,
  },
  {
    mimeType: "image/avif",
    kind: "image",
    extensions: ["avif"],
    label: "AVIF",
    uploadable: true,
    captureOutput: false,
    canDeriveThumbnails: true,
    requiresSanitization: false,
    maxBytes: 64 * MB,
  },
  {
    mimeType: "image/gif",
    kind: "image",
    extensions: ["gif"],
    label: "GIF",
    uploadable: true,
    captureOutput: false,
    canDeriveThumbnails: true,
    requiresSanitization: false,
    maxBytes: 32 * MB,
  },
  {
    mimeType: "image/svg+xml",
    kind: "image",
    extensions: ["svg"],
    label: "SVG",
    uploadable: true,
    captureOutput: false,
    // Rasterising untrusted SVG means handing an XML parser attacker input.
    // Not worth it for V1; SVGs get a generic placeholder thumbnail.
    canDeriveThumbnails: false,
    requiresSanitization: true,
    maxBytes: 2 * MB,
  },
  {
    mimeType: "video/mp4",
    kind: "video",
    extensions: ["mp4", "m4v"],
    label: "MP4",
    uploadable: true,
    captureOutput: true,
    canDeriveThumbnails: false,
    requiresSanitization: false,
    maxBytes: 512 * MB,
  },
  {
    mimeType: "video/webm",
    kind: "video",
    extensions: ["webm"],
    label: "WebM",
    uploadable: true,
    captureOutput: true,
    canDeriveThumbnails: false,
    requiresSanitization: false,
    maxBytes: 512 * MB,
  },
  {
    mimeType: "text/html",
    kind: "document",
    extensions: ["html"],
    label: "HTML snapshot",
    // Only the capture pipeline produces these, and they are never served to a
    // browser — they are downloadable evidence, stored with a text/plain
    // disposition so they cannot execute in our origin.
    uploadable: false,
    captureOutput: true,
    canDeriveThumbnails: false,
    requiresSanitization: true,
    maxBytes: 16 * MB,
  },
  {
    mimeType: "application/pdf",
    kind: "document",
    extensions: ["pdf"],
    label: "PDF",
    uploadable: true,
    captureOutput: false,
    canDeriveThumbnails: false,
    requiresSanitization: true,
    maxBytes: 64 * MB,
  },
];

export const MEDIA_FORMAT_BY_MIME: ReadonlyMap<string, MediaFormat> = new Map(
  MEDIA_FORMATS.map((f) => [f.mimeType, f]),
);

export const UPLOADABLE_MIME_TYPES = MEDIA_FORMATS.filter((f) => f.uploadable).map((f) => f.mimeType);

/** Accept attribute for the upload input. */
export const UPLOAD_ACCEPT_ATTRIBUTE = MEDIA_FORMATS.filter((f) => f.uploadable)
  .flatMap((f) => [f.mimeType, ...f.extensions.map((e) => `.${e}`)])
  .join(",");

export function mediaFormatFor(mimeType: string): MediaFormat | undefined {
  return MEDIA_FORMAT_BY_MIME.get(mimeType.toLowerCase().split(";")[0]!.trim());
}

export function isUploadableMime(mimeType: string): boolean {
  return mediaFormatFor(mimeType)?.uploadable === true;
}

export function mediaKindFor(mimeType: string): MediaKind {
  return mediaFormatFor(mimeType)?.kind ?? "other";
}

export const MEDIA_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
  "quarantined",
  "archived",
  "deleted",
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const MEDIA_STATUS_META: Record<
  MediaStatus,
  { label: string; description: string; tone: "neutral" | "info" | "progress" | "success" | "warning" | "danger"; usable: boolean }
> = {
  pending: { label: "Pending", description: "Registered, bytes not yet received.", tone: "neutral", usable: false },
  processing: {
    label: "Processing",
    description: "Hashing and generating thumbnails.",
    tone: "progress",
    usable: false,
  },
  ready: { label: "Ready", description: "Stored and usable.", tone: "success", usable: true },
  failed: { label: "Failed", description: "Upload or processing failed.", tone: "danger", usable: false },
  quarantined: {
    label: "Quarantined",
    description: "Rejected by validation. Retained for inspection, never served.",
    tone: "danger",
    usable: false,
  },
  archived: {
    label: "Archived",
    description: "Hidden from the library but still stored and still referenced.",
    tone: "neutral",
    usable: false,
  },
  deleted: {
    label: "Deleted",
    description: "Bytes removed from storage. The record remains for provenance.",
    tone: "danger",
    usable: false,
  },
};

/** Derivative sizes generated for every raster image. */
export const MEDIA_DERIVATIVE_KINDS = ["thumbnail", "preview", "large", "poster"] as const;
export type MediaDerivativeKind = (typeof MEDIA_DERIVATIVE_KINDS)[number];

export interface DerivativeSpec {
  readonly kind: MediaDerivativeKind;
  /**
   * What this rendition is *for*, which decides how an awkward aspect ratio is
   * resolved.
   *
   * `card` renditions are laid out in a grid, so they must all share one
   * aspect ratio. They take a top crop: the hero of a page is the part worth
   * showing on a card, and the rest of a 30,000px page is not.
   *
   * `full` renditions are for reading the page. Width is the property that
   * decides whether they are legible, so width is what they hold, and they are
   * allowed to be as tall as the format permits.
   */
  readonly purpose: "card" | "full";
  /** Target width. Never enlarged past the original. */
  readonly width: number;
  /**
   * `card` only: the crop height, giving the fixed card aspect ratio.
   * `full` renditions have no height target — see `purpose`.
   */
  readonly cropHeight?: number;
  readonly format: "webp" | "jpeg";
  readonly quality: number;
  readonly label: string;
}

/**
 * The largest dimension WebP can encode.
 *
 * A hard format limit, not a policy choice: a full-page screenshot of a long
 * marketing site exceeds it easily, so `full` renditions are cropped at this
 * height rather than being shrunk to fit inside it.
 */
export const MAX_WEBP_DIMENSION = 16_383;

/**
 * Derivative specs.
 *
 * These previously shared one strategy — fit inside a width *and* a height —
 * and that strategy cannot serve both jobs at once. `fit: "inside"` honours
 * whichever bound binds first, and on a full-page screenshot that is always
 * the height, so a 780×31,182 capture became a **102px-wide** preview. The
 * comment that used to sit here worried about a 34px sliver and the cap it
 * justified produced a 102px one instead: same failure, other axis.
 *
 * So each rendition now declares its purpose and gets the geometry that
 * purpose needs.
 *
 *   thumbnail  card  480×300   top crop, uniform 16:10 for the grid
 *   preview    full  1024 wide any height the encoder allows
 *   large      full  2048 wide any height the encoder allows
 *
 * A page taller than `MAX_WEBP_DIMENSION` at the target width is cropped from
 * the top, never squashed — losing the footer of a very long page is a far
 * smaller loss than making every pixel of it illegible.
 */
export const DERIVATIVE_SPECS: readonly DerivativeSpec[] = [
  {
    kind: "thumbnail",
    purpose: "card",
    width: 480,
    cropHeight: 300,
    format: "webp",
    quality: 78,
    label: "Thumbnail",
  },
  { kind: "preview", purpose: "full", width: 1024, format: "webp", quality: 82, label: "Preview" },
  { kind: "large", purpose: "full", width: 2048, format: "webp", quality: 85, label: "Large" },
];

/** How a media asset is used by the record it is attached to (§9 "usage"). */
export const MEDIA_USAGE_ROLES = [
  "primary",
  "screenshot_desktop",
  "screenshot_mobile",
  "screenshot_full_page",
  "screenshot_viewport",
  "og_image",
  "favicon",
  "html_snapshot",
  "before_state",
  "after_state",
  "recording",
  "cover",
  "attachment",
] as const;
export type MediaUsageRole = (typeof MEDIA_USAGE_ROLES)[number];

export const MEDIA_USAGE_ROLE_LABELS: Record<MediaUsageRole, string> = {
  primary: "Primary image",
  screenshot_desktop: "Desktop screenshot",
  screenshot_mobile: "Mobile screenshot",
  screenshot_full_page: "Full-page screenshot",
  screenshot_viewport: "Viewport screenshot",
  og_image: "Open Graph image",
  favicon: "Favicon",
  html_snapshot: "HTML snapshot",
  before_state: "Before state",
  after_state: "After state",
  recording: "Recording",
  cover: "Cover image",
  attachment: "Attachment",
};

/** Where the bytes came from. */
export const MEDIA_UPLOAD_SOURCES = ["capture", "manual_upload", "import", "derived"] as const;
export type MediaUploadSource = (typeof MEDIA_UPLOAD_SOURCES)[number];

/** Result of upload validation. Never trust the client's declared type. */
export const MEDIA_SCAN_STATUSES = ["pending", "passed", "rejected"] as const;
export type MediaScanStatus = (typeof MEDIA_SCAN_STATUSES)[number];

export const MEDIA_REJECTION_REASONS = {
  MIME_NOT_ALLOWED: "This file type is not accepted.",
  MIME_MISMATCH: "The file's actual contents do not match its claimed type.",
  TOO_LARGE: "The file is larger than the limit for its type.",
  EMPTY: "The file is empty.",
  UNREADABLE: "The file could not be read as a valid image or video.",
  DIMENSIONS_TOO_LARGE: "The image dimensions exceed the processing limit.",
  SVG_UNSAFE: "The SVG contains script or external references and was refused.",
} as const;
export type MediaRejectionReason = keyof typeof MEDIA_REJECTION_REASONS;

/**
 * Sharp's pixel ceiling. A "decompression bomb" is a small file that declares
 * enormous dimensions; without a cap, decoding one exhausts memory.
 */
export const MAX_IMAGE_PIXELS = 300_000_000;
export const MAX_IMAGE_DIMENSION = 32_767;
