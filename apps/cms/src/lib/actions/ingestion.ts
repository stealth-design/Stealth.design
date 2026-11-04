"use server";

/**
 * Ingestion server actions (§4, §5).
 *
 * These are thin: each one asserts a permission, calls the corresponding
 * service in `@uxd/api`, and translates an `AppError` into a message the form
 * can render. The actual work — URL validation, job creation, queueing — lives
 * in the service, which the HTTP admin API also calls.
 */
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
// Job-control primitives live with the queue they operate on, in
// @uxd/database; the ingestion *services* live in @uxd/api.
import {
  cancelJob,
  pauseJob,
  recomputeJobCounters,
  resumeJob,
  retryItems,
} from "@uxd/database";
import {
  type ValidationSummary,
  createIngestionJob,
  fetchSitemapUrls,
  recordAudit,
  startJob,
  validateUrlBatch,
} from "@uxd/api";
import { requirePermission } from "@uxd/auth";
import { AppError, splitPastedUrls } from "@uxd/shared";
import { crawlJobConfigSchema, defaultJobConfig, estimateMaxItems } from "@uxd/types";
import { getAdminContext, getAdminContextWith } from "@/lib/server";

export interface ValidateState {
  readonly summary: ValidationSummary | null;
  readonly error: string | null;
  /** Echoed back so the textarea keeps its content across the round trip. */
  readonly raw: string;
  readonly sitemapNote: string | null;
}

export const EMPTY_VALIDATE_STATE: ValidateState = {
  summary: null,
  error: null,
  raw: "",
  sitemapNote: null,
};

/**
 * Validate what an operator pasted (§5, step 2).
 *
 * Runs before any job exists and fetches nothing except, optionally, a sitemap
 * and a reachability pre-flight. The result is the six-bucket breakdown the
 * review screen shows, so the decision about what to include is made with the
 * counts visible.
 */
export async function validateUrlsAction(
  _previous: ValidateState,
  formData: FormData,
): Promise<ValidateState> {
  const context = await getAdminContext();
  requirePermission(context.actor, "ingestion.create");

  const pasted = String(formData.get("urls") ?? "");
  const sitemapUrl = String(formData.get("sitemapUrl") ?? "").trim();
  const checkReachability = formData.get("checkReachability") === "on";

  let urls = splitPastedUrls(pasted);
  let sitemapNote: string | null = null;

  // A sitemap is just another way to supply the list; it is expanded here so
  // the operator reviews the resulting URLs like any other paste.
  if (sitemapUrl.length > 0) {
    const sitemap = await fetchSitemapUrls(sitemapUrl, {
      userAgent: "uxdisrupt-research/0.1",
      maxUrls: 2_000,
    });
    if (sitemap.error) {
      return {
        summary: null,
        error: `Could not read that sitemap: ${sitemap.error}`,
        raw: pasted,
        sitemapNote: null,
      };
    }
    urls = [...urls, ...sitemap.urls];
    sitemapNote = `Found ${sitemap.urls.length.toLocaleString("en-US")} URLs in the sitemap${
      sitemap.nestedFollowed > 0 ? ` (across ${sitemap.nestedFollowed + 1} sitemap files)` : ""
    }${sitemap.truncated ? ", truncated to the first 2,000" : ""}.`;
  }

  if (urls.length === 0) {
    return {
      summary: null,
      error: "Paste at least one URL, or give a sitemap address.",
      raw: pasted,
      sitemapNote,
    };
  }

  try {
    const settings = await loadBlockedDomains(context);
    const summary = await validateUrlBatch(context.db, urls, {
      checkReachability,
      blockedDomains: settings,
      userAgent: "uxdisrupt-research/0.1",
    });
    return { summary, error: null, raw: pasted, sitemapNote };
  } catch (error) {
    return {
      summary: null,
      error: AppError.is(error) ? error.publicMessage : "Could not validate those URLs.",
      raw: pasted,
      sitemapNote,
    };
  }
}

/** The operator-managed blocklist from settings (§37: nothing hardcoded). */
async function loadBlockedDomains(context: Awaited<ReturnType<typeof getAdminContext>>) {
  const { settings } = await import("@uxd/database");
  const { eq } = await import("drizzle-orm");
  const [row] = await context.db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "ingestion.blockedDomains"))
    .limit(1);
  return Array.isArray(row?.value) ? (row.value as string[]) : [];
}

export interface CreateJobState {
  readonly error: string | null;
  readonly issues: readonly { path: string; message: string }[];
}

export const EMPTY_CREATE_STATE: CreateJobState = { error: null, issues: [] };

/**
 * Create the job (§5, steps 3 and 4).
 *
 * The validation summary is re-submitted with the form and re-checked by the
 * service: a crafted request cannot include a URL that validation marked
 * `blocked` or `invalid`, because `createIngestionJob` filters those out
 * server side regardless of what the checkboxes claim.
 */
export async function createJobAction(
  _previous: CreateJobState,
  formData: FormData,
): Promise<CreateJobState> {
  const context = await getAdminContextWith("ingestion.create");

  const serialised = String(formData.get("validation") ?? "");
  let validation: ValidationSummary;
  try {
    validation = JSON.parse(serialised) as ValidationSummary;
    if (!Array.isArray(validation.rows)) throw new Error("bad shape");
  } catch {
    return {
      error: "The validation result was lost. Validate the URLs again before starting a job.",
      issues: [],
    };
  }

  // Which lines the operator ticked. Absent means "use the default for its
  // bucket", which is what the checkboxes were pre-set to.
  const includeOverrides: Record<number, boolean> = {};
  for (const row of validation.rows) {
    const field = formData.get(`include-${row.lineNumber}`);
    if (field !== null) includeOverrides[row.lineNumber] = field === "on";
    else if (formData.has(`present-${row.lineNumber}`)) includeOverrides[row.lineNumber] = false;
  }

  const numberField = (name: string, fallback: number): number => {
    const value = formData.get(name);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const boolField = (name: string): boolean => formData.get(name) === "on";

  const defaults = defaultJobConfig();
  const rawConfig = {
    module: "web",
    maxCaptureLevel: numberField("maxCaptureLevel", defaults.maxCaptureLevel),
    capturePreview: boolField("capturePreview"),
    previewProfile: String(formData.get("previewProfile") ?? defaults.previewProfile),
    crawlInternalLinks: boolField("crawlInternalLinks"),
    maxDepth: numberField("maxDepth", defaults.maxDepth),
    maxPagesPerDomain: numberField("maxPagesPerDomain", defaults.maxPagesPerDomain),
    maxPagesTotal: numberField("maxPagesTotal", defaults.maxPagesTotal),
    restrictToSubmittedDomains: boolField("restrictToSubmittedDomains"),
    includeSubdomains: boolField("includeSubdomains"),
    respectRobots: boolField("respectRobots"),
    robotsOverrideReason: String(formData.get("robotsOverrideReason") ?? "").trim() || undefined,
    requestsPerMinutePerDomain: numberField(
      "requestsPerMinutePerDomain",
      defaults.requestsPerMinutePerDomain,
    ),
    navigationTimeoutMs: numberField("navigationTimeoutMs", defaults.navigationTimeoutMs),
    maxAttempts: numberField("maxAttempts", defaults.maxAttempts),
    priority: String(formData.get("priority") ?? "normal"),
    excludeUrlPatterns: String(formData.get("excludeUrlPatterns") ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50),
  };

  const parsed = crawlJobConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return {
      error: "That configuration is not valid.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  let jobId: string;
  try {
    const result = await createIngestionJob(context, {
      name: String(formData.get("name") ?? "").trim(),
      config: parsed.data,
      validation,
      includeOverrides,
      notes: String(formData.get("notes") ?? "").trim() || null,
      startNow: formData.get("startNow") !== "off",
    });
    jobId = result.jobId;
  } catch (error) {
    if (AppError.is(error)) {
      return { error: error.publicMessage, issues: error.issues ?? [] };
    }
    return { error: "Could not create the job.", issues: [] };
  }

  redirect(`/crawl-jobs/${jobId}`);
}

/** Estimate the ceiling, for the "this job could capture up to N pages" line. */
export async function estimateJobSizeAction(
  configJson: string,
  submittedCount: number,
): Promise<number> {
  const parsed = crawlJobConfigSchema.safeParse(JSON.parse(configJson));
  if (!parsed.success) return submittedCount;
  return estimateMaxItems(parsed.data, submittedCount);
}

// --- Job control (§6) -----------------------------------------------------

export interface JobActionState {
  readonly error: string | null;
  readonly message: string | null;
}

export const EMPTY_JOB_ACTION_STATE: JobActionState = { error: null, message: null };

export async function startJobAction(jobId: string): Promise<JobActionState> {
  try {
    const context = await getAdminContextWith("ingestion.control");
    await startJob(context, jobId);
    refresh();
    return { error: null, message: "Job started." };
  } catch (error) {
    return { error: AppError.is(error) ? error.publicMessage : "Could not start the job.", message: null };
  }
}

export async function pauseJobAction(jobId: string): Promise<JobActionState> {
  try {
    const context = await getAdminContextWith("ingestion.control");
    const paused = await pauseJob(context.db, jobId, context.actor.name);
    if (paused) {
      await recordAudit(context.db, context, {
        action: "crawl.job_paused",
        entityType: "crawl_job",
        entityId: jobId,
      });
    }
    refresh();
    return {
      error: null,
      message: paused
        ? "Paused. No new URLs will be handed out; anything already capturing will finish."
        : "That job was not running.",
    };
  } catch (error) {
    return { error: AppError.is(error) ? error.publicMessage : "Could not pause the job.", message: null };
  }
}

export async function resumeJobAction(jobId: string): Promise<JobActionState> {
  try {
    const context = await getAdminContextWith("ingestion.control");
    const resumed = await resumeJob(context.db, jobId, context.actor.name);
    if (resumed) {
      await recordAudit(context.db, context, {
        action: "crawl.job_resumed",
        entityType: "crawl_job",
        entityId: jobId,
      });
    }
    refresh();
    return { error: null, message: resumed ? "Resumed." : "That job was not paused." };
  } catch (error) {
    return { error: AppError.is(error) ? error.publicMessage : "Could not resume the job.", message: null };
  }
}

export async function cancelJobAction(jobId: string): Promise<JobActionState> {
  try {
    const context = await getAdminContextWith("ingestion.control");
    const result = await cancelJob(context.db, jobId, context.actor.name);
    refresh();
    return {
      error: null,
      message:
        result.inFlight > 0
          ? `Cancelled ${result.cancelled} queued URLs. ${result.inFlight} still capturing will finish first — everything already captured is kept.`
          : `Cancelled ${result.cancelled} queued URLs. Everything already captured is kept.`,
    };
  } catch (error) {
    return { error: AppError.is(error) ? error.publicMessage : "Could not cancel the job.", message: null };
  }
}

export async function retryJobItemsAction(
  jobId: string,
  itemIds?: readonly string[],
): Promise<JobActionState> {
  try {
    const context = await getAdminContextWith("ingestion.retry");
    const count = await retryItems(context.db, {
      jobId,
      itemIds,
      actorLabel: context.actor.name,
    });
    await recordAudit(context.db, context, {
      action: "crawl.items_retried",
      entityType: "crawl_job",
      entityId: jobId,
      context: { count, selected: itemIds?.length ?? null },
    });
    refresh();
    return {
      error: null,
      message:
        count === 0
          ? "Nothing to retry."
          : `Requeued ${count} URL${count === 1 ? "" : "s"}. Their attempt counters were reset.`,
    };
  } catch (error) {
    return { error: AppError.is(error) ? error.publicMessage : "Could not retry those items.", message: null };
  }
}

/** Repair drifted counters, exposed as a button rather than hidden in a script. */
export async function recomputeCountersAction(jobId: string): Promise<JobActionState> {
  try {
    const context = await getAdminContextWith("ingestion.control");
    await recomputeJobCounters(context.db, jobId);
    refresh();
    return { error: null, message: "Counters recomputed from the job's items." };
  } catch (error) {
    return { error: AppError.is(error) ? error.publicMessage : "Could not recompute.", message: null };
  }
}
