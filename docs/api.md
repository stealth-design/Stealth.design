# API structure

Three surfaces, in one Next application, with different policies. The
separation is the design.

| | Path | Who | Auth | Writes? |
|---|---|---|---|---|
| **Public read API** | `/api/public/*` | anyone, the public site | none | no |
| **Worker control plane** | `/api/internal/*` | the capture worker | bearer token | yes, narrowly |
| **Server actions** | — | signed-in CMS users | session + permission | yes |

There is deliberately no fourth. The CMS's own screens use server actions
rather than a REST API, because an API the CMS calls from the browser is an API
anyone with a session can call — and everything it can do is then reachable
without the checks the screens imply.

## Public read API

Hono, mounted at `/api/public`. Every route is a GET. There is no write path to
authenticate, which is the strongest statement of §"the public frontend must
NEVER independently create or maintain content".

| | |
|---|---|
| `GET /` | What this API offers — endpoints, content kinds, modules, facet kinds |
| `GET /health` | Liveness, including database reachability |
| `GET /content` | Browse, with search and facets |
| `GET /content/:idOrSlug` | One record, with media, taxonomy and relations |
| `GET /flows/:idOrSlug` | A flow and its ordered steps |
| `GET /sources` | Products with published content |
| `GET /sources/:slug` | One product |
| `GET /facets` | Vocabularies with counts |
| `GET /collections` | Public collections |
| `GET /lookup?url=` | Resolve a captured URL to a record |
| `GET /media/[...key]` | Published screenshots (see below) |

`/content` accepts `q`, `kind`, `module`, `source`, `collection`, repeated
`term`, `platform`, `device`, `sort`, `page`, `pageSize` (max 200). Repeated
`term` parameters stack as **AND**, which is what makes filters narrow rather
than widen.

### What makes it safe

Four independent mechanisms, described in [security.md](security.md): queries
start from the publish gate, serialisers construct from an allowlist,
`assertPublishable` refuses non-public rows, and a CHECK constraint refuses the
invalid state. A 404 covers "no such thing" and "exists but unpublished"
identically.

### Errors

One envelope, everywhere:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Some of that input is not valid.",
             "issues": [{ "path": "pageSize", "message": "Too big: expected number to be <=200" }] } }
```

Getting there needed a wrapper. `@hono/zod-validator` catches its own
`ZodError` and answers with `{ success: false, error: <serialised ZodError> }`
and a 400 — a different shape from every other error, exposing Zod's internal
issue representation. `validate()` in `errors.ts` rethrows so the app's error
handler formats it: a 422, a stable code, one `{ path, message }` per bad
field. Use `validate`, not `zValidator`.

### Caching

`cache-control` per route class: reference data long, lists short, details
medium, health `no-store`. `vary: origin, accept-encoding` — no response can
legitimately vary by cookie, and saying so stops a CDN from guessing.

### Media

`GET /api/public/media/[...key]` serves published screenshots when
`STORAGE_DRIVER=local`. With S3 and a public bucket or CDN, media URLs point
straight at storage and the route is never reached.

It applies the same publish gate as every other public read:
`findPublicMediaByKey` resolves a key only when the asset is ready and used by
at least one published record. Withdraw the record and the image 404s on the
next request. Inline rendering is limited to a raster allowlist.

This is a *different route* from the CMS's session-gated `/media/[...key]`.
Two policies, two routes — see [security.md](security.md).

## Worker control plane

Hono, mounted at `/api/internal`. Six endpoints, bearer token.

| | |
|---|---|
| `POST /workers/register` | Announce a worker; returns its instance id |
| `POST /jobs/lease` | Claim items under a lease |
| `POST /jobs/heartbeat` | Extend a lease while work is genuinely progressing |
| `POST /items/report` | Report an outcome — this is where a capture lands |
| `POST /media` | Upload a screenshot |
| `POST /robots` | Report a fetched robots.txt for caching |

That list is the worker's entire capability. It is the reason a browser
compromise is contained: an attacker with the token can lease work, report
results and upload images, and cannot read content, publish anything, reach the
database or touch storage directly.

Two properties worth naming:

**A lease token gates completion.** A worker that hung, lost its lease and came
back cannot report a result for an item someone else now owns.
`completeItem` checks the token and **returns** "stale lease" rather than
throwing — a stale report is an expected outcome, not an error.

**A session cookie is not a worker credential.** Different middleware, and the
smoke test asserts a valid CMS session gets 401 from `/jobs/lease`. A
`worker_tokens` row names a principal, so an audit entry says *which* worker;
the shared-secret bootstrap path adopts the worker's self-reported name, which
is safe because one credential is one principal — self-reporting cannot
impersonate a *different* credential.

## Server actions

The CMS's writes. Every one follows the same shape: call a service in
`@uxd/api`, translate an `AppError` into something the screen can show.

```ts
export async function publishAction(contentId: string): Promise<ActionResult> {
  try {
    const context = await getAdminContext();
    await publishContent(context, contentId);
    refresh();
    return ok("Published.");
  } catch (error) {
    return failed(error, "Could not publish that record.");
  }
}
```

The permission check, the transition check, the publish gate and the audit
write all live in the service, not the action. So the same rules apply whether
a change arrives from a screen, a bulk operation or a script — there is one
implementation, and an action cannot forget a check because it does not perform
any.

Actions return a result object rather than throwing. A reviewer working a queue
with the keyboard should get a message, not lose their place.

## The typed public client

`@uxd/api/client` — a dependency-free subpath, which is what lets the public
site consume the API without transitively acquiring Drizzle, the schema or the
crawler. It **duplicates** the response shapes rather than importing them from
`serializers.ts`; the duplication is small and deliberate, and the alternative
is a frontend that can `import { db }`.

```ts
const api = createPublicApiClient({
  baseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/public",
  revalidate: 60,
});

const { items, total } = await api.listContent({ term: ["pricing"], pageSize: 24 });
const entry = await api.getContent("lumen-dashboard"); // null on 404
```

- **404 becomes `null`**, because "not found" is a normal page outcome, not an
  exception.
- **A 4xx is reported as `BAD_REQUEST`, a 5xx as `UPSTREAM_ERROR`.** It used to
  call both "upstream unavailable", which sent whoever read the log looking at
  the wrong machine.
- **`revalidate` passes through to `fetch`** and is ignored outside Next, so
  the same client works in a plain Node script.

## Rate limiting

In-memory, per instance, on the public API. Honest about what that is: with
several instances the effective limit is the configured one times the instance
count. Adequate for one instance; a shared counter is the fix, and it is on the
list in [next-steps.md](next-steps.md).

## Adding an endpoint

1. A query in `queries/public.ts`, starting from `publishedContentCondition()`.
2. A serialiser in `serializers.ts`, constructing from an allowlist.
3. A route using `validate()` for its query schema.
4. A method on the client, plus the response shape.
5. A `getJson` line in `scripts/smoke.mjs`.

Steps 1 and 2 are not optional. `npm run check:sql` will also want any
correlated subquery in a projection to qualify its outer reference — see
[known-limitations.md](known-limitations.md) for why that needs a checker.
