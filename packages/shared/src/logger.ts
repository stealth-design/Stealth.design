/**
 * Structured logger.
 *
 * Emits one JSON object per line to stdout/stderr — parseable by any log
 * shipper — or a compact human format when UXD_LOG_FORMAT=pretty (local dev).
 * All payloads pass through `redact()` first.
 *
 * `child()` binds correlation fields (requestId, jobId, itemId, actorId) so
 * every line produced by one crawl item can be pulled out of the stream.
 */
import { redact } from "./redact.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  /** Time an async operation and log its duration + outcome. */
  time<T>(message: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly service: string;
  readonly format?: "json" | "pretty";
  readonly bindings?: LogFields;
  readonly write?: (line: string, level: LogLevel) => void;
}

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const PRETTY_COLOR: Record<LogLevel, string> = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
};

function defaultWrite(line: string, level: LogLevel): void {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "json";
  const write = options.write ?? defaultWrite;
  const minWeight = LEVEL_WEIGHT[level];

  const build = (bindings: LogFields): Logger => {
    const emit = (lvl: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_WEIGHT[lvl] < minWeight) return;
      const payload = redact({ ...bindings, ...fields }) as Record<string, unknown>;
      if (format === "pretty") {
        const extra = Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : "";
        write(
          `${PRETTY_COLOR[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET} [${options.service}] ${message}${extra}`,
          lvl,
        );
        return;
      }
      write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: lvl,
          service: options.service,
          message,
          ...payload,
        }),
        lvl,
      );
    };

    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (extra) => build({ ...bindings, ...extra }),
      async time(message, fn, fields) {
        const start = performance.now();
        try {
          const result = await fn();
          emit("info", message, {
            ...fields,
            durationMs: Math.round(performance.now() - start),
            outcome: "ok",
          });
          return result;
        } catch (error) {
          emit("error", message, {
            ...fields,
            durationMs: Math.round(performance.now() - start),
            outcome: "error",
            error,
          });
          throw error;
        }
      },
    };
  };

  return build(options.bindings ?? {});
}

/** A logger that discards everything — for tests. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
  async time(_m, fn) {
    return fn();
  },
};
