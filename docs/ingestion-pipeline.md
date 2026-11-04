# The ingestion pipeline

§40's workflow, and where each stage actually lives.

> **This document describes the crawl half.** Since discovery and capture were
> separated, a crawl produces **candidates**, not content — it fills
> `discovered_pages` and stops. Turning a candidate into a Screen is a separate,
> deliberate act performed by a person in the capture studio. Read
> [capture-workflow.md](capture-workflow.md) first; it is the shape of the
> product. What follows is still accurate about validation, the queue, the
> lease protocol and politeness, which are unchanged.

```
  DISCOVER      paste URLs · CSV · sitemap · crawl discovery
      │
      ▼         validateUrlBatch  ── SSRF guard, normalisation, dedupe
  INGEST        every line recorded, rejects included
      │
      ▼         createIngestionJob  ── config validated by the worker's schema
  QUEUE         crawl_job_items · FOR UPDATE SKIP LOCKED
      │
      ▼         ◄── worker leases, heartbeats, reports
  FETCH         HTTP or sandboxed Chromium · metadata extraction
      │
      ▼         recordDiscoveredPage  ── upsert on the normalised URL hash
  CANDIDATE     discovered_pages — not content, not publishable
      │
      ▼         a person picks, in the triage queue
  ─────────────  the crawl's job ends here  ─────────────
      │
      ▼         capture_sessions · a live browser the researcher drives
  CAPTURE       viewport only · lossless PNG · see capture-workflow.md
      │
      ▼         heuristic and/or model · confidence recorded
  CLASSIFY      suggestions, never applied
      │
      ▼         humans decide
  REVIEW        approve · correct · reject
      │
      ▼         canPublish() ── all blockers, with reasons
  APPROVE       ── gate refuses: no title, no media, rights hold, not approved
      │
      ▼
  PUBLISH       live on /api/public and the public site
```

## DISCOVER

Four ways in, all landing in the same place:

- **Paste.** `splitPastedUrls` accepts newlines, commas, whitespace and a CSV
  column, capped at `JOB_LIMITS.maxUrlsPerJob` (5,000).
- **Sitemap.** `fetchSitemapUrls` fetches through the same guarded HTTP client
  as everything else — a sitemap is an attacker-controlled document like any
  other.
- **Crawl discovery.** On by default now (`crawlInternalLinks: true`,
  `maxDepth: 1`), because discovery is what a crawl is for. The bounds are still
  explicit and finite: depth, pages per domain, pages total.
- **Recapture.** `recaptureSource` collects the URLs a source already has and
  re-validates every one.

## INGEST — validation, before anything is fetched

`validateUrlBatch` in `packages/api/src/services/ingestion.ts`. Four passes,
then a report. Nothing has touched the network yet except the optional
reachability probe.

Every URL lands in one of six buckets:

| Outcome | Meaning | Included by default |
|---|---|---|
| `valid` | Parses, passes the guard, not seen before | yes |
| `already_in_database` | Captured before. Include it to record a new version | no — a person decides |
| `duplicate_in_batch` | Two lines normalised to the same URL | no |
| `invalid` | Not a URL, or a protocol/port we refuse | never |
| `blocked` | Refused by the SSRF guard or an operator blocklist | never |
| `unreachable` | DNS or connection failed at the optional probe | no |

`invalid` and `blocked` can never be included, whatever the request says.
`createIngestionJob` re-checks server-side, so a crafted request cannot smuggle
a blocked address past the validation screen's checkboxes.

A DNS failure produces `unreachable`, not `blocked`. Conflating them would tell
an operator that our safety rules refused their URL when in fact their typo
does not resolve.

**Every submitted line is recorded** in `crawl_job_urls`, rejects included, with
its outcome and reason. §5: nothing is silently dropped. An operator who pasted
340 URLs and got 297 items can see the other 43 and why.

## QUEUE

`crawl_job_items`, claimed with `FOR UPDATE SKIP LOCKED` under a lease.

```sql
-- packages/database/src/queue.ts, simplified
with claimed as (
  select i.id from crawl_job_items i
  join crawl_jobs j on j.id = i.job_id
  where i.status = 'pending' and j.status = 'running'
  order by j.priority desc, i.created_at
  limit $1
  for update of i skip locked
)
update crawl_job_items t
set status = 'leased', lease_token = $2, lease_expires_at = now() + …
from claimed, crawl_jobs j
where t.id = claimed.id and j.id = t.job_id
returning t.*, j.config, j.reference
```

Four properties matter:

- **`SKIP LOCKED`** lets several workers poll concurrently without blocking each
  other or claiming the same item.
- **A lease token** gates completion. A worker that hung, lost its lease, and
  then came back cannot report a result for an item someone else is now doing —
  `completeItem` checks the token and returns "stale lease" rather than throwing.
- **Heartbeats** extend the lease while work is genuinely in progress, so a slow
  page is not mistaken for a dead worker.
- **`reclaimExpiredLeases`** returns abandoned items to `pending` and increments
  attempts. §6: a worker crash loses a lease, not the work.

Job control — pause, resume, cancel, retry — is `UPDATE`s on job and item
status. A paused job's items stop being claimable because the claim query joins
`crawl_jobs` and checks its status, so pause takes effect on the next poll
without signalling anyone.

## CAPTURE — in the worker

`apps/ingestion-worker` leases, captures, and reports back over HTTP. It holds
no database credential. See [worker.md](worker.md) and
[security.md](security.md).

Per item:

1. **Guard the URL again.** Not because the CMS is untrusted, but because DNS
   can change between validation and capture. `guardUrl` resolves the hostname
   and classifies *every* returned address; the resolved address is then pinned
   for the actual connection, so a name that resolves twice cannot resolve to a
   public address for the check and a private one for the fetch.
2. **robots.txt**, cached per host, honoured unless an operator has explicitly
   overridden it — a separately audited permission.
3. **Rate limit** per host, from the job config, defaulting to the operator's
   setting.
4. **Fetch or render.** Level 1 is a guarded HTTP fetch; level 2 launches a
   browser. `needsBrowser()` escalates when the HTML suggests client-side
   rendering — no point spending 3 seconds of Chromium on a static page.
5. **Capture.** Fresh isolated browser context per item. Subresource hosts are
   screened by a route handler, the page-weight budget is enforced while
   loading, lazy images are triggered by an auto-scroll, animations are frozen
   so two captures of the same page are comparable, then screenshots at each
   configured device profile.
6. **Extract** title, meta, headings, word count and structural signals with
   cheerio. Every string passes through `sanitizeText`.
7. **Upload** the images to the CMS, which is what writes them to storage.
8. **Report** the result and any discovered URLs.

Bounded by: navigation timeout, whole-item deadline, max page bytes, max
response bytes, max redirects, and a browser recycled after 200 captures.

## PROCESS — intake, in the CMS

`intakeCapture` in `packages/api/src/services/capture-intake.ts`. One
transaction, because a capture that half-landed is worse than one that failed:

1. Resolve or create the source from the URL's registrable domain.
2. Find the existing content record by normalised URL hash.
3. Load the previous capture and compute a change summary — content hash, layout
   hash, and what moved.
4. Create or update the content record, advancing status via
   `statusAfterRecapture`.
5. Insert the capture row.
6. Insert or update the page detail row.
7. Attach media, deduplicating by sha256, and backfill provenance.
8. Update `url_registry`.
9. Recompute source health and counters.
10. Write the audit row.

Media counters are **recomputed, not incremented**. Deduplication means one file
can serve several roles, and a counter maintained by deltas across recapture,
dedupe and deletion drifts. A drifted count is worse than a slightly more
expensive query, because it is the number an operator uses to decide something.

## CLASSIFY

`classifyAndQueueForReview`, then a human. Two providers:

- **Heuristic** — structural signals only. Offline, no API key, and its
  confidence is *capped below the auto-apply floor* so it structurally cannot
  produce a suggestion the system would apply unattended.
- **Anthropic** — the heuristic signals plus a model. Untrusted page text is
  wrapped by `fenceUntrusted` before it reaches a prompt, and the response is
  parsed against a Zod schema. §25: "do not send raw scraped instructions
  directly to AI agents without isolation."

Suggestions land as `taxonomy_assignments` with `origin: 'ai_suggested'` and
`review_status: 'pending'`. They are never applied. The public queries filter on
origin, so an unreviewed suggestion cannot appear publicly even if the record is
published.

Classification is optional. `CLASSIFICATION_PROVIDER=none` leaves capture,
review and publishing working exactly as before.

## REVIEW

`/reviews` is built for the keyboard because that is where the throughput is:
`A` approve, `R` reject, `P` approve-and-publish. Approve-and-publish is one
action rather than two so the two writes share a transaction and the reviewer
does not leave the queue.

`/taxonomy/suggestions` is the classification queue, ordered by confidence
descending — the high-confidence ones clear in a keystroke, leaving the
genuinely uncertain ones as the remainder. Correcting a term records
`human_modified` and keeps the model's original in `replaced_term_id`, so "how
often did a person have to fix this?" is a query rather than a guess.

Bulk actions exist and are audited as one batch that expands to its rows.

## APPROVE — the gate

`canPublish()` in `packages/types/src/publishing.ts`. It returns **every**
blocker, each with a field, rather than the first:

| Blocker | Why |
|---|---|
| `NOT_APPROVED` | Only `approved` transitions to `published` |
| `NO_TITLE` / `NO_SLUG` | A public page needs an address and a name |
| `NO_MEDIA` | For page, screen, website and app: a visual reference with no image is not a reference. A flow is exempt — its steps carry the images |
| `RIGHTS_HOLD` | `pending_review`, `restricted`, `removed` or `do_not_republish` |
| `ALREADY_PUBLISHED` | Not an error, but not a no-op either |

The CMS shows the blockers next to a disabled button rather than hiding the
button, because "why can't I publish this?" is the question a reviewer actually
has and a missing button does not answer it.

Enforced three times: in the service, at the SQL level by
`publishedContentCondition()`, and by the `content_items_publishable` CHECK
constraint. That is not redundancy for its own sake — the first is the
explanation, the second is what makes every public query correct by
construction, and the third is what makes a bug in the first two a failed write
instead of a disclosure.

## PUBLISH

Status becomes `published`, `published_at` and `published_by` are set, an audit
row is written.

Withdrawal is automatic where it needs to be. Setting a blocking rights status
on published content unpublishes it in the same transaction. The alternative —
leaving restricted material live until someone remembers to unpublish it
separately — is exactly the failure this system should not have.

## RECAPTURE

Same URL, new snapshot. This is the stage where a subtle bug lives, and it is
worth stating what it was.

Recapture advances a record's status. Initially only `published` and `approved`
were preserved, which meant a record sitting at `needs_review` was reset to
`processed`, then advanced to `ai_classified` — **removing it from the review
queue while its review row stayed open.** Work silently disappeared.

`RECAPTURE_ADVANCEABLE_STATUSES` now names exactly the seven statuses a capture
may move, and `statusAfterRecapture` preserves everything else. Seven tests
cover it, including one asserting the status set is partitioned exactly — so
adding a status forces a decision about which side it falls on rather than
silently defaulting.

Recapture also **re-validates every URL**, even though each one captured
successfully before. A hostname's DNS can be re-pointed at a private address
between captures; a domain can lapse and be re-registered. A URL that was safe
in March is not thereby safe in September. URLs that no longer pass are recorded
on the job rather than dropped quietly.

## Where each stage lives

| Stage | Code |
|---|---|
| Discover / Ingest | `api/services/ingestion.ts` · CMS `/ingestion` |
| Queue | `database/src/queue.ts` · CMS `/crawl-jobs` |
| Capture | `apps/ingestion-worker` · `packages/crawler` |
| Process | `api/services/capture-intake.ts` |
| Classify | `packages/classification` |
| Review | `api/services/publishing.ts`, `classification-review.ts` · CMS `/reviews`, `/taxonomy/suggestions` |
| Approve / Publish | `types/src/publishing.ts` · `api/services/publishing.ts` |
| Recapture | `api/services/ingestion.ts` · `types/src/lifecycle.ts` |
