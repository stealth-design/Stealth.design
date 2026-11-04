/**
 * Operator-editable settings (§37: "No hardcoded taxonomy. No hardcoded URLs").
 *
 * The values here are the ones that would otherwise be constants in code but
 * genuinely belong to whoever runs the system: how hard to crawl, which query
 * parameters to strip when normalising a URL, how confident a classifier must
 * be before its suggestion is worth showing, which domains never to touch.
 *
 * ## Why a registry rather than a free-form key/value store
 *
 * `settings.value` is `jsonb`, so without a schema per key a typo could put
 * `"twenty"` where a worker expects a number and the failure would surface much
 * later, in the worker, as something unrelated. Each key therefore declares:
 *
 *   - a Zod schema, validated on write, so a bad value is refused at the
 *     boundary rather than stored;
 *   - a default, so an unset key is not an error and a fresh install works;
 *   - a description, shown as help text on the Settings screen;
 *   - `sensitive`, for values that must not appear in an audit diff.
 *
 * ## The floor that cannot be lowered
 *
 * `classification.minAutoApplyConfidence` has a hard lower bound of
 * `ABSOLUTE_MIN_AUTO_APPLY_CONFIDENCE`, enforced by the schema rather than by
 * the UI. §14 requires that low-confidence classifications are never applied
 * automatically, and a setting that could be dialled to zero would make that
 * requirement a suggestion. Operators can raise the floor; they cannot remove
 * it.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requirePermission } from "@uxd/auth";
import { type Db, settings } from "@uxd/database";
import { AppError, DEFAULT_TRACKING_PARAMS, ErrorCode, notFound } from "@uxd/shared";
import {
  ABSOLUTE_MIN_AUTO_APPLY_CONFIDENCE,
  DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
  JOB_DEFAULTS,
  JOB_LIMITS,
} from "@uxd/types";
import { recordAudit } from "../audit.js";
import { type AdminContext, inTransaction } from "../context.js";

/** A hostname or domain suffix. Deliberately not a URL. */
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "A domain contains only letters, digits, dots and hyphens.");

export interface SettingDefinition<T> {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Which Settings panel this belongs under. */
  readonly group: "crawl" | "urls" | "classification" | "retention" | "publishing";
  readonly schema: z.ZodType<T>;
  readonly default: T;
  /** Excluded from audit diffs and from any response body. */
  readonly sensitive?: boolean;
}

/**
 * The setting registry.
 *
 * Adding a key here is the whole change: the Settings screen renders from this,
 * the validation comes from the schema, and `getSetting` starts returning the
 * default immediately without a migration (the row is created on first write).
 */
export const SETTING_DEFINITIONS = [
  // --- Crawl -------------------------------------------------------------
  {
    key: "crawl.requestsPerMinutePerDomain",
    label: "Requests per minute, per domain",
    description:
      "The default politeness ceiling for a new job. A job may lower this but not raise it above the hard limit.",
    group: "crawl",
    schema: z.number().int().min(1).max(JOB_LIMITS.maxRequestsPerMinutePerDomain),
    default: JOB_DEFAULTS.requestsPerMinutePerDomain,
  } satisfies SettingDefinition<number>,
  {
    key: "crawl.maxPagesPerDomain",
    label: "Maximum pages per domain",
    description: "Default ceiling on how many pages one job may capture from a single domain.",
    group: "crawl",
    schema: z.number().int().min(1).max(JOB_LIMITS.maxPagesPerDomain),
    default: JOB_DEFAULTS.maxPagesPerDomain,
  } satisfies SettingDefinition<number>,
  {
    key: "crawl.maxDepth",
    label: "Maximum crawl depth",
    description:
      "How many links deep a job may follow by default. Zero means capture exactly the URLs submitted and discover nothing.",
    group: "crawl",
    schema: z.number().int().min(0).max(JOB_LIMITS.maxDepth),
    default: JOB_DEFAULTS.maxDepth,
  } satisfies SettingDefinition<number>,
  {
    key: "crawl.blockedDomains",
    label: "Never crawl these domains",
    description:
      "An operator blocklist, applied during URL validation on top of the built-in private-address rules. A suffix match, so blocking example.com also blocks www.example.com.",
    group: "crawl",
    schema: z.array(hostname).max(1_000),
    default: [] as string[],
  } satisfies SettingDefinition<string[]>,
  {
    key: "crawl.userAgent",
    label: "User agent",
    description:
      "How the capture worker identifies itself. Include a contact address so a site owner who notices us can reach someone.",
    group: "crawl",
    schema: z.string().trim().min(8).max(200),
    default: "uxdisrupt-research/0.1",
  } satisfies SettingDefinition<string>,

  // --- URL normalisation -------------------------------------------------
  {
    key: "urls.trackingParams",
    label: "Query parameters to strip",
    description:
      "Removed when normalising a URL, so the same page arriving with different campaign tags is recognised as one page rather than several.",
    group: "urls",
    schema: z.array(z.string().trim().toLowerCase().min(1).max(100)).max(500),
    default: [...DEFAULT_TRACKING_PARAMS],
  } satisfies SettingDefinition<string[]>,

  // --- Classification ----------------------------------------------------
  {
    key: "classification.minAutoApplyConfidence",
    label: "Confidence floor for auto-applying a suggestion",
    description:
      "Below this, a suggestion is always left for a person. It can be raised but not lowered past the hard floor, because §14 requires that low-confidence classifications are never applied automatically.",
    group: "classification",
    schema: z.number().min(ABSOLUTE_MIN_AUTO_APPLY_CONFIDENCE).max(1),
    default: DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
  } satisfies SettingDefinition<number>,
  {
    key: "classification.autoApply",
    label: "Auto-apply high-confidence suggestions",
    description:
      "When off, every machine suggestion waits for a person regardless of confidence. Off by default: humans are the final authority on classification.",
    group: "classification",
    schema: z.boolean(),
    default: false,
  } satisfies SettingDefinition<boolean>,

  // --- Publishing --------------------------------------------------------
  {
    key: "publishing.requireRightsCleared",
    label: "Require a non-blocking rights status to publish",
    description:
      "The publish gate always refuses restricted, removed and do-not-republish. This additionally refuses anything still marked unknown.",
    group: "publishing",
    schema: z.boolean(),
    default: false,
  } satisfies SettingDefinition<boolean>,

  // --- Retention ---------------------------------------------------------
  {
    key: "retention.jobLogDays",
    label: "Keep job logs for",
    description:
      "Days to retain per-job event logs. The jobs themselves and their per-URL outcomes are kept regardless.",
    group: "retention",
    schema: z.number().int().min(7).max(3_650),
    default: 90,
  } satisfies SettingDefinition<number>,
  {
    key: "retention.captureBodyDays",
    label: "Keep raw captured HTML for",
    description:
      "Days to retain the raw HTML of a capture. Extracted text, screenshots and metadata are kept regardless; this only bounds the untrusted source document.",
    group: "retention",
    schema: z.number().int().min(1).max(3_650),
    default: 30,
  } satisfies SettingDefinition<number>,
] as const;

export type SettingKey = (typeof SETTING_DEFINITIONS)[number]["key"];

/**
 * The same registry, typed uniformly.
 *
 * `SETTING_DEFINITIONS` is `as const` so that `SettingKey` is a union of the
 * actual keys rather than `string`, but that also makes its element type a
 * union of eleven distinct object shapes — so an optional field no entry
 * currently sets, like `sensitive`, is absent from the union and unreadable.
 * This view is what the functions below iterate.
 */
const DEFINITIONS: readonly SettingDefinition<unknown>[] =
  SETTING_DEFINITIONS as readonly SettingDefinition<unknown>[];

const BY_KEY = new Map<string, SettingDefinition<unknown>>(
  DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function settingDefinition(key: string): SettingDefinition<unknown> {
  const definition = BY_KEY.get(key);
  if (!definition) throw notFound("Setting");
  return definition;
}

/** Every setting, grouped for the Settings screen, with its current value. */
export async function listSettings(db: Db) {
  const rows = await db
    .select({
      key: settings.key,
      value: settings.value,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .orderBy(asc(settings.key));

  const stored = new Map(rows.map((row) => [row.key, row]));

  return DEFINITIONS.map((definition) => {
    const row = stored.get(definition.key);
    // A stored value that no longer satisfies its schema — because the schema
    // tightened — falls back to the default rather than being handed to a
    // worker. Reported as `invalid` so the screen can say so instead of
    // silently showing the default as if it were the stored value.
    const parsed = row ? definition.schema.safeParse(row.value) : null;
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      group: definition.group,
      isDefault: row === undefined || parsed?.success !== true,
      invalid: row !== undefined && parsed?.success === false,
      value: definition.sensitive
        ? null
        : ((parsed?.success ? parsed.data : definition.default) as unknown),
      defaultValue: definition.sensitive ? null : (definition.default as unknown),
      sensitive: definition.sensitive === true,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

/**
 * One setting's effective value.
 *
 * Never throws for an unset or invalid key: it returns the registered default,
 * because a capture worker mid-job is the wrong place to discover that a
 * setting row is malformed. The Settings screen is where that is surfaced.
 */
export async function getSetting<T>(db: Db, key: string, fallback?: T): Promise<T> {
  const definition = BY_KEY.get(key);
  if (!definition) {
    if (fallback !== undefined) return fallback;
    throw notFound("Setting");
  }
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  if (!row) return definition.default as T;
  const parsed = definition.schema.safeParse(row.value);
  return (parsed.success ? parsed.data : definition.default) as T;
}

/** Several settings in one round trip, for a worker or a job builder. */
export async function getSettings(
  db: Db,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const known = keys.filter((key) => BY_KEY.has(key));
  const rows =
    known.length > 0
      ? await db
          .select({ key: settings.key, value: settings.value })
          .from(settings)
          .where(inArray(settings.key, [...known]))
      : [];
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const result: Record<string, unknown> = {};
  for (const key of known) {
    const definition = BY_KEY.get(key)!;
    const raw = stored.get(key);
    const parsed = raw === undefined ? null : definition.schema.safeParse(raw);
    result[key] = parsed?.success ? parsed.data : definition.default;
  }
  return result;
}

export async function updateSetting(
  context: AdminContext,
  key: string,
  value: unknown,
): Promise<void> {
  requirePermission(context.actor, "settings.update");
  const definition = settingDefinition(key);

  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "That value is not allowed for this setting.", {
      issues: parsed.error.issues.map((issue) => ({
        path: [key, ...issue.path.map(String)].join("."),
        message: issue.message,
      })),
    });
  }

  await inTransaction(context, async (tx) => {
    const [before] = await tx.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    await tx.db
      .insert(settings)
      .values({
        key,
        value: parsed.data as never,
        description: definition.description,
        updatedBy: context.actor.id,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: parsed.data as never,
          description: definition.description,
          updatedBy: context.actor.id,
          updatedAt: new Date(),
        },
      });

    await recordAudit(tx.db, context, {
      action: "setting.updated",
      entityType: "setting",
      entityId: null,
      entityLabel: definition.label,
      // A sensitive setting records that it changed, never to what.
      before: definition.sensitive
        ? { key, redacted: true }
        : { key, value: before?.value ?? definition.default },
      after: definition.sensitive ? { key, redacted: true } : { key, value: parsed.data },
    });
  });
}

/** Reset a setting to its registered default by deleting the stored row. */
export async function resetSetting(context: AdminContext, key: string): Promise<void> {
  requirePermission(context.actor, "settings.update");
  const definition = settingDefinition(key);

  await inTransaction(context, async (tx) => {
    const [before] = await tx.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    if (!before) return;

    await tx.db.delete(settings).where(eq(settings.key, key));

    await recordAudit(tx.db, context, {
      action: "setting.updated",
      entityType: "setting",
      entityId: null,
      entityLabel: definition.label,
      before: definition.sensitive ? { key, redacted: true } : { key, value: before.value },
      after: { key, reset: true },
    });
  });
}

/**
 * The crawl-facing settings, in the shape `validateUrlBatch` and the job
 * builder expect.
 *
 * A single call so a caller cannot pick up the blocklist and forget the user
 * agent, which is the kind of omission that is invisible until a site owner
 * complains.
 */
export async function getCrawlSettings(db: Db): Promise<{
  blockedDomains: readonly string[];
  userAgent: string;
  requestsPerMinutePerDomain: number;
  maxPagesPerDomain: number;
  maxDepth: number;
}> {
  const values = await getSettings(db, [
    "crawl.blockedDomains",
    "crawl.userAgent",
    "crawl.requestsPerMinutePerDomain",
    "crawl.maxPagesPerDomain",
    "crawl.maxDepth",
  ]);
  return {
    blockedDomains: values["crawl.blockedDomains"] as string[],
    userAgent: values["crawl.userAgent"] as string,
    requestsPerMinutePerDomain: values["crawl.requestsPerMinutePerDomain"] as number,
    maxPagesPerDomain: values["crawl.maxPagesPerDomain"] as number,
    maxDepth: values["crawl.maxDepth"] as number,
  };
}
