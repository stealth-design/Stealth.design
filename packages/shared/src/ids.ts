/**
 * Identifiers.
 *
 * Primary keys are UUIDv7: RFC 9562 time-ordered UUIDs. They fit Postgres's
 * native `uuid` column, sort by creation time (so B-tree inserts stay local
 * and `order by id desc` is a valid "newest first"), and are safe to expose
 * because the low bits are random.
 */
import { randomBytes, randomUUID } from "node:crypto";

let lastMs = -1;
let counter = 0;

/**
 * RFC 9562 UUIDv7. Within a single millisecond a 12-bit counter keeps IDs
 * strictly increasing, so a bulk insert in one tick stays ordered.
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now === lastMs) {
    counter = (counter + 1) & 0x0fff;
    // Counter rollover inside one millisecond: reseed from randomness.
    if (counter === 0) counter = randomBytes(2).readUInt16BE(0) & 0x0fff;
  } else {
    lastMs = now;
    counter = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }

  const bytes = randomBytes(16);
  // 48-bit big-endian millisecond timestamp.
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // Version 7 in the high nibble of byte 6, then the 12-bit counter.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  // RFC 4122 variant (10xx) in the two high bits of byte 8.
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Extract the creation time from a UUIDv7. Returns null for other versions. */
export function uuidv7Time(id: string): Date | null {
  if (!UUID_RE.test(id)) return null;
  const hex = id.replace(/-/g, "");
  if (hex[12] !== "7") return null;
  return new Date(Number.parseInt(hex.slice(0, 12), 16));
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Short, URL-safe, unambiguous random token (Crockford base32, no I/L/O/U).
 * Used for lease tokens and job short-references — never as a primary key.
 */
export function shortId(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

/** Opaque high-entropy secret, hex encoded. Used for session and worker tokens. */
export function secretToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export { randomUUID };

// Unicode combining marks, stripped after NFKD so "Café" becomes "cafe".
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const SMART_QUOTES = /['\u2018\u2019\u201b]/g;

/**
 * URL/slug-safe identifier derived from human text. Not guaranteed unique —
 * callers pair it with a uniqueness check plus `dedupeSlug`.
 */
export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(SMART_QUOTES, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : `item-${shortId(6).toLowerCase()}`;
}

/** Append a numeric suffix until the slug is not in `taken`. */
export function dedupeSlug(base: string, taken: ReadonlySet<string>, maxLength = 80): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, maxLength - 7)}-${shortId(6).toLowerCase()}`;
}
