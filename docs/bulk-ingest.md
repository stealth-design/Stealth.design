# Bulk ingesting URLs

Up to 5,000 URLs per job (`JOB_LIMITS.maxUrlsPerJob`). The mechanics are the
same as a single URL; what changes is that at this scale the *validation
screen* is the interesting part, because reading it is how you avoid a job that
half-works.

## Four ways in

**Paste.** Newlines, commas, whitespace, or a pasted CSV column —
`splitPastedUrls` handles all of them. The most common real input is a column
from a spreadsheet, which is why a bare paste works rather than requiring
cleanup.

**CSV.** One URL per row. The first column is used; other columns are ignored
rather than rejected, so an export with notes beside the URLs works as-is.

**Sitemap.** Give it a `sitemap.xml` and it fetches and expands it, index
sitemaps included. It goes through the *same guarded HTTP client* as
everything else — a sitemap is an attacker-controlled document like any other,
and one that lists `http://169.254.169.254/` gets the same refusal a pasted URL
would.

**Recapture.** Sources → a source → Recapture. Collects the URLs that source
already has, re-validates every one, and queues them as an ordinary job.

## Reading the validation screen

Six buckets. At scale, the two that need attention are the ones in the middle.

| | Included by default | |
|---|---|---|
| **Valid** | yes | |
| **Already in the database** | **no** | A person decides. Include to record a new version and detect change |
| **Duplicate in batch** | no | Two lines normalised to the same URL |
| **Invalid** | never | |
| **Blocked** | never | |
| **Unreachable** | no | Only if you enabled the probe |

**Already in the database** is unchecked deliberately. In a 500-URL paste
assembled from several sources, some overlap is normal, and silently
re-capturing them would double the work and the cost to the sites involved.
Recapture, where re-fetching *is* the intent, overrides this per line — and
cannot override `blocked` or `invalid`, because `createIngestionJob` re-checks
server-side.

**Duplicate in batch** is worth glancing at. It usually means the same page
reached you twice with different tracking parameters, which is normalisation
working. If the count is large, the list probably came from an analytics export.

The screen also gives you a per-host breakdown — "412 URLs across 6 domains".
That is the number to look at before pressing start, because politeness is
per-host: 400 URLs on one domain at 20 requests per minute is twenty minutes of
sustained traffic to one server.

Every line is recorded in `crawl_job_urls`, rejects included, with its outcome
and reason. §5: nothing is silently dropped. 340 submitted and 297 queued means
43 rows you can read.

## Configuration that matters at scale

| | Default | |
|---|---|---|
| **Requests per minute per domain** | 20 | The politeness ceiling. Lower it for a small site |
| **Concurrency per domain** | 1 | Leave it |
| **Crawl internal links** | off | Turning this on changes a bounded job into a crawl |
| **Max depth** | 0 | |
| **Max pages per domain** | 25 | Only applies with discovery on |
| **Max pages total** | 100 | The hard stop |
| **Capture level** | 2 | Level 1 for a text-only pass over many URLs |
| **Device profiles** | desktop | Each profile is another screenshot per page |
| **Priority** | normal | `low` yields to interactive work |

Before you start, the screen states the ceiling: "this job could capture up to
N pages". With discovery on, that is `min(maxPagesTotal, urls × maxPagesPerDomain)`
— which is how a 400-URL job with depth 2 becomes a five-figure number, and why
the estimate is shown before rather than after.

## Practical guidance

**Turn discovery off unless you mean it.** Off is the default and almost always
right for a bulk list: you already have the URLs, and discovery turns a job you
can predict into one you cannot.

**Choose the capture level for the question.** Level 1 (HTTP) over 2,000 URLs
is minutes and gives you titles, metadata and structural signals. Level 2 is
seconds *per page* and gives you screenshots. If the goal is to find the 60
pages worth looking at, run level 1 first and recapture those at level 2.

**Split by host.** Four jobs of one domain each run politely in parallel;
one job of four domains serialises behind whichever is slowest.

**Priority `low` for anything large.** It yields to interactive work, so a
2,000-URL backfill does not delay the single URL someone submits while it runs.

## While it runs

Crawl jobs → the job. Live counts, per-URL outcomes, the log.

Pause, resume, cancel, retry all take effect on the next poll — the claim query
joins the job and checks its status, so nothing needs signalling. Pausing a
running job lets in-flight items finish; it does not kill them.

**Retry failed items** re-queues only the failures, after you have fixed
whatever caused them. Dead-lettered items — those that exhausted their attempts
— are listed on **Needs attention** with their error codes, which is usually
where a pattern shows up: forty `TIMEOUT`s on one host is a rate limit set too
high, not forty broken pages.

## Afterwards

A large job produces a large review queue. Two things make it tractable:

**Bulk actions on the Content screen.** Filter, select, approve or reject
together. Audited as one batch that expands to its rows, so the log stays
readable.

**The classification queue, confidence-ordered.** `/taxonomy/suggestions` puts
the high-confidence suggestions first, which sounds backwards for a review
queue until you work one: those clear in a keystroke, leaving the genuinely
uncertain ones — where a person's judgement is actually needed — as the
remainder.

Bulk approval is deliberately not "approve everything above 0.9 confidence"
across rows nobody has looked at. That is auto-classification with an extra
click, and §14 rules it out.

## Before a very large job

- Does the site have terms that address automated access?
- Is `WORKER_CONTACT_URL` set? A site owner who notices should be able to reach
  someone.
- Is the rate limit right for *this* site rather than the default?
- Is robots.txt being respected? Overriding it is a separate permission for a
  reason.

None of that is enforced by the software. §22: the system records what your
team decided; it does not decide for you, and it never labels anything
"legally safe".
