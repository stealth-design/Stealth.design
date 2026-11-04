# Discovery, selection, capture

The content philosophy, and where each part of it lives in the code.

```
  Crawlee discovers.   Humans select.   Playwright captures.
  AI suggests.         Humans verify.   Approved Screens and Flows are the product.
```

```
  SOURCE
    │
    ▼          crawl · level 1 or 2 · no screenshots that matter
  DISCOVERY    discovered_pages — candidates, never content
    │
    ▼          a person picks, in the triage queue
  SELECTION    "capture this" / "set this aside, because…"
    │
    ▼          capture_sessions — a live browser the researcher drives
  CAPTURE      viewport only · lossless PNG · at the profile's real density
    │
    ▼          extraction + classifier, on the captured state
  SUGGESTION   taxonomy_assignments, review_status = pending
    │
    ▼          the mandatory gate
  REVIEW       accept · correct · reject · rename · approve
    │
    ▼
  PUBLISH      live on /api/public and the public site
```

## The one rule everything else follows from

**A crawl cannot create content.** Not "does not by default" — cannot. There is
no configuration value that turns it on, because the code path does not exist:
`POST /internal/items/report` calls `recordDiscoveredPage`, which writes to
`discovered_pages` and has no reference to `content_items`.

The only function in this system that creates a `screen` record is
`createScreenFromCapture`, and its only caller is
`POST /internal/sessions/:id/screen` — reachable only by a worker executing a
`capture` command that a signed-in person issued.

That is stated as a fact about the call graph rather than as a policy, because a
policy is a flag somebody eventually sets the other way.

### Why it matters

When discovery wrote content rows, a crawl of a 200-page marketing site produced
200 publishable records, and the reviewer's job became saying no 190 times. The
library's contents were decided by whatever the crawler happened to reach.

Separating the two inverts it. Candidates accumulate cheaply and can be dismissed
in bulk; `content_items` only ever holds things somebody chose. It also makes two
different questions separately answerable: *what does this site have?* reads
`discovered_pages`; *what have we decided is worth studying?* reads content.

## DISCOVERY

`packages/api/src/services/discovery.ts`

A crawl job's configuration no longer mentions screenshots, content kinds,
classification or review — read `crawlJobConfigSchema` for what is absent. What
remains is how hard to look and how politely:

| Setting | Meaning |
|---|---|
| `maxCaptureLevel` | 1 = HTTP fetch. 2 = render in Chromium, for sites that build themselves in JavaScript. There is no level 3. |
| `capturePreview` | One small viewport thumbnail for the triage list. Never attached to a Screen, never public. |
| `crawlInternalLinks`, `maxDepth` | On by default at depth 1 — discovery is the point now. |

Dedupe is global on `normalized_url_hash`, not per job: crawling a site twice a
month apart refreshes one candidate rather than stacking two. A re-crawl updates
the metadata and **never resets a triage decision** — otherwise the ignore button
would be useless on exactly the sites crawled most often.

### Triage

Three things can happen to a candidate, and they are the three values of its
status: `new`, `captured`, `ignored`. Ignoring requires a reason from
`IGNORE_REASONS`, so *"how much of what we crawl is worthless, and in which
way?"* stays countable — the question that tells you the crawl scope is wrong.

A candidate that has already produced a Screen cannot be ignored. "Ignored" would
then be untrue of a page we demonstrably found worth capturing.

## CAPTURE — the studio

`packages/api/src/services/studio.ts` · `apps/ingestion-worker/src/session.ts`

A Screen is **not a URL**. The same URL routinely yields several — the default
view, the navigation open, the search open, a modal up — and what distinguishes
them is `state_label` plus the pixels. So `screen_details.url` carries no unique
index, unlike `page_details.normalized_url_hash` where uniqueness is the entire
point.

### How a live browser is possible without opening the worker up

The worker holds no credentials and cannot be reached from outside; it dials out
and nothing dials in. Every channel of a session is therefore the worker calling
the control plane, which is mounted inside the CMS:

```
  CMS  ──▶  capture_session_commands  ──▶  worker    click, type, navigate, capture …
  CMS  ──▶  live relay (memory)       ──▶  worker    pointer and wheel
  CMS  ◀──  live relay (memory)       ◀──  worker    the picture of the page
```

- **Commands** are rows, because they are things a person did and the session's
  history should keep them. The worker long-polls for them, and writing one
  wakes that poll at once (`notifyLiveCommand`), so a click reaches the browser
  in one hop.
- **The picture** is Chromium's screencast: the worker receives a JPEG whenever
  the page repaints and posts the newest one, dropping any superseded while a
  post is in flight (at most 24 a second). The CMS relays each frame to the
  studio as one long `multipart/x-mixed-replace` response, which an `<img>`
  renders natively. A still page sends nothing.
- **Pointer and wheel** go through the relay only and are never recorded: just
  the latest pointer position is kept, and wheel deltas are summed. That is what
  makes hover work by simply moving the mouse.

The relay lives in the CMS process (`packages/api/src/services/studio-live.ts`).
Nothing in it is a record: one frame every two seconds is also written to
`capture_sessions.frame`, so a viewer arriving after a restart still sees the
page, and the command poll re-checks the database every second in case a wake is
missed. Commands and the session row are durable as before, so a session
survives a hot reload and the operator closing the tab.

The command vocabulary is input events only — navigate, click, move, scroll, key,
type, capture, close. There is no command that evaluates operator-supplied
script inside the capture sandbox. A `navigate` gets the full SSRF guard, exactly
like the session's first URL; without that, the studio's address bar would be an
SSRF hole with a text box on it.

### Capture settings

Fixed at context creation, because Playwright pins `deviceScaleFactor`,
`isMobile` and `hasTouch` there — "switch to mobile" means a new session, not a
resize.

| | Desktop | Mobile |
|---|---|---|
| CSS viewport | 1440 × 900 | 390 × 844 |
| deviceScaleFactor | 2 | 3 |
| isMobile / hasTouch | false | true |
| Stored PNG | **2880 × 1800** | **1170 × 2532** |

Viewport only, always. A Screen is a state a person chose; a 20,000-pixel strip
of an entire marketing page is not a state anyone can look at.

The preview frames are JPEG at CSS scale because they are for aiming. The capture
is lossless PNG at full device density because it is the artefact.

### Cookie banners

Every session is a brand-new browser profile, so every site shows its consent
banner — on some, half the viewport. The studio dismisses them by default with
DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent)
(`packages/crawler/src/consent.ts`), which **clicks the site's own opt-out**
rather than hiding the banner, so the page behaves as it would for a visitor
who declined.

- It runs as an init script in every page and frame. The standalone build
  carries its rules inline and makes no network requests; nothing is fetched
  at runtime.
- What it dismissed is kept on each capture command's result
  (`consent: { outcome, cmps }`), so whether a banner was removed from a
  screenshot stays answerable.
- **Dismiss cookie banners** in the studio turns it off, to capture the banner
  itself as a pattern. Switching restarts the browser at the same URL with a
  fresh profile — the site remembers an opt-out in cookies, so keeping them
  would hide the very banner the switch was turned off to see.
- Expect a blank frame or two after the opt-out: many sites reload once
  consent is recorded.

The package is pinned to an exact version. On upgrade, run
`packages/crawler/test/consent.test.ts`: it fails if the build moves or the
log line the outcome is parsed from changes.

## SUGGESTION and REVIEW

Every captured Screen is born `needs_review`. Not `draft`, not `approved` — the
researcher still has to name it and confirm its tags, and a capture that skipped
that would be an unlabelled screenshot.

The review screen puts the capture on the left and the judgement on the right.
Each suggestion shows its confidence as a number, names the model, and offers
accept / change / reject at equal cost. When a reviewer changes a term the
original is kept on the assignment (`replaced_term_id`) — which is what makes
*"how often is the model wrong, and in which direction?"* answerable later.

## FLOWS

`packages/api/src/services/flows.ts`

A Flow owns no pixels: it is a name, a goal, and an ordered list of pointers at
Screens that already exist. That is what lets the same Screen appear in three
journeys without being photographed three times — "do not duplicate Screen
records" is a consequence of the shape rather than a rule to remember.

Two ways to build one, because there are two ways researchers work:

- **Walk it.** Open a session with a `flowId`; every capture becomes the next
  step. This is the signup-flow case, where the steps only exist as a sequence
  somebody walked.
- **Assemble it.** Reorder and relabel what is already there, for journeys
  recognised after the fact.

Positions are 1-based and contiguous, rewritten wholesale on every structural
change: a unique index on `(flow_id, position)` turns any clever incremental
shuffle into a constraint violation halfway through.

Lifecycle is `draft → needs_review → approved → published`. A flow starts as a
draft because it is genuinely incomplete until it has steps, and
`submitFlowForReview` refuses an empty one.

Publishing a flow does not publish its steps and vice versa — each passes the
gate on its own, which is what makes it possible to hold back one screen of a
journey without withdrawing the whole thing.

## What the public API exposes

| Endpoint | Returns |
|---|---|
| `/screens`, `/screens/:idOrSlug` | Published screens, with `screen.stateLabel` and the capture conditions |
| `/flows`, `/flows/:idOrSlug` | Published flows and their ordered steps |
| `/content`, `/sources`, `/facets`, `/collections` | As before |

There is **no** discovery endpoint, no session endpoint and no command endpoint.
Candidates, frames, commands, review history and internal notes have no public
serializer — the serializers construct their output field by field rather than
deleting from a row, so a column added to a table cannot leak by default.

## Verifying it

```bash
node scripts/acceptance-workflow.mjs
```

Runs the eighteen steps of the brief's acceptance test against Linear, through
the real services and a real browser: discovery produces candidates and no
content, a session opens and goes live, a capture creates a reviewable Screen at
2880 × 1800, an unapproved Screen 404s publicly, an approved one appears, a flow
is walked and published with its steps in order, and nothing from the discovery
queue is reachable publicly.
