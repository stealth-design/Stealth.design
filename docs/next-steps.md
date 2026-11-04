# Recommended next engineering steps

Priority order, with the reason. The first group is what I would do before
putting this in front of a team; the rest is what makes it a product.

## 1. Before a team uses it

### Flow authoring in the CMS

The largest gap. Flows are modelled, seeded, served and rendered — there is no
screen to *build* one. A researcher's most valuable output is "here is how this
product does checkout, in seven screens", and right now that requires database
access.

Needs: a picker filtered to one source, drag-to-order, a step label and note per
step, and `flow_details.step_count` maintained on save. The read side already
exists (`getFlowSteps`, the filmstrip), so this is one screen and one service.

### Taxonomy editing

Assignment review is complete; vocabulary maintenance is not. Creating,
renaming, re-parenting, aliasing and archiving a term all go through the seed or
SQL today.

The one non-obvious part is re-parenting: `path` is materialised, so moving a
term has to rewrite the subtree's paths in one transaction. Worth doing
properly, because a half-rewritten path breaks the prefix queries the taxonomy
screen depends on.

### User management

Roles and permissions are complete and enforced by 22 tests. A user can change
their own password at `/account`, but there is no screen to create a user,
change a role, deactivate an account or reset someone else's password.

Also missing and worth the same pass: `sessions_valid_after` per user, so
"sign this person out everywhere" does not mean rotating `SESSION_SECRET` and
signing *everyone* out.

### A real rate limiter

In-memory and per-instance today, so three instances allow three times the
configured rate. Postgres can do this — a counter table with a window, in the
same transaction as the request — which avoids introducing Redis for one
feature.

The worker-side limiter has the same problem and matters more: two workers on
one host at 20 requests per minute make 40 requests per minute to somebody
else's server. Dividing by expected worker count in the job config is a
workaround, not a solution.

## 2. Making the research output better

### Visual diff

Change detection reports *that* a page changed and roughly where. What a
designer wants is to see it. Perceptual hashes are already stored, so the
groundwork is done: compute a diff image between consecutive captures, store it
as a derivative, and show it on the capture history.

This is the single feature that would most change what the library is for —
from "what does this look like" to "what did they change, and when".

### Interaction and state capture at volume

Modelled, typed, and `runInteraction` executes operator-defined steps. Page and
screen capture is what has been exercised end to end.

Recording a hover state, a modal open or a form error as its own content record
works in principle. Making it routine needs: interaction definitions per source
rather than per job, deterministic replay verification (capture twice, compare —
a flaky interaction is worse than none), and a review interface that shows
before/after side by side.

### Classification quality measurement

Every correction already stores `replaced_term_id`, so the data to answer "how
good is the model, per vocabulary" is being collected and nothing reads it. A
screen showing accept/modify/reject rates by term and by model would tell an
operator where to raise the confidence floor and where the vocabulary itself is
the problem.

Cheap to build, and it is the feedback loop that makes classification improve
rather than merely exist.

### Scheduled recapture

`capture_interval_days` and `next_scheduled_capture_at` are on every source and
nothing acts on them. A periodic task that enqueues due sources would make the
library stay current without anyone remembering — which is the difference
between a snapshot and a longitudinal record.

Needs a scheduler. A Postgres advisory lock plus a cron container is enough;
this does not need a job framework.

## 3. Operational maturity

### Automated dependency updates

`.github/dependabot.yml` or Renovate, weekly, grouped. Every dependency is
pinned to an exact version, which is the precondition — but pinning without
automation just means falling behind deliberately instead of accidentally.

`npm audit --omit=dev` currently reports zero. Keeping it there is the point.

### CI

Everything needed already runs as one command:

```
npm run lint          # typecheck (including tests) + boundaries + sql
npm test              # 238 tests, needs db:serve
npm run smoke         # 57 HTTP checks, needs a running CMS
npm run verify:pipeline
```

`db:serve` in the background is the only setup. The last two need a running
stack, which is exactly why they should be in CI — they check things unit tests
structurally cannot.

### Container images and a deployment target

Three images: CMS, worker, public site. The worker's is the one with
constraints — CPU and memory limits at the container level, egress restricted
to the internet and the control plane, an ephemeral filesystem, and no route to
the database network. [worker.md](worker.md) has the list.

### Nonce-based CSP for the CMS

Removes the last `unsafe-inline`. Real work with Next's App Router, and worth
doing before this is internet-facing.

### Retention enforcement

`retention.jobLogDays` and `retention.captureBodyDays` are settings that
nothing reads. A periodic task should trim job event logs and raw captured HTML
past their window — the untrusted source documents are the bulk of the storage
growth, and the extracted text and screenshots are what actually get used.

## 4. Structural, when the shape is proven

### Split the API out of the CMS

Both API surfaces are Next route handlers today, which is right for now: one
deployable, one place to look. When the public API's traffic profile diverges
from the CMS's — and it will, because one is read-heavy and cacheable and the
other is a handful of authenticated users — the routers are already Hono apps
and move to their own service with a mount point change.

Do it when there is a reason, not before.

### A second content module

The module seam exists and is unexercised. Adding one — graphic design is the
obvious first, since it needs media and taxonomy but no capture — is what would
prove the seam holds. Expect to find one or two places where `module` is
assumed rather than read.

Explicitly not now: §"Future modules must NOT be built now."

### Object storage lifecycle

Originals of superseded captures are the storage growth. An S3 lifecycle rule
moving them to infrequent access after 90 days is configuration, not code, and
the keys are already date-partitioned to make it easy.

## What I would not do next

**A public write API.** There is no write path on the public surface, and that
is the strongest form of §"the public frontend must NEVER independently create
or maintain content". Adding one to support a feature is the wrong trade.

**Replacing the Postgres queue.** The bottleneck is a browser rendering a page,
measured in seconds. Redis would buy throughput this system will never need and
cost a second piece of infrastructure — and would put job state somewhere a
transaction cannot span with content state.

**A component library for the public site.** It has two layouts. Six components
is the right number.

**Auto-applying classifications.** The floor is operator-editable and cannot be
lowered past a hard bound, deliberately. Better measurement (above) is the way
to earn more trust in the model, not removing the human.
