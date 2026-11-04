import { listSettings, listWorkers } from "@uxd/api";
import { queueHealth } from "@uxd/database";
import { describeBlockedRanges } from "@uxd/crawler";
import { JOB_LIMITS } from "@uxd/types";
import {
  Badge,
  EmptyState,
  Field,
  FieldList,
  InlineMeta,
  MonoValue,
  PageHeader,
  Panel,
  SectionLabel,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith } from "@/lib/server";
import { SettingEditor } from "./editor";

export const metadata = { title: "Settings" };

const GROUP_LABELS: Record<string, { title: string; description: string }> = {
  crawl: {
    title: "Crawl defaults",
    description:
      "Applied to new jobs. A job may narrow these; nothing can widen them past the hard limits below.",
  },
  urls: {
    title: "URL normalisation",
    description:
      "How a URL is reduced to a canonical form, which decides when two addresses are the same page.",
  },
  classification: {
    title: "Classification",
    description: "How much the system trusts a model, and what it is allowed to do unattended.",
  },
  publishing: {
    title: "Publishing",
    description: "Additional conditions on top of the publish gate every record already passes.",
  },
  retention: {
    title: "Retention",
    description: "How long the bulkier by-products of a capture are kept.",
  },
};

/**
 * Settings (§21, §37).
 *
 * §37 forbids hardcoding what belongs to whoever runs the system, and this
 * screen is where that promise is kept: crawl politeness, the
 * tracking-parameter list, the classification confidence floor, retention
 * windows. Each value is validated against a per-key schema on write, so a bad
 * value is refused here rather than crashing a worker later.
 *
 * The hard limits are shown *beside* the editable defaults rather than hidden,
 * because the distinction matters operationally: a default is a starting point
 * a job can change, a limit is a ceiling nothing can exceed. Same for the
 * blocked address ranges — they are listed with their reasons and are not
 * editable, since §25 forbids allowing localhost or private-IP access at all.
 */
export default async function SettingsPage() {
  const context = await getAdminContextWith("settings.read");

  const [values, workers, queue] = await Promise.all([
    listSettings(context.db),
    listWorkers(context.db),
    queueHealth(context.db),
  ]);

  type SettingRow = (typeof values)[number];
  const byGroup = new Map<string, SettingRow[]>();
  for (const setting of values) {
    byGroup.set(setting.group, [...(byGroup.get(setting.group) ?? []), setting]);
  }

  const invalid = values.filter((setting) => setting.invalid);
  const blockedRanges = describeBlockedRanges();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Crawl defaults, URL normalisation, classification, workers and users. The things that would otherwise be hardcoded."
        count={`${values.filter((setting) => !setting.isDefault).length} of ${values.length} changed from defaults`}
      />

      <div className="space-y-4 p-4">
        {invalid.length > 0 ? (
          <Panel>
            <div className="p-3 text-xs text-[var(--color-tone-danger)]">
              {invalid.length} stored{" "}
              {invalid.length === 1 ? "value no longer satisfies its schema" : "values no longer satisfy their schemas"}{" "}
              and {invalid.length === 1 ? "is" : "are"} being ignored in favour of the default:{" "}
              {invalid.map((setting) => setting.key).join(", ")}. Save a valid value to clear this.
            </div>
          </Panel>
        ) : null}

        {/* --- Editable settings ------------------------------------- */}
        {["crawl", "urls", "classification", "publishing", "retention"]
          .filter((group) => byGroup.has(group))
          .map((group) => (
            <Panel
              key={group}
              title={GROUP_LABELS[group]?.title ?? group}
              description={GROUP_LABELS[group]?.description}
            >
              <div className="divide-y divide-ink-100">
                {(byGroup.get(group) ?? []).map((setting) => (
                  <SettingEditor
                    key={setting.key}
                    settingKey={setting.key}
                    label={setting.label}
                    description={setting.description}
                    value={setting.value}
                    defaultValue={setting.defaultValue}
                    isDefault={setting.isDefault}
                    updatedAt={setting.updatedAt ? setting.updatedAt.toISOString() : null}
                  />
                ))}
              </div>
            </Panel>
          ))}

        {/* --- Hard limits, not editable ----------------------------- */}
        <Panel
          title="Hard limits"
          description="Ceilings compiled into the job schema. A configuration exceeding one of these is rejected at validation, so no setting and no API call can raise them."
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>Limit</th>
                <th className="w-32 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(JOB_LIMITS).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono text-2xs text-ink-700">{key}</td>
                  <td className="text-right tabular-nums text-ink-800">
                    {typeof value === "number" ? value.toLocaleString("en-US") : String(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* --- SSRF policy, stated and not editable ------------------ */}
        <Panel
          title="Blocked address ranges"
          description="Every address a capture resolves to is checked against these. Not configurable: allowing localhost or private-IP access is on the explicit list of things this system must never do."
        >
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-40">Range</th>
                <th className="w-32">Category</th>
                <th>Why it is blocked</th>
              </tr>
            </thead>
            <tbody>
              {/* Keyed on the CIDR, which is the only unique identifier a range
                  has: three IPv4 ranges legitimately share the label
                  "documentation" (TEST-NET-1, -2 and -3). */}
              {blockedRanges.map((range) => (
                <tr key={range.cidr}>
                  <td className="mono text-2xs text-ink-800">{range.cidr}</td>
                  <td className="text-2xs text-ink-500">
                    {range.label}
                    <span className="ml-1 text-ink-400">IPv{range.family}</span>
                  </td>
                  <td className="text-2xs text-ink-600">{range.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* --- Workers (§6) --------------------------------------- */}
          <Panel
            title="Capture workers"
            description="Isolated processes that run the browser. They hold no database or storage credentials and reach the CMS only over the internal HTTP API."
          >
            {workers.length === 0 ? (
              <EmptyState
                title="No workers registered"
                description="Start one with `npm run dev:worker`. Until a worker registers, jobs stay queued — the CMS never runs a browser itself."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th className="w-20 text-right">Captures</th>
                    <th className="w-24">Heartbeat</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((worker) => (
                    <tr key={worker.id}>
                      <td className="truncate-cell">
                        <span className="mono text-2xs text-ink-800">{worker.name}</span>
                        <InlineMeta
                          items={[
                            worker.version,
                            worker.itemsInFlight > 0 ? `${worker.itemsInFlight} in flight` : "idle",
                            worker.itemsFailed > 0 ? `${worker.itemsFailed} failed` : null,
                          ]}
                        />
                      </td>
                      <td className="text-right tabular-nums text-ink-600">
                        {worker.itemsCompleted.toLocaleString("en-US")}
                      </td>
                      <td>
                        {worker.isStale ? (
                          <Badge tone="warning" title="No heartbeat for over two minutes.">
                            stale
                          </Badge>
                        ) : (
                          <Timestamp value={worker.lastHeartbeatAt} relative />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* --- Queue --------------------------------------------- */}
          <Panel
            title="Queue"
            description="Durable in Postgres, claimed with FOR UPDATE SKIP LOCKED under a lease. A worker that dies loses its lease, not the work."
          >
            <FieldList>
              <Field label="Pending">{queue.pending.toLocaleString("en-US")}</Field>
              <Field label="In flight" hint="Leased or running on a worker right now.">
                {queue.inFlight.toLocaleString("en-US")}
              </Field>
              <Field
                label="Expired leases"
                hint="Items whose worker stopped reporting. Reclaimed and retried automatically, so this being non-zero briefly is normal."
              >
                {queue.expiredLeases > 0 ? (
                  <span className="text-[var(--color-tone-warning)]">
                    {queue.expiredLeases.toLocaleString("en-US")}
                  </span>
                ) : (
                  "0"
                )}
              </Field>
              <Field label="Active jobs">{queue.activeJobs.toLocaleString("en-US")}</Field>
              <Field label="Oldest pending item has waited">
                {queue.oldestPendingAgeMs === null
                  ? "nothing waiting"
                  : formatAge(queue.oldestPendingAgeMs)}
              </Field>
            </FieldList>
          </Panel>
        </div>

        <div className="space-y-1">
          <SectionLabel>Where the rest of the configuration lives</SectionLabel>
          <p className="max-w-3xl text-2xs leading-relaxed text-ink-500">
            Secrets and connection details are environment variables, not settings — a database URL
            or a session secret editable through a web form would be a way to exfiltrate it. See{" "}
            <MonoValue value=".env.example" /> and the environment table in{" "}
            <MonoValue value="docs/environment.md" />. The capture worker reads its own, much
            shorter, environment: a control-plane URL and a token, and nothing else. A startup
            assertion refuses to boot it if a database or storage variable is present at all.
          </p>
        </div>
      </div>
    </>
  );
}

/** Milliseconds as the coarsest unit that is still informative. */
function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
