# Phase 2 audit — content operations and system validation

What follows is measured, not reviewed. Every number below came out of a script
in this repository that can be re-run, and every bug was found by running the
system rather than by reading it.

That distinction turned out to be the whole story. Across both audit phases,
fifteen defects were found in the product itself. **Fourteen of the fifteen were
invisible to a test suite that passed throughout** — the exception being the one
that explains the rest: `tsc -b` was caching an incremental build, so
`npm run typecheck` reported success with twelve real type errors outstanding,
and the test files were never typechecked at all.

Three of the four defects found *last* were found by one mechanism: re-running
`npm run audit:integrity` after new data existed. Two counters that had been
correct for the life of the project became wrong the moment something produced
AI suggestions, because each had a single maintainer and a definition that only
held while a table was empty.

Re-run the evidence with:

```
npm run audit:inventory      # what exists, derived from Drizzle + the live DB
npm run audit:integrity      # does the schema keep its own promises
npm run audit:review-load    # how much human work the pipeline creates
npm run experiment:crawl -- --profile=http
npm run experiment:crawl -- --profile=browser
npm run experiment:analyse
node scripts/experiments/interaction-poc.mjs
```

---

## 1. The short version

The capture pipeline works. A URL reliably becomes a structured, reviewable
record, and the parts that were designed carefully — SSRF defence, the durable
queue, provenance, the publish gate, worker isolation — hold up under real
traffic against 87 live hosts.

Three things are not ready for a content team:

1. **Recovery was decorative.** Abandoned work was never returned to the queue,
   because the function that does it was implemented, tested, documented, and
   called by nothing. A job hung at 97% and the only fix was manual SQL.
2. **A transient DNS failure permanently deleted good URLs**, and reported them
   to the operator using the same label as a robots.txt refusal — so nothing
   suggested they were worth a second look. One run discarded figma.com,
   gitlab.com and fonts.google.com this way.
3. **The review workload is unmanaged.** The pipeline generates 6.4 human
   decisions per captured item and offers no way to triage them, because the
   confidence score it sorts by has ten distinct values and puts 64% of
   suggestions in a single band.

All three are fixed or specified below. The classifier's accuracy, separately,
is **entirely unmeasured** — see §6.

---

## 2. Defects found, by severity

Severity here means operational consequence, not effort. "Fixed" means the fix
is in this repo with a test that fails without it.

### CRITICAL

**C1 — Abandoned work was never reclaimed.** `reclaimExpiredLeases` existed with
four passing tests and no caller. Three items sat `running` with leases expired
by seven minutes; no worker would ever lease them again, and the job could not
finalise while any item was outstanding. Recovery required hand-written SQL.

*Why the tests missed it:* they called the function directly. They proved it
worked; nothing proved anything used it.

*Fixed:* the reclaim now runs at the top of `POST /jobs/lease`. Any worker
asking for work first returns abandoned work to the pool, which self-heals with
a single worker too — a restarted worker recovers its predecessor's items. No
scheduler, no leader election, nothing to forget to run. Pinned by
`packages/api/test/internal-lease.test.ts`, which drives the HTTP handler rather
than the function, so a future refactor that drops the call fails.

**C2 — A DNS failure permanently discarded a URL and called it a policy block.**
The pre-flight guard treated *every* failure as `blocked` and `retryable: false`.
But the guard fails for two categorically different reasons: "this host is not
allowed" (an answer — retrying cannot change it) and "we could not determine
whether it is allowed" (the absence of an answer). Conflating them meant a
resolver hiccup deleted URLs outright.

*Measured cost:* one browser run produced 31 such items — zed.dev, neovim.io,
fonts.google.com, code.visualstudio.com, www.figma.com, about.gitlab.com among
them. All six resolve fine on retry. All 31 were discarded with no retry, and
were reported as "blocked", which reads as *refused by policy*.

*Also:* the two code paths that make this decision had already drifted. The
level-1 fetch path treated a DNS failure as retryable; the pre-flight guard did
not. The same failure got a different verdict depending on which check saw it.

*Fixed:* `isGuardPolicyRefusal()` in `packages/crawler/src/url-guard.ts` is now
the single answer both paths ask, with a test that fails if a new failure kind
is added without a recorded retry decision.

### HIGH

**H1 — A page's subresources bypassed the SSRF guard's address checks.** The
main document gets the full treatment: resolve, classify every answer, pin the
winner. Subresource requests were screened by hostname *pattern* only —
`.local`, `.internal` and friends — because the screen runs hundreds of times
per page and was written to be synchronous.

That leaves a real hole. `evil.example.com` with an A record of `10.0.0.5`
passes a suffix check cleanly, and Chromium then connects to an internal host
from inside our network, on behalf of a page we do not control. Cloud metadata
endpoints are reachable the same way.

*Fixed:* `hostResolvesToPublicAddress()` resolves and classifies, and the screen
memoises one verdict per hostname per capture — so a page pulling forty files
from four CDNs pays four lookups, not forty. It fails closed: a subresource that
cannot be verified is not loaded, which trades a slightly poorer screenshot for
not being an SSRF. The promise is cached rather than the result, so a hundred
simultaneous requests to one new host share a single lookup.

**H2 — A job whose last items were lost stayed `running` for ever.** Job
completion is checked when a worker *reports* an outcome. A lost worker reports
nothing, so when the reclaim retired a job's final items to `dead_letter` —
a terminal status — nothing noticed the job was finished. The CMS showed a crawl
in progress that nothing would ever advance. This is what left `JOB-S1R2GX1Y`
stranded even after C1 was fixed.

*Fixed:* the reclaim now finalises every job it dead-lettered an item for,
outside the per-item transactions so a job is judged on the state all of them
left behind. Pinned by a test that asserts the job leaves `running` and gets a
`finished_at`.

**H3 — Nothing warns that a published item is unreachable.** The publish gate
checks status, approval record, rights, title, slug and media. It does not check
taxonomy. Eight published items currently carry zero accepted terms, so they
appear in no facet and under no filter. They remain reachable by direct URL and
by full-text search, which is why this is HIGH and not CRITICAL — but for a
reference library whose primary use is browsing by category, publishing an
untagged item is close to a no-op accompanied by a success message.

*Not fixed.* A hard blocker is the wrong call — an operator may legitimately
publish something reachable only by search — and adding a warning framework is a
feature, not an audit finding. Recommendation R4.

### MEDIUM

**M1 — The analysis script counted successful dedupe as failure.** A re-crawl of
an unchanged page is reported `skipped_duplicate`, which is the dedupe working.
Counting it against the success rate made a second run of the same dataset read
as a collapse from 76% to 16% when almost everything had in fact worked and 54
pages were simply unchanged. *Fixed:* duplicates are excluded from the
denominator and reported on their own line.

**M1b — A binary response became a reviewable content item.** A URL answering
`application/octet-stream` was captured, marked `succeeded`, and given a content
record in the review queue with no title, no text and **no content hash**. The
missing hash is the part that compounds: change detection compares hashes, two
nulls compare equal, so the record deduped against itself on every subsequent
capture and could never be corrected. It took a database integrity check to
notice — nothing in the CMS distinguishes it from a real page.

*Fixed:* a non-textual body now fails with `This URL returned
application/octet-stream, not a web page.` Escalating to a browser would not
help; Chromium renders a PDF or an image in a viewer, and a screenshot of a
viewer is not the document. Verified end-to-end: the item now reports `failed`
and creates no content record.

**M1c — `taxonomy_terms.usage_count` reported usage that did not exist.**
`recomputeTermUsage` counted every assignment that was not *rejected*, which was
equivalent to counting accepted ones right up until something produced
suggestions. One classification run put 456 pending suggestions in the table and
**20 of 224 terms** began over-reporting — `button` showed 56 uses with no
content actually carrying it. The number a curator uses to decide whether a term
is worth keeping was inflated by unreviewed machine guesses.

*Fixed:* it counts accepted assignments only, which is also the definition the
public facets already use (`HUMAN_CONFIRMED_ORIGINS`), so the CMS and the public
site now agree. It has the useful property that only review actions can change
the count, so no capture path needs to remember to call it. The integrity check
was comparing against the wrong definition too, and now matches.

**M2 — Per-host rate limiting provides no protection for a broad crawl.** The
limiter paces requests per host. A "one page from each of 87 sites" job — the
exact shape of a research crawl — never hits a per-host limit at all, so the
only ceiling is worker concurrency. Nothing bounds total outbound work, and
nothing bounds the DNS traffic Chromium generates for third-party subresources,
which is the most likely origin of the resolver exhaustion behind C2.
*Not fixed.* Recommendation R3.

**M3 — Half the review workflow has never executed.**
`classification_suggestions` is structurally unreachable: the heuristic provider
returns `fieldSuggestions: []` unconditionally, and only the Anthropic provider
populates them. With no API key configured, the write path has never run and has
no test. *Not fixed.* Recommendation R6.

**M4 — Two tables have readers but no writer.** `interaction_details` and
`state_details` are defined in the schema and left-joined by the CMS detail
query. Nothing writes them, so the CMS renders a section that cannot populate.
See §7 for what it would take.

### LOW

- **L1** — `docs/security.md`, `worker.md` and `architecture.md` described the
  worker's blast radius as "a bearer token good for six endpoints". There are
  eleven. *Fixed*, and `security.md` now lists them, because a boundary
  described loosely stops being checkable.
- **L2** — The dataset labelled `httpbin.org/delay/10` as expected-to-fail. Ten
  seconds is inside the 20-second navigation timeout, so it succeeds, and the
  run looked worse than it was. *Fixed.* A reminder that the dataset's labels
  are a hypothesis to check, not ground truth.
- **L3** — The HTTP-vs-browser table reported a storage ratio of `159812180×`,
  a division by the zero bytes level 1 stores. *Fixed*: it now says storage goes
  from nothing to 152MB, which is a category difference rather than a big
  number.
- **L5** — `sources.content_count` had exactly one maintainer: a `+ 1` in
  capture intake. Nothing decremented it and nothing recomputed it. No content
  can be deleted through the application today, so nothing has drifted yet —
  but `content_items.deleted_at` exists and is only ever read, which says a
  delete path is expected, and an increment would then leave every source
  over-reporting for ever. *Fixed* by recomputing, matching the pattern media
  and taxonomy already use. This is the same shape as M1c, caught before it
  could bite.
- **L6** — The response-size bound had no test, and the dataset URL believed to
  be covering it was not. `httpbin.org/bytes/20000000` was labelled "20MB
  response — exceeds the response-size cap"; httpbin caps that endpoint at
  102,400 bytes, so the body always arrived complete and well under the limit,
  and the bound was never once exercised. *Fixed:* the label is corrected and
  `packages/crawler/test/http-bounds.test.ts` covers the limit against a
  synthetic stream, including the exact-boundary case and a body that never
  ends. No public endpoint can be relied on to keep sending until we say stop,
  which is why a limit like this belongs in a unit test.
- **L4** — Five tables are empty: the three above plus `content_relations` and
  `worker_tokens`. The last is expected in development (the shared-secret
  bootstrap path is in use); `content_relations` is unbuilt.

### FUTURE

- **F1** — Interaction capture. Feasible, but not as currently modelled (§7).
- **F2** — Classifier evaluation. Requires a deliberately double-labelled
  holdout set; cannot be derived from existing data (§6).
- **F3** — `content_relations` (related pages/screens) has a schema and no
  producer.

---

## 3. Capture, measured

87 URLs across 87 hosts, 24 declared scenarios, discovery off (`maxDepth: 0`),
one page per host, robots.txt respected. Dataset in
`scripts/experiments/dataset.mjs`.

| | HTTP (level 1) | Browser (level 2) |
|---|---|---|
| success, URLs expected to work | 76% clean baseline · 52% degraded run | 50% |
| pages with a title | 57% | **88%** |
| pages under 50 words extracted | **36%** | **3%** |
| capture p50 | 1,697ms | 20,531ms |
| capture p90 | 14,489ms | 27,704ms |
| media stored | none | 124 files, 152.4MB |
| per page | — | p50 2,681KB · mean 4,877KB · max 19.5MB |

**The decisive number is not the success rate, it is the 36%.** More than a
third of pages that HTTP capture reported as *succeeded* yielded under fifty
words — the signature of client-rendered content. Level 1 does not fail on those
pages; it succeeds and stores almost nothing, which is worse, because a failure
is visible and an empty success is not. The browser reduces that to 3%.

The browser costs 12.1× the time at p50, and takes storage from zero to 152MB
for 32 pages.

Both success rates above are degraded by the two defects this run found, not by
the pipeline: the HTTP figure by C1's stuck items and rate-limit timeouts, the
browser figure by C2's 31 spurious DNS blocks. The clean HTTP baseline before
those fixes was **66 of 87 (76%)**.

### Projections

Single worker, 20.5s median browser capture, one page per site:

| sites | 1 worker | 4 workers | 16 workers | storage |
|---|---|---|---|---|
| 1,000 | 5.7h | 1.4h | 0.4h | 4.7GB |
| 10,000 | 57.0h | 14.3h | 3.6h | 46.5GB |
| 100,000 | 570.3h | 142.6h | 35.6h | 465.1GB |

Storage is the binding constraint long before time is. At 4,877KB per page the
current derivative settings cost roughly half a terabyte per hundred thousand
pages, and the tallest page measured was 36,651px (RFC 9562) producing a 19.5MB
full-page screenshot.

### What the scenarios revealed

- Redirects, cookie banners and slow responses were handled without incident.
- The one page under 50 words in the browser run was a redirect target, not a
  rendering failure.
- Media dedupe is working but has little to do: 124 usages across 115 distinct
  files (1.08 per file), as expected for one page per host.
- **Verified working:** a page captured at level 1 and re-captured at level 2
  gains its screenshots. 11 items marked `skipped_duplicate` on the browser run
  still attached 40 media assets, because the duplicate check gates the version
  bump and review re-open, not media. Capture-level upgrade is possible after
  the fact.

---

## 4. Failure handling, measured

Real failure modes encountered, with the classification the operator sees:

| error | n | outcome | correct? |
|---|---|---|---|
| `NAVIGATION_FAILED` (DNS) | 31 | was `blocked`, now `failed` + retryable | fixed (C2) |
| `NAVIGATION_FAILED` (other) | 4 | `failed`, retryable | yes |
| `ROBOTS_DISALLOWED` | 3 | `blocked`, terminal | yes |
| `CAPTURE_TIMEOUT` | 2 | `failed`, retryable | yes |
| `CAPTURE_FAILED` | 1 | `failed`, retryable | yes |
| `WORKER_LOST` | 3 | `dead_letter` after attempts exhausted | yes |

`WORKER_LOST` items reached `dead_letter` at one attempt because the job was
configured with `maxAttempts: 1`. That is correct behaviour, and the message
("The worker handling this URL stopped responding and it ran out of attempts")
is one a non-engineer can act on.

A reclaimed item is deliberately **not** handed straight back out: it gets an
exponential backoff on `available_at`. Whatever killed the worker is likely
still true a millisecond later, so an immediate re-lease would spin a URL
through workers as fast as they can die on it. This is now pinned by a test,
because it looks like a bug until you know why it is there.

---

## 5. Review workload, measured

From `npm run audit:review-load` against 102 content items:

- **6.4 pending decisions per classified item** (462 pending across 72 items).
- Distribution is bimodal: 12 items generate 1 decision each, 15 generate 9.
- Projected: **3,208 decisions at 500 items — 7.1 hours** of one-by-one review,
  or 81 pages of the bulk-accept queue.

Bulk accept and reject exist and are wired to the queue UI, sorted by confidence
descending, 40 per page. That is the right shape. The problem is what it sorts
by:

```
0.5-0.6  = 8
0.6-0.7  ============================================ 296
0.7-0.8  ============= 86
0.9-1.0  =========== 72
```

**64% of all pending suggestions sit in one band, and the score has only ten
distinct values** spanning 0.55–0.95 (the 0.8–0.9 band is empty entirely). These
are rule weights, not calibrated probabilities. Sorting by them gives an
operator almost no triage leverage: after the top 72 there are 296 suggestions
that are indistinguishable from each other by score.

§14 of the brief is honoured — every suggestion lands `pending`, nothing
auto-applies at any confidence, and 456 of 456 AI suggestions were awaiting
review.

---

## 6. Classifier accuracy is unmeasured

23 items carry human labels. 72 carry AI suggestions. **Exactly one item has
both**, and on that item they agree on nothing.

That is not a precision figure, it is the absence of one. The human-labelled
items are seed data and the AI-labelled items are crawled, so the two sets never
meet. Nothing in the current data can tell you whether the heuristic classifier
is better than random.

This matters because the system is asking a human to make 6.4 decisions per item
on the strength of those suggestions. If precision is high, the fix for §5 is a
confidence threshold. If it is low, the suggestions are *negative* value —
they cost review time and anchor the reviewer's judgement.

**Deciding which requires a deliberately double-labelled holdout set.** There is
no way to shortcut it, and it should happen before any effort goes into
improving the classifier, because right now there is no baseline to improve
against.

---

## 7. Interaction capture — PoC results

`scripts/experiments/interaction-poc.mjs`, six pages, structural discovery only
(ARIA attributes and semantic elements — no per-site selectors), Chromium
sandbox enabled, nothing stored.

- **106 candidates found across 6 pages** (~18/page) with zero site-specific
  configuration.
- **30 probed · 22 produced a state change (73%)** · 5 inert · 3 selector errors
  · **0 navigated away**.
- **~258KB per usable before/after pair**, unoptimised.

So the mechanism works. Disclosure-type interactions — accordions, nav menus,
theme togglers, modals — are found and operated reliably, and `aria-expanded`
flipping is machine-checkable proof the interaction fired.

**But the component type cannot be inferred, and that is the finding.** Only
1 of 6 pages yielded every interaction type it was chosen for:

- The carousel page produced **2 candidates, neither of them the carousel**.
  Carousel controls do not use `aria-expanded`, so structural discovery is blind
  to them.
- The dropdowns page produced 48 candidates, all typed `click`, because the
  attribute that found them says only "this toggles something".
- Three items on the dropdowns page were inert *because they sit inside a closed
  dropdown*. Operating them requires opening the parent first —
  **interaction capture needs sequences, not single actions.**

`interaction_details.interaction_type` is a `NOT NULL` enum. Writing a guess
into a required field would put unreliable data in the one place the system's
value depends on being true — the same mistake as recording `browser_render`
provenance for a generated PNG, which this audit already corrected once.

**Recommendation:** treat interaction capture as operator-assisted, not
automatic. Discovery proposes candidates with evidence; a person confirms what
each one *is*. The 73% hit rate makes that a genuinely useful assist. Fully
automatic classification of interaction types is a research project, not a
feature.

---

## 8. Security audit

Verified working under real traffic:

- Five-layer SSRF guard. Re-verified this phase: `--profile=validate` over the
  98-URL dataset reported *every URL that must be refused was refused (10)* —
  `file://`, `ftp://`, `gopher://`, localhost, private ranges, credentials in
  the URL, non-standard ports. 8 blocked, 3 invalid, 0 leaks.
- Address pinning via undici `connect.lookup` and Chromium
  `--host-resolver-rules`; a host answering with both public and private
  addresses is refused outright rather than "mostly public".
- Chromium sandbox enabled throughout, including in the interaction PoC.
- Worker isolation: HTTP-only control plane, bearer token, zero database or
  storage credentials. `loadWorkerEnv` refuses to start if a forbidden variable
  is present at all, so handing the worker a copied `.env` is a crash rather
  than a silent expansion of blast radius.
- Subresource request screening: protocol allowlist, IP-literal classification,
  page-weight budget — **and now resolved-address classification** (H1).
- Untrusted-input discipline held: page-authored selectors go only to
  Playwright's locator API, page text is control-stripped and truncated before
  display, and no page-derived value is ever re-entered as code.

Gap closed this phase: H1. No other SSRF gap found.

---

## 9. The next ten changes, in priority order

Ordered by measured consequence, not by effort.

1. **R1 — Build a double-labelled holdout set of 100 items** and measure classifier
   precision and recall. Nothing else about classification can be decided
   without it, and §5's 3,208-decision workload is only worth optimising if the
   suggestions are worth reviewing. (§6)

2. **R2 — Replace the confidence score with something separable, or stop sorting by
   it.** Ten discrete rule weights with 64% in one band cannot triage a queue.
   If precision turns out to be high, group by *rule* instead — an operator can
   reason about "every suggestion from the fintech-domain rule" in a way they
   cannot about "0.65". (§5)

3. **R3 — Add a global outbound ceiling and a DNS concurrency limit.** Per-host
   pacing does nothing for a one-page-per-site crawl, and unbounded subresource
   resolution is the likely cause of the resolver exhaustion that produced C2's
   31 spurious blocks. (M2)

4. **R4 — Warn — do not block — when publishing an item with no accepted taxonomy.**
   Eight items are live and in no facet. The operator should be told they are
   publishing something unbrowsable and be allowed to proceed. (H3)

5. **R5 — Default new jobs to `maxCaptureLevel: 2`, and treat a level-1 success with
   under 50 words as a failure requiring escalation.** 36% of level-1 successes
   are near-empty. An empty success is more damaging than an error because
   nothing surfaces it. (§3)

6. **R6 — Wire an LLM classification provider, or delete
   `classification_suggestions`.** A table with a reader, no writer, and no
   test is a claim the system does not honour. Either is defensible; the current
   state is not. (M3)

7. **R7 — Show duplicate, limit-skipped and blocked as three separate things in the
   CMS.** `skipped_count` currently aggregates duplicates, and "54 skipped"
   tells an operator nothing about whether that is good news (nothing changed)
   or bad (a limit fired). The data model already distinguishes them —
   `duplicate_count` is tracked separately — so this is presentation only.

8. **R8 — Cap full-page screenshot height and store a downscaled derivative.** One
   36,651px page produced a 19.5MB PNG; at 4,877KB per page the projection is
   465GB per 100,000 pages. Storage binds long before time does. (§3)

9. **R9 — Make interaction capture operator-assisted and ship the discovery half.**
   73% of structurally-found candidates produce a real state change. Propose
   candidates with their evidence, let a person confirm the type, and do not
   write a guess into a `NOT NULL` enum. (§7)

10. **R10 — Add an end-to-end test that drives the HTTP handlers for every worker
    lifecycle path.** C1 is the defining bug of this audit: a function with four
    passing tests and no caller. The tests were not wrong, they were testing the
    wrong altitude. `internal-lease.test.ts` now covers lease and reclaim;
    heartbeat, report, and media intake have the same exposure.

---

## 10. What this audit changed about how to test this system

Fourteen of the fifteen product defects were invisible to a passing suite. The
two mechanisms that found them are worth keeping:

**Ask the database whether the schema's promises are kept.**
`audit-integrity.mjs` verifies invariants against real rows — 37 checks, no
fixtures. It found `childCount` returning 0 across 82 real rows, which every
unit test agreed was correct.

**Run the real pipeline against the real web and tag every result.**
`run-crawl.mjs` found six defects in two runs. A 78% success rate says nothing;
"every failure was a `spa`", "31 blocks were all one error code that should not
be a block", and "36% of level-1 successes extracted nothing" are each directly
actionable.

The pattern in every case was a component that was correct in isolation and
wrong in composition: a limiter constructed per item so its map was always
empty, a reclaimer nobody called, a robots decision made from a truncated
excerpt, a guard whose two callers disagreed about the same failure. Unit tests
are the wrong altitude for all four.

Two of the later findings add a second pattern worth naming: **a maintained
counter with one maintainer is a latent bug, and an empty table hides a wrong
definition.** `usage_count` counted "not rejected" and was indistinguishable
from correct until something produced a pending row. `content_count` counted
upwards only and is indistinguishable from correct until something deletes.
Both were written before the code that would break them existed, and no test
could have caught either, because at the time neither was wrong. The check that
found them asks the database a question that does not depend on which code paths
happen to exist yet.
