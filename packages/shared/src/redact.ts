/**
 * Redaction for structured logs.
 *
 * Applied to every log payload before serialisation. The crawler and CMS share
 * one logger, and the crawler handles hostile input, so this runs everywhere
 * rather than at selected call sites.
 */

const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|auth|cookie|session|credential|private[-_]?key|access[-_]?key|bearer|signature|dsn|connection[-_]?string|database[-_]?url)/i;

export const REDACTED = "[redacted]";

const MAX_DEPTH = 8;
const MAX_ARRAY = 50;
const MAX_STRING = 4096;

/** Strip credentials out of a URL-ish string without throwing on bad input. */
export function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return `${u.toString()} [credentials removed]`;
    }
    return u.toString();
  } catch {
    return value;
  }
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[max depth]";

  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[${s.length} chars]` : s;
  }
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return `[${t}]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack.split("\n").slice(0, 12).join("\n") } : {}),
      ...(value.cause !== undefined ? { cause: redact(value.cause, depth + 1) } : {}),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactUrl(value.toString());
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Map) return redact(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return redact([...value], depth + 1);

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…${value.length - MAX_ARRAY} more`] : head;
  }

  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = REDACTED;
      } else if (typeof v === "string" && /^https?:\/\//i.test(v)) {
        out[k] = redactUrl(v);
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
