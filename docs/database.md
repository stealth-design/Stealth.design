# Database schema

PostgreSQL 18. 32 tables, 42 enums, 179 indexes, 86 foreign keys, 15 CHECK
constraints, 4 generated `tsvector` columns.

Defined in `packages/database/src/schema/`. Migrations in
`packages/database/migrations/`, applied with `npm run db:migrate`.

## The content model, and why it is shaped this way

§2 rules out two obvious designs and asks for the third.

It rules out **one flat table for everything**, because a page, a flow and an
interaction genuinely have different attributes and cramming them into one row
means most columns are null most of the time and nothing can be constrained.

It also rules out **a table per kind**, because "show me everything from this
source, at any stage" becomes a seven-way union and the lifecycle, rights and
review logic gets reimplemented per table — which is where the discrepancies
start.

So: **a shared spine plus per-kind detail tables.**

```
                        content_items
        ┌──────────────────────────────────────────────┐
        │ id · kind · module · source_id               │
        │ title · slug · description · source_url      │
        │ status ──────────── 14 lifecycle statuses    │
        │ rights_status ───── 9 rights statuses        │
        │ experience_id · parent_id · version          │
        │ approved_by/at · published_by/at             │
        │ search_vector ───── generated tsvector       │
        └───┬──────────────────────────────────────────┘
            │  one detail row per kind, PK = content_item_id
   ┌────────┼─────────┬──────────┬──────────┬──────────────┐
   ▼        ▼         ▼          ▼          ▼              ▼
experience  page    screen     flow       state      interaction
_details   _details _details  _details   _details    _details
                                  │
                                  │ flow_steps: ordered, many-to-many
                                  └──► content_items (the steps)
```

Everything that is the same for every kind — status, rights, review, audit,
publish gate, search — lives on the spine and is implemented once.

The detail tables hold what is genuinely kind-specific. `page_details` has the
URL, HTTP status and extracted metadata; `flow_details` has a goal and a step
count; `interaction_details` has a trigger and a behaviour description. The PK
is `content_item_id`, so the relationship is one-to-one and enforced.

Both hierarchies §2 requires fall out of `experience_id` / `parent_id` on the
spine plus `flow_steps` for sequences:

```
Website → Page → Flow → Pattern → State → Interaction
App     → Screen → Flow → Pattern → State → Interaction
```

"Pattern" is the one step in those chains that is *not* a content kind, which is
the point of §2's instruction that "UX/UI should NOT be treated as a top-level
content source. UX/UI is a classification/research layer applied to content."
A pattern is a `taxonomy_terms` row; a page carries it through
`taxonomy_assignments`. That is why the CMS's Patterns screen is a view over
taxonomy rather than a list of records, and why the public site links a pattern
to a filtered browse rather than to a pattern page.

### Adding a module without rewriting the core

§2 requires that graphic design, brand identity, motion, 3D, packaging, email
and campaigns can be added later "without rewriting the core content model" —
and requires that they are *not* built now.

The seam is `module`. It is an enum on `sources` and on `content_items`, and
`MODULES` in `packages/types/src/modules.ts` declares which content kinds each
module may own. Adding a module is: a value in the enum (one migration), an
entry in `MODULES`, and a detail table if the kind needs attributes the spine
lacks. The lifecycle, rights, review, audit, publish gate, media handling,
search and taxonomy all work on the new module the day it is added, because none
of them knows what a module is.

Nothing in the codebase branches on `module === "web"`.

## The tables

### Identity and access

| Table | Notes |
|---|---|
| `users` | Email, name, one of five roles, scrypt password hash. Soft-deleted. |
| `sessions` | PK is the sha256 of an opaque token, so the database never holds a usable credential. Expiry and last-used are tracked. |
| `worker_tokens` | Per-worker credentials, hashed, revocable, with a named principal — so an audit row says *which* worker. |
| `worker_instances` | Live worker registry: heartbeat, items in flight, completed, failed. Drives the Settings screen. |

### Sources

| Table | Notes |
|---|---|
| `sources` | One row per product or site. Partial unique index on `domain` where not deleted, so a re-added source reuses its row. Carries derived health, rights position, robots status, capture interval, and maintained counters. |
| `url_registry` | Every URL ever seen, with its capture count and an operator block flag. This is what makes "already in the database" and "blocked by an operator" answerable during URL validation, without touching the content tables. |
| `robots_cache` | Fetched robots.txt per host with an expiry, so one crawl does not fetch it per URL. |

`sources.health` is derived by `deriveSourceHealth` from capture outcomes, not
typed in. It is the one column on the screen that changes without anyone editing
the record, which is why the Sources list shows it as a first-class column.

### Content

`content_items` plus six detail tables, and:

| Table | Notes |
|---|---|
| `content_relations` | Typed edges between records — variant of, precedes, replaces. Separate from `parent_id` because those are different relationships and collapsing them loses the type. |
| `flow_steps` | `(flow_id, content_item_id, position)`. A step references a record rather than copying it, so one page can appear in three flows and editing it updates all three. |

### Captures

| Table | Notes |
|---|---|
| `captures` | One row per attempt, successful or not. Holds the full provenance: method, capture level, device profile, browser version, worker name, HTTP status, redirect chain, timings, bytes, content and layout hashes, and the change summary against the previous capture. |

A capture is never overwritten. Recapturing a URL adds a row, so "what did this
page look like in March" stays answerable and change detection has something to
compare against.

### Media

| Table | Notes |
|---|---|
| `media_assets` | The file: sha256 (exact dedupe), dHash (perceptual near-duplicate), dimensions, mime type, dominant colour, storage key, provenance back to the capture. |
| `media_derivatives` | Thumbnails and previews, one row each, so a derivative can be regenerated or added without touching the original. |
| `media_usages` | Which content records use which asset, in which role. Many-to-many, because deduplication means one file legitimately serves several purposes. |

See [media.md](media.md).

### Taxonomy

| Table | Notes |
|---|---|
| `taxonomy_terms` | 13 vocabularies. Hierarchical via `parent_id` plus a materialised `path`, so "everything under Navigation" is a prefix match rather than a recursive CTE. `aliases` is what stops near-duplicate terms accumulating. |
| `taxonomy_assignments` | The classification layer. Records origin (`ai_suggested` / `human_verified` / `human_modified` / `human_added` / `imported` / `rule_based`), confidence, model, and `replaced_term_id` when a person corrected the model. |
| `classification_suggestions` | Field-level suggestions (a title, a description) as opposed to term assignments. |

`taxonomy_assignments.origin` is the mechanism behind §14. The public queries
filter on it, so an unreviewed machine guess cannot reach the public API even if
the record itself is published. Three partial unique indexes — one per target
type — enforce one assignment per (term, target), which is why the CMS merges a
correction into an existing assignment rather than failing.

### Jobs

| Table | Notes |
|---|---|
| `crawl_jobs` | The run: validated config as jsonb, status, priority, counters, provenance. |
| `crawl_job_urls` | Every submitted line, **including the rejects**, with its validation outcome and reason. §5's requirement that nothing is silently dropped. |
| `crawl_job_items` | The queue. Lease token, lease expiry, attempts, error code and message. |
| `crawl_job_events` | The readable log, one row per event, with a closed set of codes each carrying an English sentence. |

See [ingestion-pipeline.md](ingestion-pipeline.md).

### Workflow

| Table | Notes |
|---|---|
| `reviews` | Assignment and decision, separate from the content record's status, so "who is looking at this" survives a status change. |
| `collections` / `collection_items` | Curated sets with explicit ordering. |
| `audit_events` | Append-only. Actor label captured at write time so the trail reads correctly after a user is deleted. `batch_id` ties one bulk operation's rows together. |
| `settings` | Operator-editable key/value with a per-key Zod schema. §37's alternative to hardcoding. |

## Invariants the database enforces itself

The service layer checks these too. The constraints exist because a service-layer
bug should be a failed write, not a wrong row.

| Constraint | What it prevents |
|---|---|
| `content_items_publishable` | A `published` row without a title, slug, published timestamp, or with a blocking rights status |
| `content_items_approval_attributable` | An `approved` or `published` row that does not name who approved it and when |
| `crawl_job_items_lease_consistent` | A leased item without a lease token or expiry — the state that would let two workers claim one item |
| `media_assets_sha256_format` | A malformed content hash, which would break deduplication silently |
| `taxonomy_assignments_single_target` | An assignment pointing at two entities at once |
| `taxonomy_assignments_confidence_range` | A confidence outside 0–1 |

## Search

Four `tsvector` columns, `GENERATED ALWAYS`, with GIN indexes: on
`content_items`, `sources`, `media_assets` and `taxonomy_terms`. Weighted A/B/C/D
so a title match outranks a body match.

Generated rather than trigger-maintained: a generated column cannot drift from
its source, and there is no trigger to forget when a column is added.

Queries use `websearch_to_tsquery`, which handles quoted phrases and `OR`/`-`
and — the reason it matters — does not throw on the punctuation people actually
type. `to_tsquery` errors on a stray colon.

`pg_trgm` is deliberately not load-bearing: it is absent from PGlite, and a
local development environment that cannot run a production query is worse than
slightly weaker fuzzy matching. Substring searches use `ilike`.

## Working with it

```bash
npm run db:serve      # embedded Postgres on 127.0.0.1:5432
npm run db:generate   # schema change → a migration file
npm run db:migrate    # apply pending migrations
npm run db:seed       # base vocabulary, settings, admin user
npm run db:reset      # drop everything and re-migrate
```

`db:generate` writes SQL for review rather than pushing directly. Two migrations
are hand-written: `0001_circular_fks.sql` adds the circular foreign keys Drizzle
cannot express in one pass (a content item's latest capture, a capture's content
item) along with all 15 CHECK constraints.
