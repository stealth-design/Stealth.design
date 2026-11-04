# The capture worker

`apps/ingestion-worker`. A separate process that leases work, renders pages in
a sandboxed Chromium, and reports back over HTTP.

## Running it

```bash
npm run dev:worker
```

Or as part of `npm run dev`, which waits for the CMS to answer before starting
it — the worker retries anyway, but starting early fills the log with
connection failures that look like a problem and are not.

On start it verifies Chromium *before* taking work, registers with the control
plane, and begins polling. Missing browser, wrong token, unreachable CMS: it
says so and exits rather than leasing items it cannot process.

```
INFO  Starting capture worker {"worker":"worker-local","concurrency":2,"batchSize":4}
INFO  Chromium launched {"version":"151.0.7922.34"}
INFO  Chromium ready
INFO  Registered with the control plane {"instanceId":"01a06b5f-…"}
```

Settings → Capture workers shows what has registered, with heartbeats, items in
flight, completed and failed.

## Why it is a separate process

The brief requires it, and the requirement is right: a browser rendering an
arbitrary website is the least trustworthy code in the system, because it
executes attacker-authored JavaScript by design.

Chromium's sandbox is good and stays enabled. Planning on it never failing is
not a plan. The question worth answering is what an attacker holds when it
does — and the answer here is: a bearer token good for eleven endpoints (listed
in `docs/security.md`), and a scratch directory.

## Its environment is the security boundary

```
CONTROL_PLANE_URL   http://localhost:3000
WORKER_TOKEN        <32+ chars>
WORKER_NAME         worker-local
… limits and timeouts
```

No `DATABASE_URL`. No `STORAGE_*`. No `SESSION_SECRET`. No `ANTHROPIC_API_KEY`.

`loadWorkerEnv` **refuses to start** if any of them is present at all, so
handing the worker a copied `.env` is a crash rather than a silent widening of
its blast radius. `scripts/check-boundaries.mjs` fails the build if the worker
package or `@uxd/crawler` gains an import of `@uxd/database`, `@uxd/auth` or
the storage layer.

If the worker needs a fact from the database, the right change is an endpoint
under `/api/internal/*` — not a connection string.

## The loop

```
verify the browser
register
      │
      ▼
POST /jobs/lease  ──►  n items, each with the job's validated config
      │
      ├─ heartbeat every N seconds while items are in flight
      │
      ▼
per item, in parallel up to WORKER_CONCURRENCY:
      guard the URL again  ── DNS can change between validation and capture
      robots.txt           ── cached per host
      rate limit           ── per host, from the job config
      fetch or render      ── level 1 HTTP, level 2 browser
      extract              ── cheerio, everything sanitised
      upload               ── POST /media
      report               ── POST /items/report, with discovered URLs
      │
      ▼
sleep WORKER_POLL_INTERVAL_MS, repeat
```

Level 1 is a guarded HTTP fetch; level 2 launches a browser. `needsBrowser()`
escalates when the HTML suggests client-side rendering, so a static page does
not cost three seconds of Chromium.

## Leases

A lease is a claim with an expiry. Three things follow.

**The work is never lost.** Kill the worker mid-capture and its items become
re-leasable after `WORKER_LEASE_SECONDS`; `reclaimExpiredLeases` returns them to
`pending` and increments attempts. §6.

**A stale worker cannot corrupt a result.** A worker that hung, lost its lease
and came back cannot report for an item someone else now owns — `completeItem`
checks the lease token and **returns** "stale lease" rather than throwing. A
stale report is an expected outcome, not an error.

**A slow page is not a dead worker.** Heartbeats extend the lease while work is
genuinely in progress.

`WORKER_LEASE_SECONDS` is the upper bound on how long work sits stuck after a
crash — not a per-page timeout, which is `WORKER_ITEM_TIMEOUT_MS`.

## Every capture is bounded

| | |
|---|---|
| `WORKER_NAV_TIMEOUT_MS` | Navigation |
| `WORKER_ITEM_TIMEOUT_MS` | The whole item, so a page that loads fast then spins cannot hold a lease |
| `WORKER_MAX_PAGE_BYTES` | Total page weight, enforced *while loading* |
| `WORKER_MAX_RESPONSE_BYTES` | One response, enforced *while reading* — a lying `Content-Length` cannot exhaust memory |
| `WORKER_MAX_REDIRECTS` | Hops. Each one is re-guarded, so this bounds work rather than safety |
| `WORKER_CONCURRENCY` | Browser contexts, ~150–350MB each |
| `WORKER_MEMORY_LIMIT_MB` | Advisory locally; the container enforces it in production |

Plus: a fresh isolated context per item, subresource hosts screened by a route
handler, and the browser recycled after 200 captures.

## Deployment

A container. Everything about the design assumes one:

- **CPU and memory limits at the container level.** `WORKER_MEMORY_LIMIT_MB` is
  advisory; a cgroup is not.
- **Keep it off the database network.** It has no credentials, and a network
  path it cannot use is one less thing to reason about.
- **Egress to the internet and to `CONTROL_PLANE_URL`.** Nothing else. The SSRF
  guard blocks private ranges in the application; a network policy that blocks
  them too is the second layer.
- **Ephemeral filesystem.** `CRAWLEE_STORAGE_DIR` is scratch, wiped between
  items.
- **Scale horizontally.** `SKIP LOCKED` means several workers poll the same
  queue without coordination. There is no leader and no partitioning.
- **`WORKER_CONTACT_URL`.** A site owner who notices the traffic should be able
  to find out who we are and ask us to stop.

## Shutdown

SIGTERM: stop polling, finish in-flight items, report them, deregister, exit.
Items still running when the grace period expires keep their lease and are
reclaimed — losing a lease is the designed outcome, not an incident.

## When it is not working

**Nothing is leased, jobs stay queued.** The token is wrong, or the CMS is
unreachable. `WORKER_TOKEN` must equal `WORKER_SHARED_SECRET`. A 401 from
`/jobs/lease` says the credential; a connection error says the URL.

**Every URL comes back blocked.** The SSRF guard is doing its job. Private and
loopback addresses are refused by design, so a `localhost` target is expected
to fail. Settings lists every blocked range with its reason.

**Chromium will not launch.** `npx playwright install chromium`. Do not reach
for `--no-sandbox`: the build check refuses it, and it would trade the one
control that actually contains a compromise for a faster fix.

**Captures time out on heavy pages.** Raise `WORKER_NAV_TIMEOUT_MS` and
`WORKER_ITEM_TIMEOUT_MS`, and check the page-weight budget — a page over
`WORKER_MAX_PAGE_BYTES` is aborted deliberately.

**Memory climbs.** Lower `WORKER_CONCURRENCY`. Contexts, not CPU, are the cost.
