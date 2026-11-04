# UX Disrupt

A design research platform: capture, organise, review and publish product
interface research. Websites and apps today; the content model is built so
other design disciplines can be added without rewriting it.

The public library is **UX Disrupt**; the editorial system behind it is the
**UX Disrupt CMS**. The mark is a 2×2 grid with one cell displaced out of
alignment — the site is a grid of captured screens, and the name is
"disrupt", so it reads as both.

**The CMS is the source of truth.** Everything public originates from a record a
person approved and published, and the public site maintains nothing of its own.
That constraint shapes almost every decision here — see
[docs/architecture.md](docs/architecture.md).

**A crawl discovers; a person captures.** Crawling produces *candidates* — URLs
with enough metadata to triage — and cannot create content at all. Screens are
captured one at a time by a researcher driving a live browser to the exact state
worth keeping, and every one enters review before it can be published. The
library's contents are decided by people, not by whatever a crawler reached. See
[docs/capture-workflow.md](docs/capture-workflow.md).

## Getting started

```bash
npm install
npm run setup          # env files with real secrets, Chromium, migrations, seed
npm run db:seed:demo   # optional: a demo library to look at
npm run dev            # all four processes, one terminal
```

| | |
|---|---|
| CMS | http://localhost:3000 — `admin@localhost` / `change-me-in-development` |
| Public site | http://localhost:3001 |
| Public API | http://localhost:3000/api/public |

No Docker, no Postgres install, no Redis. Node 22.6+ is the whole requirement:
the database is PostgreSQL 18 compiled to WebAssembly, served over the real
wire protocol, so the driver, SQL and migrations are identical to production.

[docs/local-development.md](docs/local-development.md) has the longer version,
including your first crawl end to end.

## Shape

```
CMS (Next.js) ──── Postgres ──── durable job queue
 │  23 screens
 │  /api/public/*   read-only, publish-gated
 │  /api/internal/* worker control plane, bearer token
 │
 ├──► Capture worker — sandboxed Chromium, NO database credentials
 │                     treated as hostile-input infrastructure
 └──► Public site   — one data source, no database, no write path
```

The three process boundaries are the design. The worker holds a bearer token
good for six endpoints and nothing else, so a browser escape is contained —
and that is enforced by a startup assertion and a build-time check, not by
convention. [docs/security.md](docs/security.md).

## Commands

```bash
npm run dev                # everything
npm run dev:cms            # one at a time
npm run dev:worker
npm run dev:frontend
npm run db:serve           # embedded Postgres

npm run lint               # typecheck + boundaries + sql checks
npm test                   # 238 tests
npm run smoke              # 57 HTTP checks, needs a running CMS
npm run verify:pipeline    # 16 checks across all three processes

npm run db:generate        # schema change → reviewable SQL migration
npm run db:migrate
npm run db:seed            # vocabulary, settings, admin user
npm run db:seed:demo       # fictional demo library
```

## Verified

| | |
|---|---|
| 322 tests | SSRF and address classification (44), URL parsing and normalisation (34), media processing (33), the queue against real Postgres (27), classification (23), permission boundaries (22), public queries (18), the publish gate (16), capture-session leases (13), leak prevention (13), discovery intake (7), recapture (7) |
| 6 boundary checks | frontend has no database · worker is isolated · browser sandbox never disabled · no logic branches on a taxonomy term · dependencies pinned · no hardcoded URLs |
| 1 SQL check | every correlated subquery in a projection qualifies its outer reference |
| 57 smoke checks | including that no public response carries an internal field, and that a CMS session cannot act as a worker |
| 16 pipeline checks | a CMS decision reaching the public site, and a rights hold withdrawing it again |
| 39 acceptance checks | `node scripts/acceptance-workflow.mjs` — discovery producing candidates and no content, a live browser opening, an intentional capture at 2880×1800 entering review, the publish gate refusing it until approved, and a flow walked, ordered and published |
| 13 render checks | every CMS route returns 200 for a signed-in operator (`npm run verify:render`) |
| `npm audit --omit=dev` | zero vulnerabilities |

## Documentation

[docs/](docs/) — sixteen documents. If you have twenty minutes:
[capture-workflow](docs/capture-workflow.md),
[architecture](docs/architecture.md),
[security](docs/security.md).

If you are about to write code here, add
[known-limitations](docs/known-limitations.md) — it is the document most likely
to save you from re-discovering something the hard way.

## A note on what this holds

Every interface in the library belongs to the company that made it. The system
records provenance per capture — which URL, which browser, which viewport, what
date — and nine rights statuses recording what a team knows and has decided.

**Those are operational labels, not legal determinations.** Nothing here
computes legality or labels content "legally safe". Four of the nine statuses
block publishing, and setting one on published content withdraws it in the same
transaction, because the alternative is leaving restricted material live until
somebody remembers.
