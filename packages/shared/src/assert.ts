/** Assertions used at trust boundaries, where a violation is a programming
 * error rather than bad user input. */
import { internal } from "./errors.js";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw internal("Internal invariant violated", { detail: message });
}

export function assertDefined<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw internal("Internal invariant violated", { detail: `${name} was ${String(value)}` });
  }
  return value;
}

/** Exhaustiveness check for discriminated unions. */
export function assertNever(value: never, context = "value"): never {
  throw internal("Internal invariant violated", {
    detail: `Unhandled ${context}: ${JSON.stringify(value)}`,
  });
}
