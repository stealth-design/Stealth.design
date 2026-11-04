# Phase 1 — System audit

*Generated from the code and the live database, not from recollection.*
Reproduce with `npm run audit:inventory` and `npm run audit:integrity`.

---

## A. Current architecture

Three processes, one database.

```
                    ┌──────────────────────────────────────┐
                    │  PostgreSQL 18                       │
                    │  32 tables · 42 enums · 179 indexes  │
                    │  86 FKs · 15 CHECKs · durable queue  │
                    └───────────────┬──────────────────────┘
                                    │ pg 8.23.0 (the only driver)
    ┌───────────────────────────────┴──────────────────────────────┐
    │  CMS — apps/cms · Next.js 16.3.4 App Router · port 3000      │
    │  24 pages · server actions for every write                   │
    │  /api/public/*    10 GET endpoints, read-only, publish-gated │
    │  /api/internal/*  11 endpoints, bearer token, worker only    │
    │  /media/[...key]  session-gated · /api/public/media publish-gated │
    └───────┬──────────────────────┬───────────────────────┬───────┘
            │ storage driver       │ HTTP + bearer         │ HTTP
            ▼                      ▼                       ▼
    ┌───────────────┐   ┌────────────────────┐   ┌──────────────────┐
    │ Object store  │   │ Capture worker     │   │ Public site      │
    │ local | S3    │   │ Playwright 1.62.1  │   │ apps/frontend    │
    └───────────────┘   │ sandboxed Chromium │   │ 8 pages          │
                        │ NO db credentials  │   │ 1 dependency     │
                        └─────────┬──────────┘   └──────────────────┘
                                  ▼
                          the open internet
```

### Stack, as found

| | |
|---|---|
| Framework | Next.js 16.3.4, App Router — both apps |
| Database | PostgreSQL 18. Locally PGlite 0.5.8 over the real wire protocol |
| Driver | `pg` 8.23.0. One driver, one dialect, every environment |
| ORM | Drizzle 0.45.2 — TypeScript schema generating reviewable SQL migrations |
| Object storage | Local filesystem driver, or S3 via `@aws-sdk/client-s3` 3.1125.0 |
| Authentication | In-repo (`packages/auth`): scrypt, opaque session tokens stored as sha256 |
| Job queue | In-repo (`packages/database/src/queue.ts`): Postgres `FOR UPDATE SKIP LOCKED` with lease tokens, heartbeats, reclamation |
| Crawler | In-repo (`packages/crawler`): SSRF guard, guarded `undici` 8.10.1 dispatcher, `robots-parser` 3.0.1, `cheerio` 1.0.0 |
| Playwright | 1.62.1, in the worker only. `BrowserPool` recycles after 200 captures; fresh isolated context per item |
| **Crawlee** | **Not used.** See the note below |
| API | Hono 4.13.5 — two routers mounted on Next route handlers |
| Validation | Zod 4.5.4 — env, job config, API payloads, settings |
| Images | `sharp` 0.35.4, `file-type` 22.0.2 |

### On Crawlee

The original brief specified it. It is not used, and the dependency has been
removed. Crawlee's request queue is its own state store, which puts the
authoritative list of what to capture *inside the worker* — incompatible with
two other requirements: the queue must survive a worker crash, and the worker
holds no database credentials. Orchestration is the Postgres queue plus
`guardUrl`, `BrowserPool` and `fetchGuarded`.

Removing it also took the worker from **12 moderate advisories to zero**
(`@crawlee/core` pulls a `stream-json` with a DoS advisory). Full reasoning in
[../known-limitations.md](../known-limitations.md).

### Package boundaries that do real work

`packages/crawler` has **no database dependency** and cannot acquire one — the
build check fails. That forces every crawl result back through the
control-plane API, where it is validated, rather than being written directly by
the process that just executed attacker-authored JavaScript.

`@uxd/api/client` is a **dependency-free subpath** duplicating the public
response shapes. It is what lets the public site consume the API without
transitively acquiring Drizzle, the schema, or the crawler. `apps/frontend`
has exactly one runtime dependency on our own code.

---

## B. Current database model

32 tables. A shared spine with per-kind detail tables — §2's "middle path",
rejecting both one flat table and a table per kind.

```
sources ──┬─► content_items ──┬─► experience_details   (website / app)
          │   (the spine:     ├─► page_details          (url, http, meta)
          │    status, rights,├─► screen_details        (app screens)
          │    review, audit, ├─► flow_details ──► flow_steps ──► content_items
          │    search)        ├─► state_details         EMPTY
          │                   └─► interaction_details   EMPTY
          │                        │
          ├─► captures ────────────┘   one row per attempt, never overwritten
          ├─► url_registry             every URL seen, capture count, blocks
          └─► robots_cache             per-host rules, shared between workers

media_assets ──┬─► media_derivatives   thumbnails / previews
               └─► media_usages ──► content_items   many-to-many, by role

taxonomy_terms ──► taxonomy_assignments ──► content_items
                   classification_suggestions        EMPTY

crawl_jobs ──┬─► crawl_job_urls    every submitted line, rejects included
             ├─► crawl_job_items   the queue: lease, attempts, error
             └─► crawl_job_events  the readable log

reviews · collections + collection_items · audit_events · settings
users · sessions · worker_instances · worker_tokens (EMPTY)
content_relations (EMPTY)
```

### Verified invariants

`npm run audit:integrity` — **37 passed, 0 failed**:

- No `bytea` column anywhere. Media is in object storage; the rows hold keys.
- Every asset and derivative has a storage key.
- No two live assets share a sha256; every image has a perceptual hash and at
  least one derivative.
- Twelve foreign-key relationships checked for dangling references: all clean.
- Every content record has its kind's detail row.
- No published record violates the publish gate; every approved/published
  record names its approver; no published page or screen lacks an image.
- Every successful capture records a content hash.
- Four maintained counters (`sources.content_count`,
  `taxonomy_terms.usage_count`, `collections.item_count`,
  `flow_details.step_count`) match a recount exactly.

### Five tables are modelled and empty

This is the honest answer to "identify missing functionality", derived from
data rather than opinion:

| Table | What its emptiness means |
|---|---|
| `interaction_details` | Interaction capture has never produced a record |
| `state_details` | No state (hover, modal open, error) captured as its own record |
| `classification_suggestions` | Field-level AI suggestions never produced — only term assignments |
| `content_relations` | No typed relationship (variant-of, precedes, replaces) ever created |
| `worker_tokens` | Per-worker credentials unused; every worker uses the shared secret |

### Two seed defects found and fixed during this audit

Both would have polluted every later measurement.

The demo seed recorded `capture_method: "browser_render"` for generated PNGs no
browser rendered, and linked 22 of 24 assets to no capture row — so "which
capture produced this" was unanswerable for most of the library. Now records
`import`, which is true.

The seed also bypassed `url_registry`, so `validateUrlBatch` could not see
seeded URLs and would have reported them `valid` and re-captured them as new.
The registry now covers every page (15/15).

---

## C. Current ingestion flow

```
DISCOVER   paste · CSV · sitemap · recapture        (discovery off by default)
    │
    ▼      validateUrlBatch — 4 passes, no page fetched
INGEST     every line recorded in crawl_job_urls, rejects included
    │
    ▼      createIngestionJob — config validated by the schema the worker reads
QUEUE      crawl_job_items · FOR UPDATE SKIP LOCKED · lease + heartbeat
    │
    ▼      ◄── worker leases, paces, captures, reports
CAPTURE    guardUrl again → robots → rate limit → level 1 HTTP or level 2 browser
    │
    ▼      intakeCapture — one transaction
PROCESS    source resolve · change detect · media dedupe · registry · audit
    │
    ▼
CLASSIFY   heuristic and/or model → suggestions, never applied
    │
    ▼
REVIEW     approve · correct · reject                (humans decide)
    │
    ▼      canPublish() — returns every blocker, each with a field
PUBLISH    live on /api/public
    │
    ▼
RECAPTURE  same URL, new capture row, previous kept
```

### Ingestion states

**URL validation** — 6 outcomes: `valid`, `invalid`, `duplicate_in_batch`,
`already_in_database`, `blocked`, `unreachable`.

The `invalid` / `blocked` split was **wrong in both directions** and was fixed
during this audit — see [phase-3-ingestion.md](phase-3-ingestion.md).

**Job** — 11 statuses: `draft`, `validating`, `ready`, `queued`, `running`,
`paused`, `cancelling`, `cancelled`, `completed`, `failed`, `archived`.

**Queue item** — `pending`, `leased`, `running`, `succeeded`, `failed`,
`dead_letter`, `blocked`, `skipped_duplicate`.

**Capture** — `succeeded`, `partial`, `failed`, by one of 5 methods.

### Media states

7: `pending`, `processing`, `ready`, `failed`, `quarantined`, `archived`,
`deleted`. Plus 13 usage roles, so one file can serve several purposes without
being copied.

### Publishing states

14 lifecycle statuses with an explicit legal-transition map. `published` is
reachable only from `approved`; `restricted` and `removed` are reachable from
anywhere.

7 of the 14 are `RECAPTURE_ADVANCEABLE` — the rest are preserved through a
recapture, so a capture never overwrites a person's decision.

9 rights statuses, 4 of which block publishing. Setting one on published
content withdraws it in the same transaction.

---

## D. Current CMS flow

24 pages, grouped by the workflow. Full map in
[../cms-routes.md](../cms-routes.md).

Every write is a server action delegating to a service in `@uxd/api`, where
the permission check, transition check, publish gate and audit write live. So
the same rules apply whether a change arrives from a screen, a bulk operation
or a script — and an action cannot forget a check, because it performs none.

5 roles, 52 permissions, a flat matrix. `roleHasPermission` fails closed.

66 audited actions across 16 entity types, append-only, with `batch_id` tying
one bulk operation's rows together.

---

## E. Current frontend flow

```
CMS decision → Postgres → /api/public → @uxd/api/client → apps/frontend
```

8 pages. One data source (`src/lib/api.ts`), one runtime dependency on our own
code, and **no write path to authenticate** — the strongest available form of
"the public frontend must never independently create or maintain content".

Four independent mechanisms keep unpublished content off it: every public query
starts from `publishedContentCondition()`; serialisers construct from an
allowlist rather than filtering a row; `assertPublishable` refuses to serialise
a non-public record; and a CHECK constraint refuses the invalid state.

---

## F. Risks and weaknesses

Ordered by severity. Everything marked **fixed** was found *and fixed* during
this audit; the measurements that found them are in
[phase-2-crawl-experiment.md](phase-2-crawl-experiment.md).

### CRITICAL — fixed

**Normalised URLs were used as fetch targets.** Normalisation strips a trailing
slash to make `/a/b/` and `/a/b` one dedupe record. That string was then
requested. Servers treat them as different resources and 301 one to the other,
so the fetch became an infinite redirect loop, reported as "the page redirected
more than 5 times". `docs.python.org`, `svgwg.org` and
`flask.palletsprojects.com` were all silently rejected, and each cost six
requests against someone else's server. Any site with directory-style URLs was
affected.

*Fix:* `ParsedUrl` now carries `fetchUrl` (what to request) alongside
`normalized` (the dedupe key), and every fetch, navigation, robots check and
queue insert uses the former. 8 regression tests.

### HIGH — fixed

**robots.txt decisions were made from a truncated copy.** The file was stored
as a 16,000-character excerpt "so an operator can see what we obeyed", and the
decision function re-parsed *that*. Wikipedia's robots.txt is 28 KB: the real
file permits `/wiki/Design`, the excerpt appeared to forbid it, and the crawl
cited a line number that says something else entirely. Over-blocking was the
visible symptom; the dangerous direction is a `Disallow` past the cut being
silently ignored.

*Fix:* decisions parse the full file; a separate excerpt is kept for display; a
fetch that hits the size cap is treated as no answer rather than parsed in
part; the cache transport no longer caps below the real file size. 13 tests.

**The rate limiter did not limit.** `HostRateLimiter` holds all its state in a
per-host map, and the worker constructed a new one *per item* — so every item
saw an empty map and a zero wait. `requestsPerMinutePerDomain` was silently
inert. One shared host received eight unpaced requests and began returning 403s
(which then interacted with the robots bug above). A politeness control that
silently does nothing is worse than none, because the operator believes it is
working.

*Fix:* one worker-lifetime limiter, per-call interval so it serves jobs at
different rates, `pruneExpired()` wired into the idle branch. 12 tests.

**Rate-limit waiting was charged against the capture deadline.** At 6 req/min
the interval is 10s, so the eighth item queued against one host waits 70s —
past a 45s item deadline. Correctly-paced items would have failed for being
polite.

*Fix:* the slot is acquired in `main.ts` before the deadline race begins.

**`invalid` and `blocked` were inverted.** SSRF refusals (`localhost`,
`169.254.169.254`, `10.0.0.1`) were reported as `invalid`, as though the
operator had mistyped; a reserved TLD was reported as `blocked`, as though
someone had blocklisted it. The two lead to different actions — edit the list,
or talk to whoever set the policy.

*Fix:* the bucket is derived from the reason (`URL_REFUSAL_BUCKET`), not from
which code path fired. A new `NOT_A_DOMAIN` reason separates malformed input
from a policy refusal, and a bare single label stays `blocked` because `db` and
`intranet` are real internal hosts and mislabelling one as a typo is the worse
error.

**A robots 4xx was treated as disallow-all.** RFC 9309 §2.3.1.3 says a 4xx
means robots.txt is *unavailable* and the crawler may proceed. W3C and w3.org
answer 403 behind a WAF and were silently excluded with "the host refused
access to robots.txt, which we treat as a request not to crawl". A 403 on one
file is not a crawling policy.

*Fix:* 4xx → allowed, 5xx and 429 → unreachable, network failure → still fails
closed. The asymmetry is deliberate: a status code is an answer, a network
failure is the absence of one.

**`npm run typecheck` reported success while a package had 12 errors.**
`tsc -b` decides a project is up to date by timestamp, and by default a failing
project still emits its `dist` and `.tsbuildinfo` — so it looked current and
was skipped silently. `@uxd/crawler` had a dozen real errors cached away.

*Fix:* `noEmitOnError: true`, verified by introducing an error and building
twice. The errors themselves were browser globals in `page.evaluate`
callbacks, now declared narrowly rather than by enabling the whole DOM lib —
which would let a stray `localStorage` typecheck in worker code.

### MEDIUM — open

**Interaction and state capture is modelled and unexercised.**
`interaction_details` and `state_details` are empty. The schema, types, capture
levels and `runInteraction` all exist; nothing has produced a record. Phase 5
of this audit addresses it.

**Field-level classification suggestions are unimplemented.**
`classification_suggestions` is empty. Only term assignments are produced, so
an AI suggestion for a *title* or *description* has nowhere to go.

**No visual diff.** Content, layout and DOM hashes plus a structural change
summary tell you *that* a page changed and roughly where. A designer wants to
see it. Perceptual hashes are stored, so the groundwork exists.

**Flow and taxonomy authoring are read-only.** Both are modelled, seeded,
served and rendered. Creating a flow by picking screens, or re-parenting a
taxonomy term, requires database access.

**Rate limiting on the public API is per instance.** In-memory, so three
instances allow three times the configured rate.

**No user management screen.** Roles and permissions are complete and enforced
by 22 tests; creating a user or changing a role is a database operation.

### LOW — open

- Sessions cannot be revoked in bulk without rotating `SESSION_SECRET`.
- No CSRF token beyond `sameSite=lax` and Next's action encoding.
- The CMS CSP still needs `unsafe-inline` for Next's runtime.
- Media can be orphaned if intake fails between upload and attach. Found by the
  "unused" filter; nothing reaps it.
- `retention.jobLogDays` and `retention.captureBodyDays` are settings nothing
  reads.

---

## G. Recommended changes

The full prioritised list is in [phase-21-final-report.md](phase-21-final-report.md),
after the measurements. What Phase 1 alone established:

**Do now.** Everything in the CRITICAL and HIGH sections above — all fixed
during this phase, all with regression tests, because each was a silent
correctness failure rather than a missing feature. Two of them (the URL and
robots bugs) were actively rejecting legitimate content while reporting a
plausible-sounding reason, which is the worst failure mode a content pipeline
can have.

**Do next.** Interaction capture (Phase 5), because it is the largest modelled
gap and the one that makes the content model more than pages. Then flow
authoring, because a researcher's most valuable output is a flow and it
currently needs SQL.

**Wait.** Visual diff, a second content module, splitting the API out of the
CMS. All are real, none is blocking a content team.

**Do not.** A public write API; replacing the Postgres queue; auto-applying
classifications. Reasoning in [../next-steps.md](../next-steps.md).

### Two process changes worth more than any single fix

The audit found seven correctness bugs, and **six of them were invisible to the
test suite** — 240 tests passed throughout. What found them was running the
real pipeline against the real web and looking at per-item results. Two
mechanisms should be permanent:

1. **`npm run audit:integrity`** — asks the database whether the schema's
   promises are kept. A column existing is not a column being populated, and no
   amount of schema reading would have found five empty tables or a false
   `capture_method`.

2. **`npm run experiment:crawl`** — a bounded, robots-respecting run against a
   scenario-tagged dataset, with per-URL results written to a file the analysis
   reads separately. Every bug above surfaced as an *unexpected* outcome on a
   site tagged with the scenario that explains it.
