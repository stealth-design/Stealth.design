# Known limitations

Stated plainly. Anything here is a thing I know is missing, wrong, or true only
in development — not a thing I hope nobody notices.

## Deviations from the brief

### Crawlee is not used

The brief specified "Crawlee for crawl orchestration". It is not used, and the
dependency has been removed.

The reason is a genuine conflict with two other requirements. Crawlee's request
queue is its own state store — memory, filesystem, or the Apify platform —
which would put the authoritative list of what to capture *inside the worker*.
But §6 requires the queue to survive a worker crash, and the worker isolation
requirement means the worker holds no database credentials and reaches the CMS
only over HTTP. A queue that lives with the worker cannot satisfy either.

So orchestration is: the Postgres queue for scheduling and durability (`FOR
UPDATE SKIP LOCKED`, lease tokens, heartbeats, reclamation), `guardUrl` for
policy, `BrowserPool` for browser lifecycle, `fetchGuarded` for HTTP. Playwright
*is* used, as specified, for browser execution and visual capture.

Removing the unused dependency also took the worker from **12 moderate
advisories to zero** — `@crawlee/core` pulls a vulnerable `stream-json` with a
DoS advisory, and carrying that into the process that handles hostile input for
no functional benefit was strictly worse than not having it.

`CRAWLEE_STORAGE_DIR` keeps its name so existing configuration does not need
editing. It is now just where Playwright's per-item scratch goes.

## Development-only

### PGlite has one backend

The local database is PostgreSQL 18 compiled to WASM. Genuinely Postgres — same
driver, same SQL, same migrations, same `tsvector` and `SKIP LOCKED` behaviour.
But it is *one* backend behind the socket server, and the **unnamed prepared
statement** the extended protocol uses is global to that backend rather than
per-connection.

Two consequences:

**Local pools are pinned to one connection.** Otherwise two pooled connections
issuing parameterised queries concurrently overwrite each other's Parse, and the
loser fails with `bind message supplies N parameters, but prepared statement ""
requires M` — an error with no relationship to the query that reports it.
Drizzle parameterises everything and list queries run rows and count
concurrently, so this is reachable in ordinary use.

**Tests run one file at a time** (`--test-concurrency=1`). One connection per
process does not help when the *processes* are parallel. Without it, three queue
tests fail intermittently — and one of them fails by returning 18 of 20 claimed
items rather than erroring, which is the worst shape of failure. Cost: the suite
goes from ~0.8s to ~2.9s.

Neither applies to real Postgres.

### The extended-protocol desync

An error raised during a parameterised query can leave a PGlite socket
desynchronised, so the *next* unrelated statement on that connection fails.
`createResilientExecutor` destroys a connection whose query failed
(`client.release(err)`), which contains it — enabled only for local drivers.

If a cascade of unrelated-looking errors does start, restart `npm run db:serve`.

### `pool.end()` can hang

Intermittently, against PGlite, even with one idle connection and nothing
waiting. `close()` is therefore bounded by a timeout and resolves anyway,
logging at debug. Worth bounding against real Postgres too: a deploy that hangs
on shutdown is worse than one that drops a connection the server reclaims on
socket close.

### `local` storage is not durable storage

Production boot refuses `STORAGE_DRIVER=local`. Screenshots are the expensive
artefact and a container filesystem is not where they belong.

### `drizzle-kit` pulls a vulnerable esbuild

Four moderate advisories, all from `drizzle-kit` → esbuild. `npm audit
--omit=dev` reports **zero**, because `drizzle-kit` is a CLI used by
`db:generate` and never loaded by a running service. Waiting on an upstream
bump rather than forcing a resolution.

## Incomplete

### The CMS CSP needs `unsafe-inline`

Next's runtime injects inline scripts and styles. A nonce-based policy is
possible and is real work. The clauses that matter are in place —
`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.

The public site is stricter: `connect-src 'self'`, and `unsafe-eval` only in
development, where React's development build genuinely calls `eval()`.

### Rate limiting is per instance

In-memory, on the public API. With three instances the effective limit is three
times the configured one. Honest rather than hidden; a shared counter is on the
list.

Worker rate limiting is also per worker. Two workers on the same host at 20
requests per minute make 40. Job configuration divides by expected worker count,
which is a workaround, not a solution.

### No CSRF token

Server actions rely on `sameSite=lax` plus Next's action encoding. Adequate
against classic form CSRF; a double-submit token would be better and is a small
change.

### Sessions cannot be revoked in bulk

A single session can be deleted. "Sign out everywhere" means rotating
`SESSION_SECRET`, which signs *everyone* out. A `sessions_valid_after` column
per user is the fix.

### No email

No verification, no password reset, no notifications. An admin creates users
and sets passwords. Deliberate — an email dependency is a deployment
dependency, and nothing in the pipeline needs it.

### Change detection has no visual diff

Content hash, layout hash, DOM hash, and a structural change summary. It will
tell you *that* a page changed and roughly where. It will not show you a
pixel diff of two screenshots, which is what a designer actually wants.
Perceptual hashes make it feasible; it is not built.

### Flow authoring is read-only in the CMS

Flows, steps and ordering are modelled, seeded, served and rendered. There is no
screen to *build* a flow by picking screens and dragging them into order — the
demo seed writes them directly. This is the largest single gap in the CMS.

### Taxonomy editing is read-only

The Taxonomy screen lists, groups, indents and searches. Creating, renaming,
re-parenting, aliasing and archiving a term go through the database or the seed.
Assignment review is fully built; vocabulary maintenance is not.

### No user management screen

Roles and permissions are complete and enforced. Creating a user, changing a
role and deactivating an account are database operations. Settings shows workers
and the queue, not people.

### Interaction and state capture is modelled, lightly exercised

The schema, the types, the capture levels and the deterministic-interaction
flags are all there, and `runInteraction` executes operator-defined steps. What
has been exercised end to end is page and screen capture. Recording a hover
state or a modal open as its own content record works in principle and has not
been run at volume.

## Rough edges

### `/media/media/...` has a doubled segment

Storage keys begin `media/`, and the route is mounted at `/media`. Cosmetic,
and changing it would invalidate every stored URL for no functional gain.

### Media can be orphaned by a failed intake

`ingestMedia` writes bytes and a row, then `intakeCapture` attaches it. A crash
between the two leaves an asset with no usage. It is not lost — the Media
screen's "unused" filter finds it — but nothing reaps it automatically.

### The public site caches API reads for 60 seconds

So a record published a moment ago can take up to a minute to appear on a
listing page. Correct behaviour, occasionally surprising. `verify-pipeline`
polls rather than asserting immediately, for exactly this reason.

### `pg_trgm` is deliberately not load-bearing

Absent from PGlite. A development environment that cannot run a production
query is worse than slightly weaker fuzzy matching, so substring search uses
`ilike`. Full-text search uses `tsvector`, which PGlite has.

### The demo seed writes rows directly

It does not walk each record through discover → capture → review → publish. The
rows still satisfy every CHECK constraint a real record does, and media does go
through the real pipeline. But it is not a test of the pipeline — `npm run
verify:pipeline` is.

## Not built, deliberately

§38's list, which is a specification of scope rather than an omission:
community and social features, likes and follows, public profiles,
personalisation, AI design generation, a recommendation engine, a Figma plugin,
an MCP server, the "understand every interaction" system, the graphic design,
brand identity and motion modules, billing, advanced collaboration, and complex
analytics.

The module seam is in place so the content modules can be added without
touching the core model — see [database.md](database.md).

## A note on the bug class worth knowing about

`npm run check:sql` exists because of something that would otherwise keep
recurring: **Drizzle qualifies an interpolated column with its table name only
when the outer query has a join.** A single-table select emits no qualifiers,
and that omission propagates into raw `sql` fragments in the select list.

```ts
.select({ n: sql`(select count(*) from ${contentItems} ci
                  where ci.source_id = ${sources.id})` })
.from(sources)
// -> where ci.source_id = "id"   ← binds to ci.id. Count is silently 0.
```

Which means *whether a correlated subquery is correct depends on whether the
outer query happens to have a join*. Removing an unrelated join silently turns
a right answer into a wrong one.

Found in 33 places. Two of them were producing wrong numbers on screens that
looked fine: `publishedCount` on sources was always 0, and `childCount` on
taxonomy terms was always 0 across 82 real parent/child relationships. The
checker resolves names through Drizzle's own metadata and also understands FROM
aliases, which is what caught the second one — `from ${terms} c` binds the table
*only* as `c`, so an interpolated reference there is an outer reference even
though the same table appears in the FROM.

The rule: in a select-list fragment, write `${sources}.id`, not `${sources.id}`.
It renders identically with or without a join.

## Studio sessions and crawls share a worker

A live capture session holds a Chromium context open for as long as somebody is
using it, on the same worker that runs batch captures. Two live sessions plus a
crawl on one worker contend for CPU and for the browser pool, and the crawl is
what slows down — measurably: a 24-page discovery of linear.app took 74 seconds
with no session open and did not finish inside five minutes with two.

That is the expected shape, not a defect to tune around. A session is a person
waiting, a crawl is a machine waiting, and starving the crawl is the right
trade. The answer at scale is more workers, which is already how this scales —
`MAX_STUDIO_SESSIONS` in `apps/ingestion-worker/src/main.ts` caps sessions per
worker at 2, and nothing about the lease protocol assumes a single one.

What to watch for: a session opened while a large crawl is running will feel
sluggish, and the crawl's items may reach their lease expiry and be reclaimed —
safe, but wasted work. Pause the job first if it matters.

## The live view's relay is one process wide

The studio streams: Chromium's screencast goes worker -> CMS -> studio as a
multipart image stream, and the pointer and wheel are relayed as the hand moves.
The relay that joins the two halves is held in the CMS process's memory, which
is right for one CMS instance and wrong for several — a worker posting frames to
instance A would never reach a viewer connected to instance B.

Running more than one CMS instance means either pinning studio traffic to one
(sticky sessions on `/api/studio/*` and `/api/internal/sessions/*`) or replacing
the relay's maps with a shared pub/sub such as Redis. The relay's exported
functions are the seam; nothing above them would change.

A dev-mode quirk worth knowing: the first visit to the studio after a cold start
compiles three routes, so the first frame can take a couple of seconds. After
that, frames arrive in a few milliseconds.
