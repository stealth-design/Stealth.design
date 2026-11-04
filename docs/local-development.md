# Local development

## Requirements

Node 22.6 or newer. That is the whole list — no Docker, no Postgres install, no
Redis.

The database is [PGlite](https://pglite.dev): real PostgreSQL 18 compiled to
WebAssembly, served over the Postgres wire protocol on TCP by
`npm run db:serve`. The same `pg` driver, the same SQL, the same migrations as
production. See [known-limitations.md](known-limitations.md) for what it does
not do.

## Setup

```bash
git clone <repository> && cd uxdisrupt
npm install
npm run setup
```

`npm run setup` creates `.env` and `.env.worker` **with generated secrets**,
installs Chromium for capture, builds the packages, applies the migrations, and
seeds a base vocabulary plus an admin user. It never overwrites an existing env
file, and it is safe to re-run.

Then:

```bash
npm run db:seed:demo   # optional: a demo library to look at
npm run dev
```

`npm run dev` starts all four processes in one terminal with a coloured prefix
per process, and waits for each dependency rather than sleeping past it. It
adopts anything already running, so `npm run db:serve` in its own terminal plus
`npm run dev` works.

| | |
|---|---|
| CMS | http://localhost:3000 |
| Public site | http://localhost:3001 |
| Public API | http://localhost:3000/api/public |

Sign in at http://localhost:3000/login with `admin@localhost` /
`change-me-in-development`. **Change that password before the machine is
reachable by anyone else.** Set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
before seeding to choose your own.

### One process at a time

```bash
npm run db:serve      # embedded Postgres on 127.0.0.1:5432
npm run dev:cms       # the CMS
npm run dev:worker    # the capture worker
npm run dev:frontend  # the public site
```

Worth doing when you want a debugger attached, or a worker with different
limits, or the worker's log on its own.

## The demo library

```bash
npm run db:seed:demo
```

Six fictional products, twenty-eight records, two flows, two collections, and
real PNG screenshots — generated, not captured. It exists because "does the
grid work" is not a question you can answer against an empty database, and
capturing real sites to find out is slow and puts other people's material into
a demo.

Everything is **fictional**, every URL is under `example.com`, and the
screenshots depict nothing real. It refuses to run with
`NODE_ENV=production`.

Media goes through the real pipeline — sniffed, validated, hashed, dHashed,
thumbnailed — and rendering is deterministic, so re-running deduplicates
instead of accumulating copies. Content rows are written at their final state
rather than walked through the queue, but they still satisfy every CHECK
constraint a real record does.

## Your first capture

The demo seed shows you the shape of a full library; this shows you the
pipeline actually working.

1. **Ingestion** → paste a URL you are comfortable fetching. `https://example.com`
   is the polite choice.
2. **Validate**. Every line is reported in one of six buckets before anything
   is fetched. Nothing is silently dropped.
3. **Create the job** and start it.
4. **Crawl jobs** → watch it. The worker leases the item, renders it in a
   sandboxed Chromium, uploads the screenshots and reports back.
5. **Reviews** → the record is waiting. `A` approve, `R` reject, `P` approve
   and publish.
6. **Published**, and http://localhost:3001 — same record, public shape.

[test-crawl.md](test-crawl.md) walks through what each stage is actually doing.

## Working on the schema

```bash
npm run db:generate   # schema change → a reviewable SQL migration
npm run db:migrate    # apply pending migrations
npm run db:reset      # drop everything and re-migrate
npm run db:seed       # base vocabulary, settings, admin user
```

`db:generate` writes SQL for you to read rather than pushing to the database.
Two migrations are hand-written — see [database.md](database.md).

## Checks

```bash
npm run typecheck          # the build graph, plus a pass over the test files
npm test                   # 238 tests, needs db:serve
npm run check:boundaries   # 6 architectural invariants
npm run check:sql          # correlated-subquery qualification
npm run lint               # all of the above
npm run smoke              # 57 HTTP checks, needs a running CMS
npm run verify:pipeline    # 16 checks across all three processes
```

`npm run smoke` and `npm run verify:pipeline` need a running stack, which is
the point: they check things a unit test structurally cannot, like whether a
CMS decision reaches the public site and whether a rights hold withdraws it
again.

Tests run one file at a time (`--test-concurrency=1`). That is not a
preference — PGlite has a single backend, and parallel test processes
interleave on it. See [known-limitations.md](known-limitations.md).

## Layout

```
apps/
  cms/               Next.js · the control plane, both API surfaces
  frontend/          Next.js · the public site
  ingestion-worker/  Playwright · isolated, no database credentials
packages/
  shared/            URLs, env, logging, ids, hashing, text
  types/             lifecycle, permissions, rights, job config, publish gate
  database/          Drizzle schema, migrations, the queue
  crawler/           SSRF guard, capture, robots, extraction — no database
  media/             sniffing, validation, derivatives, storage drivers
  classification/    heuristic and Anthropic providers
  auth/              passwords, sessions, permissions
  api/               queries, services, serialisers, routers, public client
  seed/              development seed data only
scripts/             setup, dev, boundary checks, smoke, pipeline verification
docs/
```

## When something is wrong

**`npm run dev` says no `.env` found.** Run `npm run setup`.

**The CMS will not start: "Invalid environment for cms".** The message names
every missing or invalid variable. See [environment.md](environment.md).

**Jobs stay queued.** No worker is running, or it cannot reach the CMS. Check
the `worker` lines in the `npm run dev` output, and that `WORKER_TOKEN` in
`.env.worker` matches `WORKER_SHARED_SECRET` in `.env`. Settings → Capture
workers lists what has registered.

**Capture fails immediately with a browser error.** `npx playwright install chromium`.

**Every URL comes back `blocked`.** The SSRF guard is refusing them. It blocks
private and loopback addresses by design, so a `localhost` URL or an internal
hostname is expected to fail. Settings lists every blocked range with its
reason.

**Screenshots are blank tiles on the public site.** Media is served by the CMS,
so the public site's CSP has to name that origin — it is derived from
`PUBLIC_API_BASE_URL`, so check that is set and restart. If the images 404,
confirm the record is actually published: the public media route applies the
publish gate per request.

**Media appears to vanish between processes.** Fixed, but worth knowing what it
was: `STORAGE_LOCAL_ROOT` is now resolved against the repository root, because
a relative path resolved against each process's own working directory produced
three separate `.data` directories that each held some of the files.

**Something 500s after a database error, then everything does.** The PGlite
desync — documented in [known-limitations.md](known-limitations.md). Restart
`db:serve`.
