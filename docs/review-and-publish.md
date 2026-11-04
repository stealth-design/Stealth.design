# Reviewing and publishing

## The queue

**Reviews**. Built for the keyboard, because this is where the throughput is
and a queue worked with a mouse is a queue that does not get worked.

| | |
|---|---|
| `A` | Approve |
| `R` | Reject — asks for a reason |
| `P` | Approve **and** publish |
| `J` / `K` | Next / previous |

`P` is one action rather than two so the two writes share a transaction and you
do not leave the queue between them.

Each item shows everything a decision needs on one screen: the screenshots, the
extracted metadata, the classification suggestions with their confidence, the
rights position, and the provenance — which URL, which capture, which browser,
what date.

A rejection requires a note. Six months later "why isn't this in the library"
is a real question, and "someone rejected it" is not an answer.

## The publish gate

`canPublish()` returns **every** blocker, each with a field, rather than the
first one it finds — because fixing them one at a time across four round trips
is how a reviewer comes to hate a tool.

| | |
|---|---|
| `NOT_APPROVED` | Only `approved` transitions to `published` |
| `NO_TITLE` / `NO_SLUG` | A public page needs a name and an address |
| `NO_MEDIA` | For page, screen, website and app. A visual reference with no image is not a reference. A flow is exempt — its steps carry the images |
| `RIGHTS_HOLD` | `pending_review`, `restricted`, `removed` or `do_not_republish` |
| `ALREADY_PUBLISHED` | Not an error, but not a no-op either |

The blockers are shown next to a **disabled** button rather than the button
being hidden. "Why can't I publish this?" is the question a reviewer actually
has, and a missing button does not answer it.

Enforced three times, and the redundancy is deliberate: in the service (which
produces the explanation), at the SQL level by `publishedContentCondition()`
(which makes every public query correct by construction), and by the
`content_items_publishable` CHECK constraint (which makes a bug in the first
two a failed write instead of a disclosure).

## Rights

Nine statuses. Four block publishing.

| | Blocks | |
|---|---|---|
| `unknown` | no | Not yet considered |
| `pending_review` | **yes** | Someone raised a question |
| `permissioned` | no | The owner agreed |
| `licensed` | no | Covered by a licence |
| `public_submission` | no | Submitted by the owner |
| `reference_use` | no | Held as reference, with attribution |
| `restricted` | **yes** | Withheld |
| `removed` | **yes** | Taken down |
| `do_not_republish` | **yes** | Never again |

**These are operational labels, not legal determinations.** §22 is explicit:
the system records what your team knows and has decided. Nothing computes
legality, nothing labels content "legally safe", and there is no
country-specific logic anywhere. A record marked `licensed` means somebody
wrote that down, not that a machine verified it.

Setting a blocking status on published content **withdraws it in the same
transaction** — and its screenshots stop resolving, because the public media
route re-applies the gate per request. The alternative is leaving restricted
material live until someone remembers to unpublish it separately, which is
exactly the failure mode this should not have.

There is also a **source-level** rights position, on the source record. It does
*not* cascade to content, deliberately: the publish gate reads the record's own
status, and rewriting hundreds of rows from one dropdown would destroy
per-record decisions a reviewer made on purpose. The discrepancy is surfaced
where the publish decision is taken instead.

## Classification review

`/taxonomy/suggestions`. Ordered by confidence **descending**, which sounds
backwards until you work one: the high-confidence suggestions clear in a
keystroke, leaving the genuinely uncertain ones as the remainder.

| | |
|---|---|
| `A` | Confirm → `human_verified` |
| `M` | Correct → `human_modified`, keeping the model's original term |
| `R` | Reject → `rejected`, and the row is **kept** |

Three things this encodes:

**Nothing is applied automatically.** An `ai_suggested` assignment sits at
`pending` until a person acts. The public queries filter on origin, so an
unreviewed guess cannot appear publicly even if the record is published.

**A correction is recorded as a correction.** `replaced_term_id` keeps what the
model proposed, so "how often did a person have to fix this?" is a query rather
than a guess.

**Rejection is not deletion.** A model proposing something a person refused is
the useful signal; deleting it would make the same wrong suggestion look novel
next time.

The confidence bar shows the auto-apply floor as a marker. A suggestion below
it is one the system would not have trusted — worth knowing while you judge it.

`DEFAULT_MIN_AUTO_APPLY_CONFIDENCE` is operator-editable in Settings, with a
hard lower bound of `ABSOLUTE_MIN_AUTO_APPLY_CONFIDENCE` enforced by the
schema. Operators can raise the floor; they cannot remove it. A setting that
could be dialled to zero would make §14 a suggestion.

## Bulk

Filter on the Content screen, select, act. Approve, reject, archive, set
status, assign a reviewer.

Audited as one batch: the log shows "approved 40 items" as a single expandable
row rather than forty lines that bury everything else that happened that
afternoon.

Bulk publish still applies the gate per record. Forty selected records where
twelve lack a rights position publishes twenty-eight and tells you about the
twelve.

## Withdrawing

**Unpublish** asks for a reason and records it. `unpublished_at` is set,
`published_at` cleared, and the record leaves the public API immediately.

For a takedown request, set the rights status to `removed` rather than just
unpublishing. It blocks publishing permanently, it is visible on the record,
and it survives a recapture — where a plain unpublish would let the record
drift back into the review queue and get published again by someone who did not
know.

## What recapture does not do

A capture never overwrites a person's decision.

`RECAPTURE_ADVANCEABLE_STATUSES` names the seven statuses a capture may move:
`draft`, `discovered`, `queued`, `capturing`, `processed`, `ai_classified`,
`failed`. Everything else — `needs_review`, `approved`, `published`,
`rejected`, `archived`, `restricted`, `removed` — is preserved.

That list exists because of a real bug. An early version preserved only
`published` and `approved`, so a record at `needs_review` was reset to
`processed`, then advanced to `ai_classified` — **removing it from the review
queue while its review row stayed open**. Work disappeared silently.

Seven tests cover it now, including one asserting the status set is partitioned
exactly, so adding a status forces a decision about which side it falls on
rather than defaulting quietly.

## Who can do what

| | Viewer | Contributor | Reviewer | Curator | Admin |
|---|---|---|---|---|---|
| Read content | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit URLs | | ✓ | ✓ | ✓ | ✓ |
| Approve / reject | | | ✓ | ✓ | ✓ |
| Publish | | | ✓ | ✓ | ✓ |
| Edit rights | | | | ✓ | ✓ |
| Edit taxonomy | | | | ✓ | ✓ |
| Override robots.txt | | | | | ✓ |
| Settings, users | | | | | ✓ |

Full matrix in `packages/types/src/permissions.ts`. `roleHasPermission` fails
closed, and 22 tests check every role against every permission.

## The audit trail

Append-only. Nothing in the application can edit or delete a row.

Every consequential change: who, what, when, and what it was before. Only the
changed keys are stored, never a whole row. The actor's name is captured at
write time, so the trail still reads correctly after a user is deleted.

`/audit` renders it as sentences, because the reader is a person asking "who
changed this" — a question a sentence answers and a column of JSON does not.
