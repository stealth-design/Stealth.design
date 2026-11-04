/**
 * Hashing.
 *
 * `sha256Hex` serves three jobs that all need the same stable hex digest:
 * media file dedupe (§11), URL dedupe, and content-change detection between
 * captures (§12).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Digest a stream without buffering the whole body in memory. */
export async function sha256Stream(stream: Readable): Promise<{ hex: string; byteSize: number }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of stream) {
    const buf = chunk as Uint8Array;
    byteSize += buf.byteLength;
    hash.update(buf);
  }
  return { hex: hash.digest("hex"), byteSize };
}

export function hmacSha256Hex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/**
 * Constant-time comparison of two hex strings. Used for session and worker
 * token lookups, where a length-or-content timing signal would leak the token.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Content hash for change detection between two captures of the same page.
 * Text is normalised first so whitespace churn and CRLF differences do not
 * register as a content change.
 */
export function contentHash(parts: readonly (string | null | undefined)[]): string {
  const normalized = parts
    .map((p) => (p ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim())
    .join(" ");
  return sha256Hex(normalized);
}
