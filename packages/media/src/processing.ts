/**
 * Media validation, hashing and derivative generation.
 *
 * The order of operations matters and is the security design:
 *
 *   1. Size check on the raw bytes, before any decoder sees them.
 *   2. Content type sniffed from magic bytes — never the client's claim, never
 *      the file extension.
 *   3. The sniffed type checked against the allowlist in `@uxd/types/media`.
 *   4. Only then is a decoder invoked, with an explicit pixel ceiling.
 *
 * Every step before (4) exists so that a hostile file is rejected by cheap
 * pattern matching rather than by a decoder, because the decoder is the part
 * with a memory-safety attack surface.
 */
import { Readable } from "node:stream";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { AppError, ErrorCode, type Logger, sha256Hex } from "@uxd/shared";
import {
  DERIVATIVE_SPECS,
  MAX_IMAGE_DIMENSION,
  MAX_WEBP_DIMENSION,
  MAX_IMAGE_PIXELS,
  type MediaDerivativeKind,
  type MediaKind,
  type MediaRejectionReason,
  MEDIA_REJECTION_REASONS,
  mediaFormatFor,
  mediaKindFor,
} from "@uxd/types";

/**
 * Global sharp limits.
 *
 * `concurrency(1)` because sharp's default thread pool sizes itself to the
 * machine's core count, and several concurrent full-page screenshots (which can
 * be 1440x20000) will otherwise exhaust memory. Throughput here is bounded by
 * the queue, not by sharp.
 */
sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 64 });

export interface ValidatedMedia {
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly extension: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly hasAlpha: boolean | null;
  readonly isAnimated: boolean | null;
  readonly colorProfile: string | null;
  readonly durationMs: number | null;
  readonly metadata: Record<string, unknown>;
}

export interface MediaRejection {
  readonly reason: MediaRejectionReason;
  readonly message: string;
  readonly detail?: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly media: ValidatedMedia }
  | { readonly ok: false; readonly rejection: MediaRejection };

const reject = (reason: MediaRejectionReason, detail?: string): ValidationResult => ({
  ok: false,
  rejection: { reason, message: MEDIA_REJECTION_REASONS[reason], detail },
});

/**
 * Patterns that make an SVG unsafe to serve.
 *
 * SVG is XML, and XML can carry script, external entity references and remote
 * fetches. This is a conservative screen rather than a sanitiser: a file that
 * matches is refused outright, because the media library has no need for an
 * SVG that contains script, and writing a correct SVG sanitiser is a project of
 * its own. SVGs that pass are still stored with `Content-Disposition:
 * attachment` and never inlined into a page.
 */
const SVG_DANGEROUS_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<\s*script/i, what: "a <script> element" },
  { pattern: /<\s*foreignObject/i, what: "a <foreignObject> element" },
  { pattern: /<!ENTITY/i, what: "an XML entity declaration (XXE risk)" },
  { pattern: /<!DOCTYPE[^>]+\[/i, what: "an inline DTD" },
  { pattern: /\son\w+\s*=/i, what: "an inline event handler attribute" },
  { pattern: /javascript\s*:/i, what: "a javascript: URL" },
  { pattern: /data\s*:\s*text\/html/i, what: "an embedded HTML data URL" },
  { pattern: /<\s*(iframe|embed|object|use\s[^>]*href\s*=\s*["']https?:)/i, what: "an external reference" },
  { pattern: /xlink:href\s*=\s*["']\s*(?!#)/i, what: "an external xlink reference" },
];

function screenSvg(bytes: Uint8Array): MediaRejection | null {
  // Only the head needs checking for the structural patterns, but event
  // handlers can appear anywhere, so scan the whole (2MB-capped) file.
  const text = Buffer.from(bytes).toString("utf8");
  for (const { pattern, what } of SVG_DANGEROUS_PATTERNS) {
    if (pattern.test(text)) {
      return {
        reason: "SVG_UNSAFE",
        message: MEDIA_REJECTION_REASONS.SVG_UNSAFE,
        detail: `contains ${what}`,
      };
    }
  }
  return null;
}

export interface ValidateOptions {
  /** Declared filename, used only for the error message and the extension hint. */
  readonly filename?: string | null;
  /** Absolute ceiling regardless of the per-format limit. */
  readonly maxBytes?: number;
  /** Permit types marked `uploadable: false` (i.e. capture pipeline output). */
  readonly allowCaptureOnlyTypes?: boolean;
  readonly logger?: Logger;
}

/**
 * Validate a file and extract its metadata.
 *
 * Takes the whole file in memory, which is why `maxBytes` is checked first: a
 * caller streaming an upload must enforce its own limit as it buffers, and does
 * (see the upload route's `readBodyWithLimit`).
 */
export async function validateMedia(
  bytes: Uint8Array,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  if (bytes.byteLength === 0) return reject("EMPTY");

  if (options.maxBytes && bytes.byteLength > options.maxBytes) {
    return reject(
      "TOO_LARGE",
      `${bytes.byteLength} bytes exceeds the ${options.maxBytes} byte limit`,
    );
  }

  // --- Sniff the real type ----------------------------------------------
  const sniffed = await fileTypeFromBuffer(bytes);

  // SVG is text, not a binary container, so magic-byte detection either misses
  // it entirely or reports the generic XML type. Recognise it structurally.
  const looksLikeSvg = (() => {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString("utf8").trimStart();
    if (!head.startsWith("<?xml") && !head.startsWith("<!--") && !head.startsWith("<!DOCTYPE") && !head.startsWith("<svg")) {
      return false;
    }
    return /<svg[\s>]/i.test(head);
  })();

  // A structural SVG match takes precedence over the sniffed type. Without
  // this, an SVG carrying an XML prolog is sniffed as `application/xml`,
  // refused as "type not allowed", and never reaches the SVG screen — which
  // wrongly rejects legitimate files and, for hostile ones, reports a far less
  // useful reason than naming the construct that was found.
  const XML_SNIFF_TYPES = new Set(["application/xml", "text/xml", "application/xhtml+xml"]);
  const sniffedIsGenericXml = sniffed !== undefined && XML_SNIFF_TYPES.has(sniffed.mime);

  const mimeType = looksLikeSvg && (sniffed === undefined || sniffedIsGenericXml)
    ? "image/svg+xml"
    : (sniffed?.mime ?? null);
  const extension = looksLikeSvg && (sniffed === undefined || sniffedIsGenericXml)
    ? "svg"
    : (sniffed?.ext ?? null);

  if (!mimeType || !extension) {
    return reject("MIME_NOT_ALLOWED", `could not determine the type of ${options.filename ?? "the file"}`);
  }

  const format = mediaFormatFor(mimeType);
  if (!format) return reject("MIME_NOT_ALLOWED", `sniffed type ${mimeType} is not on the allowlist`);
  if (!format.uploadable && !options.allowCaptureOnlyTypes) {
    return reject("MIME_NOT_ALLOWED", `${mimeType} is produced by the pipeline but not uploadable`);
  }
  if (bytes.byteLength > format.maxBytes) {
    return reject("TOO_LARGE", `${mimeType} is limited to ${format.maxBytes} bytes`);
  }

  // If a filename was supplied and its extension disagrees with the sniffed
  // type, that is worth recording — it is how a mislabelled or deliberately
  // disguised upload looks — but the sniffed type is what governs.
  const declaredExt = options.filename?.split(".").pop()?.toLowerCase();
  const extensionMismatch =
    declaredExt !== undefined && declaredExt.length > 0 && !format.extensions.includes(declaredExt);

  const sha256 = sha256Hex(bytes);
  const base = {
    kind: mediaKindFor(mimeType),
    mimeType,
    extension,
    byteSize: bytes.byteLength,
    sha256,
  };

  // --- SVG: screen, do not decode ---------------------------------------
  if (mimeType === "image/svg+xml") {
    const rejection = screenSvg(bytes);
    if (rejection) return { ok: false, rejection };
    return {
      ok: true,
      media: {
        ...base,
        width: null,
        height: null,
        hasAlpha: true,
        isAnimated: false,
        colorProfile: null,
        durationMs: null,
        metadata: { extensionMismatch, screened: true },
      },
    };
  }

  // --- Video and documents: no decode in V1 -----------------------------
  if (base.kind !== "image") {
    return {
      ok: true,
      media: {
        ...base,
        width: null,
        height: null,
        hasAlpha: null,
        isAnimated: null,
        colorProfile: null,
        durationMs: null,
        metadata: { extensionMismatch, probed: false },
      },
    };
  }

  // --- Raster images: decode metadata under an explicit pixel ceiling ---
  try {
    const image = sharp(bytes, {
      // A decompression bomb is a small file declaring enormous dimensions.
      // Without this, decoding one exhausts the process's memory.
      limitInputPixels: MAX_IMAGE_PIXELS,
      // Refuse truncated and malformed files rather than best-effort decoding
      // them, so a corrupt upload fails loudly at ingest instead of producing
      // a broken thumbnail later.
      failOn: "error",
      animated: false,
    });
    const meta = await image.metadata();

    if (!meta.width || !meta.height) return reject("UNREADABLE", "no dimensions in the image header");
    if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) {
      return reject("DIMENSIONS_TOO_LARGE", `${meta.width}x${meta.height}`);
    }
    if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
      return reject("DIMENSIONS_TOO_LARGE", `${meta.width * meta.height} pixels`);
    }

    // `metadata()` only parses the header, so a file whose header is intact but
    // whose pixel data is truncated or corrupt passes it. Force an actual
    // decode pass by resizing to a tiny raster: cheap relative to the upload,
    // and it means a broken file fails here — with a clear reason — rather than
    // being stored and then failing during derivative generation.
    try {
      await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error" })
        .resize(8, 8, { fit: "inside" })
        .raw()
        .toBuffer();
    } catch (error) {
      return reject(
        "UNREADABLE",
        `header parsed but pixel data could not be decoded: ${
          error instanceof Error ? error.message.slice(0, 160) : "decode failed"
        }`,
      );
    }

    return {
      ok: true,
      media: {
        ...base,
        width: meta.width,
        height: meta.height,
        hasAlpha: meta.hasAlpha ?? false,
        isAnimated: (meta.pages ?? 1) > 1,
        colorProfile: meta.space ?? null,
        durationMs: null,
        metadata: {
          extensionMismatch,
          format: meta.format,
          density: meta.density,
          pages: meta.pages,
          orientation: meta.orientation,
          isProgressive: meta.isProgressive,
        },
      },
    };
  } catch (error) {
    options.logger?.warn("Image decode failed during validation", { error });
    return reject("UNREADABLE", error instanceof Error ? error.message.slice(0, 200) : "decode failed");
  }
}

// --- Perceptual hashing ---------------------------------------------------

/**
 * 64-bit difference hash (dHash).
 *
 * Why this and not sha256: two screenshots of the same page taken minutes apart
 * differ in a handful of bytes — an animation frame, a rotating testimonial, a
 * timestamp — so their sha256 values are unrelated and exact dedupe misses
 * them entirely. dHash compares the brightness of horizontally adjacent pixels
 * in a 9x8 greyscale reduction, so it is stable under compression, minor colour
 * shifts and small content changes, and two near-identical captures land within
 * a few bits of each other.
 *
 * Implemented here rather than pulled from a dependency because it is nine
 * lines of pixel arithmetic, and because the exact algorithm has to stay
 * frozen: changing it would invalidate every stored hash.
 */
export async function perceptualHash(bytes: Uint8Array): Promise<string | null> {
  try {
    const { data } = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "none" })
      .removeAlpha()
      .greyscale()
      // 9 wide so there are 8 horizontal comparisons per row.
      .resize(9, 8, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let bits = 0n;
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const left = data[row * 9 + col]!;
        const right = data[row * 9 + col + 1]!;
        bits = (bits << 1n) | (left > right ? 1n : 0n);
      }
    }
    return bits.toString(16).padStart(16, "0");
  } catch {
    // A perceptual hash is an optimisation, not a requirement. A file we
    // cannot hash is still stored; it just will not participate in
    // near-duplicate detection.
    return null;
  }
}

/** Bit distance between two dHashes. 0 is identical; under ~10 is "very similar". */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    if (diff & 1n) count += 1;
    diff >>= 1n;
  }
  return count;
}

/**
 * Distance at or below which two images are treated as near-duplicates.
 *
 * 6 of 64 bits. Chosen conservatively: this only *flags* a suspected duplicate
 * for a reviewer (§11 pairs dedupe with versioning, not deletion), so a false
 * positive costs one glance and a false negative costs a redundant record.
 */
export const NEAR_DUPLICATE_THRESHOLD = 6;

export function isNearDuplicate(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return hammingDistance(a, b) <= NEAR_DUPLICATE_THRESHOLD;
}

// --- Derivatives ----------------------------------------------------------

export interface GeneratedDerivative {
  readonly kind: MediaDerivativeKind;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly extension: string;
}

/**
 * Generate the renditions a page is actually displayed from.
 *
 * Two geometries, because the renditions have two jobs (see
 * `DERIVATIVE_SPECS`):
 *
 *   `card`  `fit: "cover"` from `position: "top"`. Every card comes out the
 *           same shape, and what survives the crop is the top of the page,
 *           which is the part a person recognises a site by.
 *
 *   `full`  Width is held and height follows. A tall page stays legible
 *           instead of being squashed into a sliver to satisfy a height
 *           bound, which is what the previous single strategy did.
 *
 * The one bound `full` cannot escape is the encoder's: WebP tops out at 16,383
 * pixels. Past that the image is cropped from the top rather than scaled down
 * to fit, and the crop is logged — a silently truncated research image is
 * worse than a short one, because nothing about the file says the footer is
 * missing.
 */
export async function generateDerivatives(
  bytes: Uint8Array,
  input: { mimeType: string; width: number | null; height: number | null; logger?: Logger },
): Promise<GeneratedDerivative[]> {
  const format = mediaFormatFor(input.mimeType);
  if (!format?.canDeriveThumbnails) return [];

  const out: GeneratedDerivative[] = [];
  /** Widths already produced, so two specs cannot emit the same image twice. */
  const emittedWidths = new Set<number>();

  for (const spec of DERIVATIVE_SPECS) {
    // The width this rendition will really have: never enlarged past the
    // original, which is why a 780px-wide mobile capture yields the same
    // width for `preview` (1024) and `large` (2048).
    const targetWidth =
      input.width !== null ? Math.min(spec.width, input.width) : spec.width;

    if (spec.purpose === "full") {
      // A second identical rendition is pure storage cost. `preview` is
      // generated first, so it is `large` that drops out for narrow sources.
      if (emittedWidths.has(targetWidth)) {
        input.logger?.debug("Skipping a duplicate rendition", { kind: spec.kind, targetWidth });
        continue;
      }
      // Nothing further to skip. An earlier version also dropped `large`
      // whenever the source was narrower than 2048, which was too broad: a
      // 1170px mobile capture has a 1024px `preview` and a 1170px `large`,
      // and those are different images. `emittedWidths` above is the only
      // check needed — it drops a rendition exactly when it would duplicate
      // one already produced.
    }

    try {
      const pipeline = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "none" })
        .rotate(); // Honour EXIF orientation before resizing.

      if (spec.purpose === "card") {
        // Uniform card shape, anchored at the top of the page. Scaled down to
        // the card target where the source allows it and cropped at the
        // source's own scale where it does not — a 64px source becomes a
        // small 16:10 crop, never a blurry 480px enlargement of one.
        const cardWidth = input.width !== null ? Math.min(spec.width, input.width) : spec.width;
        const cardHeight = Math.max(
          1,
          Math.round((spec.cropHeight ?? spec.width) * (cardWidth / spec.width)),
        );
        pipeline.resize({
          width: cardWidth,
          height: input.height !== null ? Math.min(cardHeight, input.height) : cardHeight,
          fit: "cover",
          position: "top",
          withoutEnlargement: true,
        });
      } else {
        pipeline.resize({ width: targetWidth, withoutEnlargement: true });

        // Height after the width resize. Beyond the encoder's limit the image
        // is cropped from the top; `extractTop` is applied after the resize so
        // the crop is measured in output pixels.
        const projectedHeight =
          input.width !== null && input.height !== null
            ? Math.round(input.height * (targetWidth / input.width))
            : null;
        if (projectedHeight !== null && projectedHeight > MAX_WEBP_DIMENSION) {
          pipeline.extract({
            left: 0,
            top: 0,
            width: targetWidth,
            height: MAX_WEBP_DIMENSION,
          });
          input.logger?.warn("Cropped a rendition at the encoder's height limit", {
            kind: spec.kind,
            width: targetWidth,
            keptHeight: MAX_WEBP_DIMENSION,
            wouldHaveBeen: projectedHeight,
          });
        }
      }

      const encoded =
        spec.format === "webp"
          ? pipeline.webp({ quality: spec.quality, effort: 4 })
          : pipeline.jpeg({ quality: spec.quality, mozjpeg: true });

      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      out.push({
        kind: spec.kind,
        bytes: data,
        mimeType: spec.format === "webp" ? "image/webp" : "image/jpeg",
        width: info.width,
        height: info.height,
        byteSize: data.byteLength,
        extension: spec.format === "webp" ? "webp" : "jpg",
      });
      if (spec.purpose === "full") emittedWidths.add(info.width);
    } catch (error) {
      // One failed rendition should not fail the upload — the original is
      // already stored and usable.
      input.logger?.warn("Derivative generation failed", { kind: spec.kind, error });
    }
  }
  return out;
}

/** Dominant colour, for placeholder backgrounds in the media grid. */
export async function dominantColor(bytes: Uint8Array): Promise<string | null> {
  try {
    const { dominant } = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "none" })
      .stats();
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  } catch {
    return null;
  }
}

/**
 * Read a stream into memory with a hard ceiling.
 *
 * Used by the upload route. Enforcing the limit *while* buffering is the point:
 * checking `Content-Length` is not enough, because it is a client claim, and a
 * chunked upload has none at all.
 */
export async function readStreamWithLimit(
  stream: Readable | ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;

  const iterable =
    stream instanceof Readable
      ? stream
      : (Readable.fromWeb(stream as import("node:stream/web").ReadableStream<Uint8Array>) as Readable);

  for await (const chunk of iterable) {
    const buf = Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      // Destroy the source so a hostile client cannot keep the socket open
      // streaming bytes we are discarding.
      if (iterable instanceof Readable) iterable.destroy();
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, "That file is too large.", {
        detail: `exceeded ${maxBytes} bytes`,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
