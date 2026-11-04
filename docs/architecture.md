# Architecture

## The shape of it

Three processes and one database.

```
                       ┌──────────────────────────────────────┐
                       │  Postgres                            │
                       │  32 tables · durable job queue       │
                       └───────────────┬──────────────────────┘
                                       │ pg (the only driver)
                                       │
   ┌───────────────────────────────────┴───────────────────────────────┐
   │  CMS  (apps/cms)                       Next.js · port 3000        │
   │                                                                   │
   │  23 screens              /api/internal/*        /api/public/*     │
   │  server actions          worker control plane   read-only         │
   └──────────┬────────────────────────┬──────────────────┬───────────┘
              │                        │                  │
              │ presigned or            │ HTTP + bearer    │ HTTP
              │ session-gated           │ token            │
              ▼                        ▼                  ▼
   ┌──────────────────┐   ┌────────────────────┐   ┌──────────────────┐
   │ Object storage   │   │ Capture worker     │   │ Public site      │
   │ S3 / local       │   │ apps/ingestion-    │   │ apps/frontend    │
   │ screenshots      │   │ worker             │   │ Next.js · 3001   │
   └──────────────────┘   │                    │   │                  │
                          │ Playwright         │   │ no DB, no keys   │
                          │ sandboxed Chromium │   └──────────────────┘
                          │ NO db credentials  │
                          └─────────┬──────────┘
                                    │ HTTPS
                                    ▼
                            the open internet
                          (hostile input)
```

The three arrows crossing a process boundary are the whole design. Everything
else is detail.

## Why the worker is a separate process

The brief requires it — "Playwright and Crawlee must NOT run arbitrary websites
directly inside the main CMS server process… The worker should be treated as
hostile-input infrastructure" — and the requirement is right, so it is worth
saying what it buys.

A browser rendering an arbitrary website is the least trustworthy code in the
system. It executes attacker-authored JavaScript by design. Chromium's sandbox
is good and is left enabled, but the correct assumption is that it will
eventually be escaped, and the question that matters is what an attacker holds
when that happens.

In this design they hold: a bearer token good for eleven endpoints under
`/api/internal/*`, and a scratch directory. They do not hold a database URL, an
object-storage key, the session secret or an API key, because those are not in
the worker's environment. `loadWorkerEnv` refuses to start the process if any of
them is present at all, so handing the worker a copied `.env` is a crash rather
than a silent expansion of blast radius. `scripts/check-boundaries.mjs` fails
the build if the worker package gains an import of `@uxd/database`, `@uxd/auth`
or the storage layer.

That is the difference between "we separated the processes" and "the separation
is load-bearing".

## Packages

`/packages` holds seven libraries plus the seed. The split follows the
dependency direction, not a filing system: nothing below a line may import from
above it.

| Package | Depends on | What it holds |
|---|---|---|
| `shared` | — | URL parsing and normalisation, env schemas, logging with redaction, ids, hashing, text sanitisation, retry, errors |
| `types` | shared | The domain vocabulary: lifecycle statuses and their legal transitions, permissions, rights statuses, job config schema, the publish gate |
| `database` | shared, types | Drizzle schema, migrations, the queue implementation, the client |
| `crawler` | shared, types | SSRF guard, guarded HTTP, Playwright capture, robots, extraction. **No database.** |
| `media` | shared, types | Type sniffing, validation, derivatives, hashing, storage drivers |
| `classification` | shared, types | Heuristic and Anthropic providers |
| `auth` | shared, types, database | Password hashing, sessions, permission checks |
| `api` | all of the above | Queries, services, serialisers, routers, and the public client |
| `seed` | database, auth, types | Development seed data only |

Two of those boundaries do real work.

**`crawler` has no database dependency.** It cannot, because it runs inside the
worker. That forces every crawl result to travel back through the control-plane
API, which is where it gets validated — rather than being written straight to a
table by the process that just ran attacker-controlled JavaScript.

**`api/client` is a subpath with no dependencies at all.** It duplicates the
public response shapes rather than importing them from `serializers.ts`. That
duplication is deliberate: it is what lets the public site consume the API
without transitively acquiring Drizzle, the schema, or the crawler. The
duplication is small, and the alternative is a frontend that can `import { db }`.

## Stack, and the decisions worth defending

**TypeScript 5.9.3, strict, with `noUncheckedIndexedAccess` and
`erasableSyntaxOnly`.** The second flag rules out TS enums and parameter
properties, so every file is valid under type-stripping — which is what lets
`node --experimental-strip-types` run the test suite with no build step.

**Postgres, one driver (`pg`), one dialect, everywhere.** Not "Postgres in
production, SQLite locally". Dialect drift is the kind of bug that is invisible
until it is expensive: `tsvector`, `FOR UPDATE SKIP LOCKED`, partial unique
indexes and generated columns are all load-bearing here, and none of them
behaves the same on another engine.

**PGlite over the wire protocol for local development.** Real Postgres 18.3
compiled to WASM, served on TCP by `npm run db:serve`. Same driver, same SQL,
same migrations, no Docker, no install. The tradeoff is documented in
[known-limitations.md](known-limitations.md) — it shares one backend, so the
local pool is pinned to a single connection — and it is a tradeoff worth making
for a `git clone && npm run setup` that works.

**Postgres for the job queue, not Redis.** `FOR UPDATE SKIP LOCKED` with lease
tokens, heartbeats and lease reclamation. The alternative buys throughput this
system will never need — the bottleneck is a browser rendering a page, measured
in seconds — and costs a second piece of infrastructure to run, back up and
reason about. It would also put job state somewhere other than where the content
state lives, which means a transaction can no longer span both.

**Drizzle, not an ORM with a runtime.** The schema is TypeScript that generates
SQL migrations, so a column's type, its index and its constraint are one
declaration. There is no lazy loading to accidentally trigger and no query the
library builds that isn't in the file.

**Hono for the two API surfaces.** Two routers mounted on the Next route
handlers. It is a router and a validator, which is all an API of this size
needs.

**Playwright, but not Crawlee.** The brief specified both. Playwright is used
as specified, for browser execution and visual capture. Crawlee is not, and
this is the one deliberate deviation.

Crawlee's request queue is its own state store — memory, filesystem, or the
Apify platform — which puts the authoritative list of what to capture *inside
the worker*. That conflicts with two other requirements in the same brief: §6
wants the queue to survive a worker crash, and the isolation requirement means
the worker holds no database credentials and reaches the CMS only over HTTP. A
queue living with the worker satisfies neither.

So orchestration is the Postgres queue for scheduling and durability,
`guardUrl` for policy, `BrowserPool` for browser lifecycle, `fetchGuarded` for
HTTP. Removing the unused dependency also took the worker from twelve moderate
advisories to zero — `@crawlee/core` pulls a `stream-json` carrying a DoS
advisory, and holding that in the process that handles hostile input for no
functional benefit was worse than not having it. Full reasoning in
[known-limitations.md](known-limitations.md).

## The one rule everything else follows

> The CMS is the source of truth. Everything shown publicly must originate from
> CMS-controlled records. The public frontend must NEVER independently create or
> maintain content.

Made structural in four places, so it holds without anyone remembering it:

1. **`apps/frontend` has one data source.** `src/lib/api.ts` is the only module
   that fetches anything, it speaks to the public read API, and the client it
   uses has no write method to call.
2. **Public queries start from the gate.** Every function in
   `queries/public.ts` begins from `publishedContentCondition()`. There is no
   public query that filters *afterwards*.
3. **Serialisers construct, never filter.** `serializers.ts` builds its output
   field by field from an allowlist, so a new internal column cannot leak by
   being forgotten. `findLeakedFields` walks the result at every depth, and the
   test feeds it rows where every internal field is a recognisable sentinel.
4. **The database refuses the invalid state.** `content_items_publishable` is a
   CHECK constraint: a row cannot be `published` without a title, a slug, a
   published timestamp and a non-blocking rights status. A bug in the service
   layer becomes a constraint violation rather than a disclosure.

## What is verified, and how

| | |
|---|---|
| `npm test` | 238 tests. SSRF and address classification (44), URL parsing and normalisation (34), media processing (33), the queue against real Postgres (27), classification (23), permission boundaries (22), public queries (18), the publish gate (16), leak prevention (13), recapture (7) |
| `npm run typecheck` | The build graph, plus a second pass over the test files — which are excluded from every package build and would otherwise never be typechecked at all |
| `npm run check:boundaries` | 6 architectural invariants: the frontend has no database, the worker is isolated, the browser sandbox is never disabled, no logic branches on a specific taxonomy term, dependencies are pinned, no hardcoded URLs |
| `npm run check:sql` | Every correlated subquery in a select-list projection qualifies its outer reference. See [known-limitations.md](known-limitations.md) for why this needs a checker |
| `npm run smoke` | 53 HTTP checks against a running CMS, including that no public response carries an internal field and that a session cookie cannot act as a worker credential |
| `npm run verify:pipeline` | 16 checks spanning all three processes: a CMS decision reaching the public site, and a rights hold withdrawing it again |

The last two need a running stack, which is the point — they check the things a
unit test structurally cannot.
