# Running a test crawl

The shortest path from a URL to a published page, with a note on what each
stage is actually doing.

## Before you start

All four processes up (`npm run dev`), and signed in at
http://localhost:3000/login.

Pick a URL you are comfortable fetching. `https://example.com` is the polite
choice: it exists to be fetched. Whatever you pick, you are about to make a
request to someone else's server from your machine.

## 1. Submit

**Ingestion** → paste the URL → **Validate URLs**.

Nothing has been fetched yet. Validation is parsing, normalising and policy —
the network is only touched if you enable the reachability probe.

## 2. Read the validation

Every line lands in exactly one bucket:

| | |
|---|---|
| **Valid** | Parses, passes the guard, not seen before |
| **Already in the database** | Captured before. Include it to record a new version and see what changed |
| **Duplicate in batch** | Two lines normalised to the same URL |
| **Invalid** | Not a URL, or a protocol or port we refuse |
| **Blocked** | Refused by the SSRF guard or the operator blocklist |
| **Unreachable** | DNS or connection failed at the optional probe |

Worth trying deliberately, because seeing the refusals is how you know the
guard is real:

- `http://localhost:3000` → **blocked**, loopback
- `http://169.254.169.254/latest/meta-data/` → **blocked**, cloud metadata
- `file:///etc/passwd` → **invalid**, protocol not allowed
- `http://2130706433/` → **blocked**; the parser canonicalises the decimal form
  to `127.0.0.1`
- `https://nonexistent-abc123.example` → **unreachable**, not blocked. The
  distinction matters: telling someone the safety rules refused their URL when
  their typo simply does not resolve sends them looking in the wrong place.

`Invalid` and `blocked` can never be included, whatever the checkboxes say —
`createIngestionJob` re-checks server-side, so a crafted request cannot smuggle
one past this screen.

## 3. Configure and create

The defaults are deliberately narrow: `crawlInternalLinks: false`,
`maxDepth: 0`. A job captures exactly what you submitted unless you turn
discovery on.

Before you press start the screen tells you the ceiling — "this job could
capture up to N pages". §7: the bound is visible and finite beforehand, not
discovered afterwards.

Leave **Respect robots.txt** on. Turning it off is a separate permission and is
audited by name.

**Create and start**.

## 4. Watch it

**Crawl jobs** → your job.

```
worker │ INFO  Leased 1 item
worker │ INFO  Capturing {"url":"https://example.com/","level":2}
worker │ INFO  Captured {"httpStatus":200,"screenshots":2,"durationMs":1840}
cms    │ INFO  Capture intake complete {"changed":null,"status":"needs_review"}
```

Three tabs. **Configuration and provenance**: exactly what was requested, and
by whom. **URLs**: every submitted line with its outcome — including the
rejects, so 340 submitted and 297 queued does not leave you wondering about 43.
**Log**: plain English, one line per event.

Controls: pause, resume, cancel, retry. Pause takes effect on the next poll
without signalling anyone, because the claim query joins the job and checks its
status.

## 5. What intake did

One transaction, in the CMS — not the worker:

- Resolved or created the **source** from the registrable domain.
- Created the **content record** at `needs_review`.
- Inserted the **capture row** with full provenance: method, level, device
  profile, browser version, worker name, HTTP status, redirect chain, timings,
  bytes, content and layout hashes.
- Deduplicated and attached the **media**. Often two screenshots land as *one*
  file: for a page shorter than the viewport, the desktop and full-page
  captures are byte-identical, so sha256 matches and one row serves both roles.
- Updated the **URL registry**, recomputed **source health**, wrote the
  **audit** row.
- Ran **classification** — a suggestion at `ai_suggested` / `pending`, never
  applied.

## 6. Review

**Reviews** → your record.

Everything a decision needs on one screen: the screenshots, the extracted
metadata, the classification suggestions with confidence, the rights position,
the provenance.

`A` approve · `R` reject · `P` approve and publish.

`P` is one action rather than two, so the two writes share a transaction and
you do not leave the queue.

## 7. Publish

If Publish is disabled, the reasons are listed beside it. A fresh capture
usually shows **Rights position not settled** — `unknown` is not a blocker, but
`pending_review` is, and a record needs a title, a slug and (for a page or
screen) at least one image.

Set the rights position, approve, publish.

## 8. Confirm it is actually public

```bash
curl -s localhost:3000/api/public/content | head -40
```

Then http://localhost:3001. Same record, public shape — no internal notes, no
crawl metadata, no storage keys, and only classifications a person confirmed.

The site caches API reads for 60 seconds, so a record published a moment ago
may take up to a minute to appear on a listing page. That is correct behaviour,
not a bug.

## 9. Recapture, which is where the interesting behaviour is

**Sources** → your source → **Recapture** → *Everything*.

Then look at what changed:

- **One** content record, **two** capture rows. A capture is never overwritten,
  so "what did this look like in March" stays answerable.
- `changed: false` and the same content hash, for an unchanged page.
- Media deduplicated — the same files, more usages, no new bytes.
- URL registry `capture_count: 2`.
- **The review was not re-opened.** This is the subtle one. Recapture advances
  a record's status, and an early version preserved only `published` and
  `approved` — so a record sitting at `needs_review` was reset and then
  advanced past the queue, *removing it from review while its review row stayed
  open*. `RECAPTURE_ADVANCEABLE_STATUSES` now names exactly the seven statuses
  a capture may move, with seven tests including one asserting the status set
  is partitioned exactly.

Recapture also **re-validates every URL**, even though each captured
successfully before. A hostname's DNS can be re-pointed between captures and a
domain can lapse and be re-registered. URLs that no longer pass are recorded on
the job rather than dropped quietly.

## Withdrawal

Worth doing once, because it is the property most systems get wrong.

Set the record's rights position to **Restricted**. In the same transaction it
is unpublished — and the public API 404s it, *and its screenshot 404s*, because
the public media route re-applies the publish gate per request.

```bash
npm run verify:pipeline
```

Checks exactly that, across all three processes.
