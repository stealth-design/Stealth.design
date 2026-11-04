/**
 * Password hashing.
 *
 * scrypt from `node:crypto`, chosen over argon2/bcrypt because it needs no
 * native module. A native dependency in the CMS means a compiler in the
 * production image and a rebuild on every Node upgrade; scrypt is memory-hard,
 * in the standard library, and entirely sufficient for a small internal team's
 * credentials.
 *
 * Parameters are stored in the hash string, so raising them later re-hashes
 * users transparently on their next sign-in rather than invalidating everyone.
 */
import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Promisified scrypt.
 *
 * Hand-wrapped rather than `promisify(scrypt)`, because promisify resolves to
 * the 3-argument overload and drops the options parameter — and the options are
 * where N, r, p and maxmem live, which is the entire point.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * N=2^16, r=8, p=1 — roughly 64MB and ~100ms per hash on current hardware.
 * `maxmem` must be raised explicitly, since Node's 32MB default rejects N this
 * large.
 */
const PARAMS = { N: 65_536, r: 8, p: 1, keyLength: 32, maxmem: 128 * 1024 * 1024 } as const;

const SALT_BYTES = 16;
const PREFIX = "scrypt";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export async function hashPassword(password: string): Promise<string> {
  assertHashable(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });
  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing for a malformed or missing hash, so an
 * invited user with no password set and a user with a corrupt hash both simply
 * fail to authenticate instead of producing a 500 that distinguishes them.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row: a huge N would be a
  // self-inflicted denial of service on every sign-in attempt.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(parts[5]!, "base64url");
    actual = await scryptAsync(
      password.normalize("NFKC"),
      Buffer.from(parts[4]!, "base64url"),
      expected.length,
      { N, r, p, maxmem: PARAMS.maxmem },
    );
  } catch {
    return false;
  }
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(expected, actual);
}

/** True when a stored hash used weaker parameters than we now use. */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

function assertHashable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // Long inputs are a cheap denial-of-service against a memory-hard KDF.
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

/** Password rules, returned to the UI so the form and the server agree. */
export const PASSWORD_RULES = {
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: MAX_PASSWORD_LENGTH,
  description: `At least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols — a passphrase is fine.`,
} as const;

export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  // Reject only the genuinely useless cases. Composition rules push people
  // toward "Password1!" and add no real strength.
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, message: "That is a single repeated character." };
  }
  return { ok: true };
}
