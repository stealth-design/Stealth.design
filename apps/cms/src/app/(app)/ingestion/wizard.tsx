"use client";

import { useActionState, useMemo, useState } from "react";
import clsx from "clsx";
import type { ValidationSummary } from "@uxd/api";
import {
  DEVICE_PROFILES,
  DEVICE_PROFILE_KEYS,
  JOB_DEFAULTS,
  JOB_LIMITS,
  URL_VALIDATION_OUTCOMES,
  URL_VALIDATION_OUTCOME_META,
  type UrlValidationOutcome,
} from "@uxd/types";
import { Badge, Button, EmptyState, Kbd, Note, Panel, type Tone } from "@/components/ui/primitives";
import {
  EMPTY_CREATE_STATE,
  EMPTY_VALIDATE_STATE,
  createJobAction,
  validateUrlsAction,
} from "@/lib/actions/ingestion";

/**
 * The bulk-ingestion wizard (§5).
 *
 * Three steps in one screen rather than three pages, so the paste stays
 * visible while its validation result is read and the configuration is chosen.
 * §5's flow is exactly this sequence, and the reason it is a sequence is that
 * each step's decision depends on the previous step's output.
 */
export function IngestionWizard() {
  const [validateState, validateAction, validating] = useActionState(
    validateUrlsAction,
    EMPTY_VALIDATE_STATE,
  );
  const [createState, createAction, creating] = useActionState(createJobAction, EMPTY_CREATE_STATE);

  const summary = validateState.summary;

  return (
    <div className="space-y-4">
      {/* --- Step 1: paste ------------------------------------------- */}
      <Panel
        title="1. Submit URLs"
        description="Paste them one per line, or separated by commas. A CSV column works too — anything that is not a URL is reported rather than silently dropped."
      >
        <form action={validateAction} className="space-y-3 p-3">
          <div>
            <label htmlFor="urls" className="sr-only">
              URLs
            </label>
            <textarea
              id="urls"
              name="urls"
              rows={8}
              defaultValue={validateState.raw}
              spellCheck={false}
              // Documentation domains rather than real products: `check:boundaries`
              // forbids hardcoded URLs and cannot tell placeholder copy from an
              // endpoint, and an exemption for illustrative text would be an
              // exemption anyone could widen. The shape is what matters here.
              placeholder={"https://example.com/pricing\nhttps://example.com/signup\nhttps://example.com/docs/getting-started"}
              className="mono w-full resize-y rounded-[4px] border border-ink-300 p-2 leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />
            <p className="mt-1 text-2xs text-ink-500">
              Up to {JOB_LIMITS.maxUrlsPerJob.toLocaleString("en-US")} URLs per job.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="sitemapUrl"
                className="block text-2xs font-medium uppercase tracking-wide text-ink-500"
              >
                Or import from a sitemap
              </label>
              <input
                id="sitemapUrl"
                name="sitemapUrl"
                type="url"
                placeholder="https://example.com/sitemap.xml"
                className="mono mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 outline-none focus:border-[var(--color-accent)]"
              />
              <p className="mt-1 text-2xs text-ink-500">
                Nested sitemap indexes are followed one level, capped at 2,000 URLs.
              </p>
            </div>

            <label className="flex items-start gap-2 pt-4 text-xs text-ink-700">
              <input type="checkbox" name="checkReachability" className="mt-0.5" />
              <span>
                Check that each host responds
                <span className="mt-0.5 block text-2xs text-ink-500">
                  Slower for a large paste, and a temporary blip shows as unreachable — but it
                  catches typos before a job runs.
                </span>
              </span>
            </label>
          </div>

          {validateState.error ? <Note tone="danger">{validateState.error}</Note> : null}
          {validateState.sitemapNote ? <Note tone="info">{validateState.sitemapNote}</Note> : null}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={validating}>
              {validating ? "Validating…" : "Validate URLs"}
            </Button>
            <span className="text-2xs text-ink-500">
              Nothing is fetched yet — this checks syntax, safety rules and what we already have.
            </span>
          </div>
        </form>
      </Panel>

      {/* --- Step 2 and 3: review and configure --------------------- */}
      {summary ? (
        <ReviewAndConfigure summary={summary} state={createState} action={createAction} pending={creating} />
      ) : (
        <Panel>
          <EmptyState
            title="Validation results will appear here"
            description="You will see how many URLs are valid, how many are already in the database, and anything that was refused — with the reason — before deciding what to capture."
          />
        </Panel>
      )}
    </div>
  );
}

const OUTCOME_TONE: Record<UrlValidationOutcome, Tone> = {
  valid: "success",
  invalid: "danger",
  duplicate_in_batch: "neutral",
  already_in_database: "warning",
  blocked: "danger",
  unreachable: "warning",
};

function ReviewAndConfigure({
  summary,
  state,
  action,
  pending,
}: {
  summary: ValidationSummary;
  state: typeof EMPTY_CREATE_STATE;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  const [filter, setFilter] = useState<UrlValidationOutcome | "all">("all");
  const [crawlLinks, setCrawlLinks] = useState(false);
  const [respectRobots, setRespectRobots] = useState(true);
  const [capturePreview, setCapturePreview] = useState(false);
  const [captureLevel, setCaptureLevel] = useState(1);
  const [maxDepth, setMaxDepth] = useState<number>(1);
  const [maxPagesTotal, setMaxPagesTotal] = useState<number>(JOB_DEFAULTS.maxPagesTotal);
  const [maxPagesPerDomain, setMaxPagesPerDomain] = useState<number>(JOB_DEFAULTS.maxPagesPerDomain);

  // Rows the operator can actually include. Blocked and invalid URLs are not
  // offered at all — the service refuses them regardless, so presenting a
  // checkbox would be a lie.
  const includable = summary.rows.filter(
    (row) => row.outcome !== "blocked" && row.outcome !== "invalid" && row.outcome !== "duplicate_in_batch",
  );
  const defaultIncluded = includable.filter((row) => row.included).length;

  const visible = useMemo(
    () => (filter === "all" ? summary.rows : summary.rows.filter((row) => row.outcome === filter)),
    [filter, summary.rows],
  );

  /**
   * The ceiling this configuration allows.
   *
   * §7 requires that a job cannot expand indefinitely, and this is the
   * operator-facing half of that: the bound is finite and visible *before*
   * anyone presses start.
   */
  const estimate = crawlLinks
    ? Math.min(maxPagesTotal, defaultIncluded * maxPagesPerDomain)
    : defaultIncluded;

  const issueFor = (path: string) => state.issues.find((issue) => issue.path === path)?.message;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="validation" value={JSON.stringify(summary)} />

      {/* --- Step 2: review ---------------------------------------- */}
      <Panel
        title="2. Review what was submitted"
        description={`${summary.totalSubmitted.toLocaleString("en-US")} submitted across ${summary.hostCount} ${summary.hostCount === 1 ? "domain" : "domains"}.`}
      >
        <div className="flex flex-wrap gap-1.5 border-b border-ink-100 p-3">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={clsx(
              "rounded-[3px] px-2 py-0.5 text-2xs font-medium",
              filter === "all" ? "bg-ink-800 text-ink-50" : "bg-ink-100 text-ink-600 hover:bg-ink-200",
            )}
          >
            All {summary.totalSubmitted}
          </button>
          {URL_VALIDATION_OUTCOMES.map((outcome) => {
            const count = summary.counts[outcome] ?? 0;
            if (count === 0) return null;
            const meta = URL_VALIDATION_OUTCOME_META[outcome];
            return (
              <button
                key={outcome}
                type="button"
                title={meta.description}
                onClick={() => setFilter(outcome)}
                className={clsx(
                  "rounded-[3px] px-2 py-0.5 text-2xs font-medium",
                  filter === outcome
                    ? "bg-ink-800 text-ink-50"
                    : "bg-ink-100 text-ink-600 hover:bg-ink-200",
                )}
              >
                {meta.label} {count}
              </button>
            );
          })}
        </div>

        {summary.truncated ? (
          <div className="p-3 pb-0">
            <Note tone="warning">
              More URLs were pasted than a single job accepts. Only the first{" "}
              {JOB_LIMITS.maxUrlsPerJob.toLocaleString("en-US")} are shown — submit the rest as a
              second job.
            </Note>
          </div>
        ) : null}

        <div className="max-h-96 overflow-y-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-10">
                  <span className="sr-only">Include</span>
                </th>
                <th className="w-12 text-right">#</th>
                <th>URL</th>
                <th className="w-40">Outcome</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const meta = URL_VALIDATION_OUTCOME_META[row.outcome];
                const selectable =
                  row.outcome !== "blocked" &&
                  row.outcome !== "invalid" &&
                  row.outcome !== "duplicate_in_batch";
                return (
                  <tr key={row.lineNumber}>
                    <td>
                      {selectable ? (
                        <>
                          <input
                            type="checkbox"
                            name={`include-${row.lineNumber}`}
                            defaultChecked={row.included}
                            aria-label={`Include ${row.rawUrl}`}
                          />
                          {/* Marks the row as present so an unticked box is
                              distinguishable from a row that was not rendered. */}
                          <input type="hidden" name={`present-${row.lineNumber}`} value="1" />
                        </>
                      ) : (
                        <span
                          className="block text-center text-ink-300"
                          title="This URL cannot be included."
                        >
                          —
                        </span>
                      )}
                    </td>
                    <td className="text-right text-2xs text-ink-400">{row.lineNumber}</td>
                    <td className="truncate-cell">
                      <span className="mono" title={row.rawUrl}>
                        {row.normalizedUrl ?? row.rawUrl}
                      </span>
                    </td>
                    <td>
                      <Badge tone={OUTCOME_TONE[row.outcome]} title={meta.description} dot>
                        {meta.label}
                      </Badge>
                    </td>
                    <td className="truncate-cell text-2xs text-ink-600" title={row.reasonMessage ?? ""}>
                      {row.reasonMessage ??
                        (row.outcome === "valid" ? "Ready to capture." : meta.description)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* --- Step 3: configure -------------------------------------- */}
      <Panel
        title="3. Configure the crawl"
        description="A crawl finds pages. It fills the discovery queue with candidates, and a person decides which of them become screens."
      >
        <div className="grid gap-4 p-3 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label htmlFor="name" className="block text-2xs font-medium uppercase tracking-wide text-ink-500">
                Job name
              </label>
              <input
                id="name"
                name="name"
                defaultValue={`Ingestion — ${new Date().toLocaleDateString("en-GB")}`}
                className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            <fieldset className="rounded-[4px] border border-ink-200 p-2">
              <legend className="px-1 text-2xs font-medium uppercase tracking-wide text-ink-500">
                How hard to look
              </legend>
              <Note tone="info">
                A crawl discovers URLs and nothing else. It never creates a screen and never
                publishes anything — screens are captured by hand in the studio, from the
                candidates this produces.
              </Note>
              <div className="mt-2 space-y-1.5">
                <Toggle
                  name="capturePreview"
                  label="Take a small preview thumbnail"
                  checked={capturePreview}
                  onChange={(value) => {
                    setCapturePreview(value);
                    // A thumbnail needs a browser, so turning it on raises the
                    // level rather than failing validation after the fact.
                    if (value) setCaptureLevel(2);
                  }}
                  hint="Needs a browser. Helps you tell product screens from blog posts when triaging."
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Select
                  name="maxCaptureLevel"
                  label="Capture level"
                  value={String(captureLevel)}
                  onChange={(value) => {
                    const level = Number(value);
                    setCaptureLevel(level);
                    if (level < 2) setCapturePreview(false);
                  }}
                >
                  <option value="1">1 — plain HTTP fetch</option>
                  <option value="2">2 — render in Chromium</option>
                </Select>
                <Select
                  name="previewProfile"
                  label="Preview viewport"
                  defaultValue="desktop_1440"
                  disabled={!capturePreview}
                >
                  {DEVICE_PROFILE_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {DEVICE_PROFILES[key].label}
                    </option>
                  ))}
                </Select>
              </div>
            </fieldset>
          </div>

          <div className="space-y-3">
            <fieldset className="rounded-[4px] border border-ink-200 p-2">
              <legend className="px-1 text-2xs font-medium uppercase tracking-wide text-ink-500">
                Link discovery
              </legend>
              <Toggle
                name="crawlInternalLinks"
                label="Follow links found on each page"
                checked={crawlLinks}
                onChange={setCrawlLinks}
                hint="Off by default. With this off, exactly the URLs you submitted are captured."
              />

              {crawlLinks ? (
                <div className="mt-2 space-y-2 border-t border-ink-100 pt-2">
                  <div className="grid grid-cols-3 gap-2">
                    <NumberField
                      name="maxDepth"
                      label="Max depth"
                      value={maxDepth}
                      onChange={setMaxDepth}
                      min={1}
                      max={JOB_LIMITS.maxDepth}
                      error={issueFor("maxDepth")}
                    />
                    <NumberField
                      name="maxPagesPerDomain"
                      label="Per domain"
                      value={maxPagesPerDomain}
                      onChange={setMaxPagesPerDomain}
                      min={1}
                      max={JOB_LIMITS.maxPagesPerDomain}
                      error={issueFor("maxPagesPerDomain")}
                    />
                    <NumberField
                      name="maxPagesTotal"
                      label="Total cap"
                      value={maxPagesTotal}
                      onChange={setMaxPagesTotal}
                      min={1}
                      max={JOB_LIMITS.maxPagesTotal}
                      error={issueFor("maxPagesTotal")}
                    />
                  </div>
                  <Toggle name="restrictToSubmittedDomains" label="Stay on the submitted domains" defaultChecked />
                  <Toggle name="includeSubdomains" label="Allow subdomains" />
                  <div>
                    <label
                      htmlFor="excludeUrlPatterns"
                      className="block text-2xs font-medium uppercase tracking-wide text-ink-500"
                    >
                      Skip URLs containing
                    </label>
                    <textarea
                      id="excludeUrlPatterns"
                      name="excludeUrlPatterns"
                      rows={3}
                      defaultValue={"/cart\n/checkout\n/login\n/logout\n/account\n/admin\n/api/"}
                      className="mono mt-1 w-full rounded-[4px] border border-ink-300 p-1.5 outline-none focus:border-[var(--color-accent)]"
                    />
                    <p className="mt-0.5 text-2xs text-ink-500">
                      One per line. Keeps a crawl out of authenticated and transactional paths.
                    </p>
                  </div>
                </div>
              ) : null}
            </fieldset>

            <fieldset className="rounded-[4px] border border-ink-200 p-2">
              <legend className="px-1 text-2xs font-medium uppercase tracking-wide text-ink-500">
                Politeness and limits
              </legend>
              <div className="grid grid-cols-3 gap-2">
                <NumberField
                  name="requestsPerMinutePerDomain"
                  label="Requests/min"
                  defaultValue={JOB_DEFAULTS.requestsPerMinutePerDomain}
                  min={1}
                  max={JOB_LIMITS.maxRequestsPerMinutePerDomain}
                />
                <NumberField
                  name="navigationTimeoutMs"
                  label="Page timeout (ms)"
                  defaultValue={JOB_DEFAULTS.navigationTimeoutMs}
                  min={1000}
                  max={JOB_LIMITS.navigationTimeoutMs}
                />
                <NumberField
                  name="maxAttempts"
                  label="Attempts"
                  defaultValue={JOB_DEFAULTS.maxAttempts}
                  min={1}
                  max={JOB_LIMITS.maxAttempts}
                />
              </div>

              <div className="mt-2 border-t border-ink-100 pt-2">
                <Toggle
                  name="respectRobots"
                  label="Respect robots.txt"
                  checked={respectRobots}
                  onChange={setRespectRobots}
                />
                {!respectRobots ? (
                  <div className="mt-1.5">
                    <Note tone="danger">
                      Overriding robots.txt is recorded in the audit log against your name. Give a
                      reason.
                    </Note>
                    <input
                      name="robotsOverrideReason"
                      placeholder="Why is this override justified?"
                      className="mt-1.5 h-7 w-full rounded-[4px] border border-[var(--color-tone-danger)]/40 px-2 text-xs outline-none"
                    />
                    {issueFor("robotsOverrideReason") ? (
                      <p className="mt-1 text-2xs text-[var(--color-tone-danger)]">
                        {issueFor("robotsOverrideReason")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="mt-2">
                <Select name="priority" label="Priority" defaultValue="normal">
                  <option value="high">High — run ahead of other jobs</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low — run when nothing else is queued</option>
                </Select>
              </div>
            </fieldset>
          </div>
        </div>

        {/* --- Start ------------------------------------------------ */}
        <div className="space-y-2 border-t border-ink-200 bg-ink-50 p-3">
          {state.error ? <Note tone="danger">{state.error}</Note> : null}
          {state.issues.length > 0 ? (
            <ul className="space-y-0.5 text-2xs text-[var(--color-tone-danger)]">
              {state.issues.map((issue) => (
                <li key={`${issue.path}-${issue.message}`}>
                  <span className="mono">{issue.path}</span>: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-700">
              <strong>{defaultIncluded.toLocaleString("en-US")}</strong> URL
              {defaultIncluded === 1 ? "" : "s"} selected.{" "}
              {crawlLinks ? (
                <>
                  With link discovery on, this job could capture up to{" "}
                  <strong>{estimate.toLocaleString("en-US")}</strong> pages before its limits stop it.
                </>
              ) : (
                <>Exactly these pages will be captured — no links are followed.</>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-ink-700">
                <input type="checkbox" name="startNow" defaultChecked />
                Start immediately
              </label>
              <Button type="submit" variant="primary" disabled={pending || defaultIncluded === 0}>
                {pending ? "Creating…" : "Create job"}
              </Button>
            </div>
          </div>
          <p className="text-2xs text-ink-500">
            Press <Kbd>Tab</Kbd> to move through the form. The job and every submitted URL are
            recorded, including the ones that were refused.
          </p>
        </div>
      </Panel>
    </form>
  );
}

// --- Small form controls -------------------------------------------------

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (value: boolean) => void;
}) {
  const controlled = checked !== undefined;
  return (
    <label className="flex items-start gap-2 text-xs text-ink-700">
      <input
        type="checkbox"
        name={name}
        className="mt-0.5"
        {...(controlled
          ? { checked, onChange: (event) => onChange?.(event.target.checked) }
          : { defaultChecked })}
      />
      <span>
        {label}
        {hint ? <span className="mt-0.5 block text-2xs text-ink-500">{hint}</span> : null}
      </span>
    </label>
  );
}

function NumberField({
  name,
  label,
  value,
  onChange,
  defaultValue,
  min,
  max,
  error,
}: {
  name: string;
  label: string;
  value?: number;
  onChange?: (value: number) => void;
  defaultValue?: number;
  min?: number;
  max?: number;
  error?: string;
}) {
  const controlled = value !== undefined;
  return (
    <div>
      <label htmlFor={name} className="block text-2xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        min={min}
        max={max}
        {...(controlled
          ? { value, onChange: (event) => onChange?.(Number(event.target.value)) }
          : { defaultValue })}
        className={clsx(
          "mt-1 h-7 w-full rounded-[4px] border px-2 text-xs tabular-nums outline-none focus:border-[var(--color-accent)]",
          error ? "border-[var(--color-tone-danger)]" : "border-ink-300",
        )}
      />
      {error ? <p className="mt-0.5 text-2xs text-[var(--color-tone-danger)]">{error}</p> : null}
      {max !== undefined && !error ? (
        <p className="mt-0.5 text-2xs text-ink-400">max {max.toLocaleString("en-US")}</p>
      ) : null}
    </div>
  );
}

function Select({
  name,
  label,
  children,
  defaultValue,
  value,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  children: React.ReactNode;
  defaultValue?: string;
  /** Controlled mode, for a select whose value drives another control. */
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-2xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </label>
      <select
        id={name}
        name={name}
        {...(value === undefined
          ? { defaultValue }
          : { value, onChange: (event) => onChange?.(event.target.value) })}
        disabled={disabled}
        className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 bg-surface px-1.5 text-xs outline-none focus:border-[var(--color-accent)] disabled:bg-ink-100 disabled:text-ink-400"
      >
        {children}
      </select>
    </div>
  );
}
