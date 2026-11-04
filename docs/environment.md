# Environment variables

Three surfaces, three schemas, in `packages/shared/src/env.ts`. Every variable
is validated at startup by Zod, so a bad value is a refusal to boot with a
message naming the variable — not a failure hours later in a worker.

`.env.example` and `.env.worker.example` are the annotated copies.
`npm run setup` creates both with generated secrets.

## CMS and API — `.env`

### Runtime

| | Default | |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the extra refusals below. |
| `UXD_LOG_LEVEL` | `info` | `error` · `warn` · `info` · `debug` |
| `UXD_LOG_FORMAT` | `json` | `pretty` for a terminal. Every payload passes through `redact()` either way. |

### Database

| | Default | |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Must be `postgres://`. The default in `.env` points at the PGlite dev server. |
| `DATABASE_POOL_MAX` | `10` | Ignored for local URLs, which are pinned to one connection because PGlite shares a single backend. |
| `DATABASE_SSL` | `disable` | `require` for a managed provider. `no-verify` is encrypted but unverified — acceptable only inside a trusted network path. |

### Sessions

| | Default | |
|---|---|---|
| `SESSION_SECRET` | — | **Required, 32+ chars.** Rotating it signs everyone out. |
| `SESSION_TTL_HOURS` | `12` | 1–720. |
| `SESSION_COOKIE_SECURE` | `true` | **Production boot fails if false.** A session cookie over plain HTTP is a session anyone on the path can take. |

### Worker credential

| | Default | |
|---|---|---|
| `WORKER_SHARED_SECRET` | — | **Required, 32+ chars.** Must match the worker's `WORKER_TOKEN`. Production boot fails if it equals `SESSION_SECRET`. |

### Storage

| | Default | |
|---|---|---|
| `STORAGE_DRIVER` | `local` | **Production boot fails on `local`** — the CMS filesystem is not durable storage. |
| `STORAGE_LOCAL_ROOT` | `.data/media` | Resolved against the **repository root**, not the working directory. |
| `STORAGE_S3_BUCKET` | — | Required when `s3`. |
| `STORAGE_S3_REGION` | `auto` | |
| `STORAGE_S3_ENDPOINT` | — | For R2, MinIO, B2. |
| `STORAGE_S3_ACCESS_KEY_ID` | — | Required when `s3`. |
| `STORAGE_S3_SECRET_ACCESS_KEY` | — | Required when `s3`. |
| `STORAGE_S3_FORCE_PATH_STYLE` | `false` | MinIO and some gateways need it. |
| `STORAGE_PUBLIC_BASE_URL` | — | A CDN domain, if the bucket is public. Unset means media is served through the CMS. |

### Origins

| | Default | |
|---|---|---|
| `CMS_BASE_URL` | `http://localhost:3000` | Absolute links, cookie scoping, and the base of public media URLs on the local driver. |
| `PUBLIC_FRONTEND_ORIGIN` | `http://localhost:3001` | Allowed to call the public API cross-origin. |

### Classification

| | Default | |
|---|---|---|
| `CLASSIFICATION_PROVIDER` | `heuristic` | `none` · `heuristic` · `anthropic`. Never required — the pipeline works with `none`. |
| `ANTHROPIC_API_KEY` | — | Required when `anthropic`; boot fails without it. |
| `CLASSIFICATION_MODEL` | `claude-opus-5` | |

### Uploads

| | Default | |
|---|---|---|
| `MEDIA_MAX_UPLOAD_MB` | `64` | 1–2048. |

## Public site — also `.env`

| | Default | |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `http://localhost:3000/api/public` | **The site's entire configuration.** It has no database access and no other data source. |

It also determines the origin the site's own CSP allows images from, since
screenshots are served by the CMS rather than by the site — so if this is
wrong, every image is blocked with nothing but a console entry to say so.

`next.config.ts` walks up for the repository-root `.env`, because Next only
looks beside the app. Done there rather than through `@uxd/shared` so the
site's runtime dependency list stays at exactly one package, which is what
makes "the frontend cannot reach the database" checkable.

## Capture worker — `.env.worker`

**Do not paste the CMS's `.env` here.** `loadWorkerEnv` refuses to start if
`DATABASE_URL`, `SESSION_SECRET`, any `STORAGE_*` variable or
`ANTHROPIC_API_KEY` is present *at all*. The shortness of this list is a
security control, not an oversight — see [security.md](security.md).

| | Default | |
|---|---|---|
| `CONTROL_PLANE_URL` | `http://localhost:3000` | The only host the worker calls besides the sites it captures. |
| `WORKER_TOKEN` | — | **Required, 32+ chars.** Matches `WORKER_SHARED_SECRET`. |
| `WORKER_NAME` | `worker-local` | Recorded on every capture. |
| `WORKER_CONCURRENCY` | `2` | Browser contexts. ~150–350MB each — tune against memory, not CPU. |
| `WORKER_BATCH_SIZE` | `4` | Items leased per poll. |
| `WORKER_POLL_INTERVAL_MS` | `2000` | 250–60000. |
| `WORKER_LEASE_SECONDS` | `300` | How long work sits stuck after a crash. Not a page timeout. |
| `WORKER_MAX_PAGE_BYTES` | `15728640` | Total page weight, subresources included. |
| `WORKER_MAX_RESPONSE_BYTES` | `26214400` | Enforced *while reading*, so a lying `Content-Length` cannot exhaust memory. |
| `WORKER_NAV_TIMEOUT_MS` | `30000` | |
| `WORKER_ITEM_TIMEOUT_MS` | `120000` | Whole-item deadline, so a page that loads fast then spins cannot hold a lease. |
| `WORKER_MAX_REDIRECTS` | `5` | Every hop is re-guarded, so this bounds work rather than safety. |
| `WORKER_MEMORY_LIMIT_MB` | `2048` | Advisory locally; enforced by the container in production. |
| `CRAWLEE_STORAGE_DIR` | `./storage` | Scratch. Wiped between items. |
| `WORKER_USER_AGENT` | research UA | Do not impersonate a browser you are not. |
| `WORKER_CONTACT_URL` | — | Set it. A site owner who notices the traffic should be able to reach someone. |

## Seed

| | Default | |
|---|---|---|
| `SEED_ADMIN_EMAIL` | `admin@localhost` | |
| `SEED_ADMIN_PASSWORD` | `change-me-in-development` | Rejected if too weak. The seed warns loudly when the default is used. |
| `SEED_ADMIN_NAME` | `Local Admin` | |

## What is *not* here

Crawl politeness, page limits, crawl depth, the tracking-parameter list, the
classification confidence floor, the domain blocklist and retention windows are
**settings**, not environment variables — operator-editable in the CMS,
validated by a per-key schema. §37 forbids hardcoding them, and putting them in
the environment would make them a deploy rather than a decision.

Conversely, secrets are environment variables and never settings. A database
URL editable through a web form is a way to exfiltrate it.

## Production checklist

`loadCmsEnv` refuses to boot when `NODE_ENV=production` and any of these hold:

- `STORAGE_DRIVER=local`
- `SESSION_COOKIE_SECURE=false`
- `SESSION_SECRET === WORKER_SHARED_SECRET`
- `CLASSIFICATION_PROVIDER=anthropic` without `ANTHROPIC_API_KEY`
- `STORAGE_DRIVER=s3` without a bucket and credentials

Verified: `next start` with a `local` driver and an insecure cookie exits with
both problems named.
