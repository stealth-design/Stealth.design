# CMS routes

Fifteen sections, grouped by the workflow rather than alphabetically — the
order a team works in is the order they should scan. Declared as data in
`apps/cms/src/lib/navigation.ts` with the permission each requires, so the
sidebar renders only what the signed-in role can reach and a Viewer never sees
a Settings link that would 403.

## Overview

| Route | Permission | What it is for |
|---|---|---|
| `/` | `content.read` | Dashboard. What we have, what is running, what needs a person, what changed. Every number links through to the list it counts — a dashboard figure you cannot click is a dead end. |

## Ingest

| Route | Permission | |
|---|---|---|
| `/ingestion` | `ingestion.create` | Paste URLs, upload a CSV, or point at a sitemap. Validates before anything is fetched, showing every line in one of six buckets. |
| `/crawl-jobs` | `ingestion.read` | Every run, with live progress. |
| `/crawl-jobs/[id]` | `ingestion.read` | One job: configuration and provenance, per-URL outcomes (`?tab=urls`), the readable log (`?tab=log`). Pause, resume, cancel, retry. |
| `/sources` | `source.read` | The products we study. Health is a first-class column because it is the one that changes without anyone editing the record. |
| `/sources/[id]` | `source.read` | What we hold, is it healthy, what is its rights position — in that order. Recapture and the source-level rights editor live here. |

## Library

| Route | Permission | |
|---|---|---|
| `/content` | `content.read` | Every record, every kind, every stage. One table, because an operator asks "where is this?" more often than "show me pages". |
| `/content/[id]` | `content.read` | Provenance, capture history, classification, rights, audit. Publish blockers are listed rather than hidden behind a disabled button. |
| `/media` | `media.read` | Grid by default — the primary act is recognising a screenshot. List for comparing sizes and dates. |
| `/media/[id]` | `media.read` | Provenance, hashes, derivatives, what uses it, near-duplicates. |
| `/flows` | `content.read` | Ordered paths. Shows steps against *actual* step rows, so drift is visible, and how many steps are publishable. |
| `/flows/[id]` | `content.read` | The filmstrip, in step order, horizontally scrollable so consecutive steps stay side by side. |
| `/patterns` | `taxonomy.read` | The pattern layer. Confirmed, suggested and published counts kept apart. |
| `/patterns/[id]` | `taxonomy.read` | One term and everything carrying it, with provenance per assignment. |
| `/collections` | `collection.read` | Curated sets. Shows item count against published count. |
| `/collections/[id]` | `collection.read` | Membership in curated order, each item's own status. |

## Curate

| Route | Permission | |
|---|---|---|
| `/reviews` | `review.read` | The review queue. Built for the keyboard: `A` approve, `R` reject, `P` approve and publish. |
| `/taxonomy` | `taxonomy.read` | The vocabularies, grouped by kind and indented by depth. |
| `/taxonomy/suggestions` | `classification.read` | The classification queue, ordered by confidence descending. `A` confirm, `R` reject, `M` correct. |
| `/published` | `content.read` | What is live. A filtered view of Content, not a separate store. |
| `/attention` | `content.read` | Six kinds of problem from six tables, unioned — because an operator asks "what is broken", not "show me dead-lettered queue items". |

## Administration

| Route | Permission | |
|---|---|---|
| `/settings` | `settings.read` | What §37 forbids hardcoding. Hard limits and blocked address ranges shown *beside* the editable defaults, because a default is a starting point and a limit is a ceiling. |
| `/audit` | `audit.read` | Append-only, rendered as sentences. Bulk operations collapse to one expandable row. |
| `/account` | signed in | Your own profile and password. Reached from the user menu, not the sidebar. Changing the password asks for the current one, counts wrong guesses toward the sign-in lockout, and signs out every other session. |

## Outside the shell

| Route | |
|---|---|
| `/login` | Sign in. Carries the UX Disrupt mark. |
| `/media/[...key]` | The CMS's media, session-gated. |
| `/api/public/*` | The public read API. |
| `/api/public/media/[...key]` | Published screenshots, publish-gated. |
| `/api/internal/*` | The worker control plane. |

## Conventions

**Every list is a URL.** Filters, sort, page and view are query parameters, so
a filtered view can be shared, bookmarked and reached without JavaScript.

**Filters come from data.** `FilterChips` renders from the same metadata that
defines the vocabulary. Nothing branches on a specific taxonomy term —
`npm run check:boundaries` fails the build if anything does.

**Status is a badge with a tone and a tooltip.** Decided once in
`LIFECYCLE_STATUS_META`, never per screen.

**Writes are server actions.** No REST API the browser calls, because an API
the CMS calls from the browser is an API anyone with a session can call.

**Actions return results, not exceptions.** A reviewer working the queue gets a
message and keeps their place.

**Blockers are shown, not implied.** A disabled Publish button lists why. "Why
can't I publish this?" is the question a reviewer actually has, and a missing
button does not answer it.

## Density

13px base, a single neutral ramp, six status tones. Shared `data-table`,
`mono` and `truncate-cell` utilities.

This is a control plane, not a showcase (§1). Somebody works a review queue in
it for an afternoon, so what matters is rows per screen and how fast a
keystroke lands — not whitespace. The public site is where the design
investment goes, and even there it goes into getting out of the screenshots'
way.
