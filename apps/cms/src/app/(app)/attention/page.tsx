import Link from "next/link";
import { listNeedsAttention } from "@uxd/api";
import {
  LIFECYCLE_STATUS_META,
  RIGHTS_STATUS_META,
  SOURCE_HEALTH_META,
  type LifecycleStatus,
  type RightsStatus,
  type SourceHealth,
} from "@uxd/types";
import {
  Badge,
  EmptyState,
  InlineMeta,
  LinkButton,
  MonoValue,
  PageHeader,
  Panel,
  Timestamp,
} from "@/components/ui/primitives";
import { getAdminContextWith } from "@/lib/server";

export const metadata = { title: "Needs attention" };

/**
 * Everything waiting on a person, in one list (§1, §12).
 *
 * Six different things go wrong in a capture pipeline and they live in six
 * different tables: a content record that failed, a queue item that exhausted
 * its retries, a URL our own guard refused, a rights hold, a source that has
 * stopped responding, and a capture that errored. An operator does not think in
 * those terms — they think "what is broken" — so this page is the union.
 *
 * Each group states what the operator can actually do about it, because a list
 * of problems with no next action is a worry list rather than a work queue.
 */
export default async function AttentionPage() {
  const context = await getAdminContextWith("content.read");
  const { failedContent, deadItems, blockedItems, rightsHolds, unhealthySources, failedCaptures } =
    await listNeedsAttention(context.db);

  const total =
    failedContent.length +
    deadItems.length +
    blockedItems.length +
    rightsHolds.length +
    unhealthySources.length +
    failedCaptures.length;

  return (
    <>
      <PageHeader
        title="Needs attention"
        description="Failures, blocked URLs, rights holds and unhealthy sources — everything waiting on a person, in one list."
        count={total === 0 ? "nothing outstanding" : `${total} items`}
      />

      <div className="space-y-4 p-4">
        {total === 0 ? (
          <Panel>
            <EmptyState
              title="Nothing needs attention"
              description="No failed captures, no dead queue items, no rights holds and no unhealthy sources."
              action={<LinkButton href="/reviews">Go to the review queue</LinkButton>}
            />
          </Panel>
        ) : null}

        {/* --- Content in a failed or held state ---------------------- */}
        {failedContent.length > 0 ? (
          <Panel
            title={`Content needing a decision (${failedContent.length})`}
            description="Records whose status says a person has to look: failed, restricted or removed."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Record</th>
                  <th className="w-28">Status</th>
                  <th className="w-32">Source</th>
                  <th className="w-24">Updated</th>
                </tr>
              </thead>
              <tbody>
                {failedContent.map((row) => {
                  const meta = LIFECYCLE_STATUS_META[row.status as LifecycleStatus];
                  return (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/content/${row.id}`} className="font-medium hover:underline">
                          {row.title ?? "Untitled"}
                        </Link>
                        <InlineMeta items={[row.sourceUrl]} />
                      </td>
                      <td>
                        <Badge tone={meta.tone} title={meta.description}>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="truncate-cell text-ink-600">{row.sourceName ?? "—"}</td>
                      <td>
                        <Timestamp value={row.updatedAt} relative />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ) : null}

        {/* --- Dead-lettered queue items ------------------------------ */}
        {deadItems.length > 0 ? (
          <Panel
            title={`Gave up after retrying (${deadItems.length})`}
            description="Queue items that exhausted their attempts. Retry them from the job once the underlying cause is fixed."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th className="w-40">Why it failed</th>
                  <th className="w-16 text-right">Tries</th>
                  <th className="w-24">Job</th>
                  <th className="w-24">When</th>
                </tr>
              </thead>
              <tbody>
                {deadItems.map((row) => (
                  <tr key={row.id}>
                    <td className="truncate-cell">
                      <MonoValue value={row.url} truncate />
                    </td>
                    <td className="truncate-cell">
                      <span className="text-[var(--color-tone-danger)]">{row.errorCode ?? "—"}</span>
                      <InlineMeta items={[row.errorMessage]} />
                    </td>
                    <td className="text-right tabular-nums text-ink-600">{row.attempts}</td>
                    <td>
                      <Link href={`/crawl-jobs/${row.jobId}`} className="mono text-2xs hover:underline">
                        {row.jobReference}
                      </Link>
                    </td>
                    <td>
                      <Timestamp value={row.finishedAt} relative />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ) : null}

        {/* --- Blocked by our own guard ------------------------------- */}
        {blockedItems.length > 0 ? (
          <Panel
            title={`Refused by the safety rules (${blockedItems.length})`}
            description="URLs our own guard declined: a private or internal address, a disallowed protocol or port, or an operator blocklist entry. These are working as intended — listed so a legitimate URL caught by a rule is visible rather than silently missing."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th className="w-56">Reason</th>
                  <th className="w-24">Job</th>
                  <th className="w-24">When</th>
                </tr>
              </thead>
              <tbody>
                {blockedItems.map((row) => (
                  <tr key={row.id}>
                    <td className="truncate-cell">
                      <MonoValue value={row.url} truncate />
                    </td>
                    <td className="truncate-cell">
                      <span className="text-2xs font-medium text-ink-700">
                        {row.errorCode ?? "BLOCKED"}
                      </span>
                      <InlineMeta items={[row.errorMessage]} />
                    </td>
                    <td className="mono text-2xs text-ink-600">{row.jobReference}</td>
                    <td>
                      <Timestamp value={row.finishedAt} relative />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ) : null}

        {/* --- Rights holds (§22) ------------------------------------- */}
        {rightsHolds.length > 0 ? (
          <Panel
            title={`Rights holds (${rightsHolds.length})`}
            description="Records that cannot be published until their rights position is settled. These are operational labels recording what the team knows, not legal determinations."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Record</th>
                  <th className="w-28">Rights</th>
                  <th className="w-28">Legal review</th>
                  <th className="w-24">Takedown</th>
                  <th className="w-24">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rightsHolds.map((row) => {
                  const meta = RIGHTS_STATUS_META[row.rightsStatus as RightsStatus];
                  return (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/content/${row.id}`} className="font-medium hover:underline">
                          {row.title ?? "Untitled"}
                        </Link>
                      </td>
                      <td>
                        <Badge tone={meta.tone} title={meta.description}>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="text-2xs text-ink-600">{row.legalReviewStatus}</td>
                      <td className="text-2xs text-ink-600">{row.takedownStatus}</td>
                      <td>
                        <Timestamp value={row.updatedAt} relative />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ) : null}

        {/* --- Unhealthy sources ------------------------------------- */}
        {unhealthySources.length > 0 ? (
          <Panel
            title={`Sources not responding as expected (${unhealthySources.length})`}
            description="Ordered by consecutive failures, so the ones that have stopped working entirely are first."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="w-32">Health</th>
                  <th className="w-20 text-right">Failures</th>
                  <th>Last error</th>
                  <th className="w-24">Last capture</th>
                </tr>
              </thead>
              <tbody>
                {unhealthySources.map((row) => {
                  const meta = SOURCE_HEALTH_META[row.health as SourceHealth];
                  return (
                    <tr key={row.id}>
                      <td className="truncate-cell">
                        <Link href={`/sources/${row.id}`} className="font-medium hover:underline">
                          {row.name}
                        </Link>
                        <InlineMeta items={[row.domain]} />
                      </td>
                      <td>
                        <Badge tone={meta.tone} title={meta.description}>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums text-[var(--color-tone-danger)]">
                        {row.consecutiveFailures}
                      </td>
                      <td className="truncate-cell text-2xs text-ink-600">
                        {row.lastErrorMessage ?? "—"}
                      </td>
                      <td>
                        <Timestamp value={row.lastCapturedAt} relative />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ) : null}

        {/* --- Failed captures --------------------------------------- */}
        {failedCaptures.length > 0 ? (
          <Panel
            title={`Failed captures (${failedCaptures.length})`}
            description="Individual capture attempts that errored. A record can have a failed capture and still hold a good earlier one."
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th className="w-40">Error</th>
                  <th className="w-24">Record</th>
                  <th className="w-24">When</th>
                </tr>
              </thead>
              <tbody>
                {failedCaptures.map((row) => (
                  <tr key={row.id}>
                    <td className="truncate-cell">
                      <MonoValue value={row.requestedUrl} truncate />
                    </td>
                    <td className="truncate-cell">
                      <span className="text-[var(--color-tone-danger)]">{row.errorCode ?? "—"}</span>
                      <InlineMeta items={[row.errorMessage]} />
                    </td>
                    <td>
                      {row.contentItemId ? (
                        <Link
                          href={`/content/${row.contentItemId}`}
                          className="text-2xs hover:underline"
                        >
                          Open
                        </Link>
                      ) : (
                        <span className="text-2xs text-ink-400">none</span>
                      )}
                    </td>
                    <td>
                      <Timestamp value={row.createdAt} relative />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ) : null}

        <p className="text-2xs text-ink-500">
          Each group shows at most 50 rows. Use the filters on Content, Crawl jobs and Sources to see
          everything.
        </p>
      </div>
    </>
  );
}
