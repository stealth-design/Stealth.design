# Media storage model

Screenshots are the expensive artefact. A page can be re-fetched; a capture of
a page as it looked in March cannot. So the model is built around not losing
them and not storing them twice.

## Three tables

```
  media_assets        the file
  ├─ sha256           exact dedupe
  ├─ perceptual_hash  dHash, for near-duplicates
  ├─ storage_key      where the bytes are
  └─ provenance       source, capture, device, browser, worker
        │
        ├── media_derivatives   thumbnail, preview — one row each
        └── media_usages        which records use it, in which role
```

**`media_assets`** is the file, once. **`media_derivatives`** are the generated
sizes, one row each, so a derivative can be regenerated or a new size added
without touching the original. **`media_usages`** is many-to-many, because
deduplication means one file legitimately serves several records and several
roles.

Binaries are never in the database. §"Do not store binaries inside the
relational database" — the rows hold a key and metadata.

## Storage keys

```
media/2026/09/01a06d12-88fa-7e6f-9182-67914eb94783.png
media/2026/09/01a06d12-88fa-7e6f-9182-67914eb94783-thumbnail.webp
```

Date-partitioned, then the asset's uuidv7. Generated, **never derived from a
filename** — an uploaded name is attacker-controlled and belongs in a column,
not in a path.

Keys are never reused, so a body at a given key never changes and a response
can honestly be `immutable`.

`assertSafeKey` rejects traversal, absolute paths and doubled separators, and
the driver independently resolves under the storage root. Two checks, because a
bug here reads arbitrary files.

## Drivers

| | |
|---|---|
| `local` | Files under `STORAGE_LOCAL_ROOT`. Development only — production boot fails on it. Writes to a temp name and renames into place, so a crash cannot leave a truncated file that looks complete. |
| `s3` | S3 or anything S3-compatible (R2, MinIO, B2). Presigned URLs, or a CDN base if the bucket is public. |

One interface: `put`, `get`, `head`, `delete`, `url`.

`STORAGE_LOCAL_ROOT` is resolved against the **repository root**, not the
current working directory. That is a fix, and the bug is worth knowing: a
relative path resolved per-process gave the CMS `apps/cms/.data`, a workspace
script `packages/seed/.data` and a one-off script whatever its cwd was — three
directories each holding some of the files, with no error anywhere, because
every write succeeded and every read found nothing.

## Deduplication

**Exact, by sha256.** A re-crawl producing byte-identical output costs one row
lookup, not a second copy. This fires more than you would expect: for a page
shorter than the viewport, the "desktop viewport" and "full page" screenshots
are byte-identical, so one row serves both roles.

**Near-duplicate, by dHash.** A 64-bit perceptual hash, stored as
`char(16)`. Hamming distance under `NEAR_DUPLICATE_THRESHOLD` is a candidate,
surfaced to the reviewer rather than acted on — "these two look the same" is a
judgement, and a page that changed one word is *not* a duplicate even though it
is visually identical.

Because one file can serve several roles, counters are **recomputed, not
incremented**. A counter maintained by deltas across recapture, dedupe and
deletion drifts, and a drifted count is worse than a slightly more expensive
query, because it is the number an operator uses to decide something.

## Validation

In order, and every step can reject:

1. **Size**, against `MEDIA_MAX_UPLOAD_MB`.
2. **Magic bytes** — the type comes from content, never the extension or the
   client's claim. An allowlist, not a blocklist.
3. **Structural SVG detection**, ahead of a generic XML sniff. Without that
   ordering a legitimate SVG carrying an XML prolog was rejected as
   `MIME_NOT_ALLOWED`, and a hostile one got the same vague reason instead of
   the accurate `SVG_UNSAFE`.
4. **Decode.** `metadata()` only parses the header, so a truncated PNG passed
   validation. There is now a forced decode pass —
   `resize(8,8).raw().toBuffer()` with `failOn: "error"` — because a file that
   cannot be decoded is not an image.
5. **Dimensions**, against per-format caps.

A rejection carries a reason code and an operator-facing message. A file that
fails is not silently dropped: it is reported, and a quarantined upload is
retained for inspection and never served.

## Derivatives

`DERIVATIVE_SPECS` declares each size with a **height cap** as well as a width,
which matters here: a full-page screenshot can be 20,000px tall, and a
thumbnail scaled by width alone would be a 1px-wide sliver.

Generated with sharp, WebP, at capture time. Regenerating is adding rows, not
migrating the originals.

## Provenance

Every asset records where it came from — source, capture, crawl job, capture
method, device profile, viewport, scale factor, browser name and version,
worker name, screenshot scope, captured-at.

This is what makes a screenshot evidence rather than an image. "Which browser
rendered this, at what viewport, on what date, from which URL" is answerable
per file, which is the difference between a research library and a folder of
pictures.

None of it is public. The public media shape carries dimensions, alt text,
caption, device class and URLs — see `NEVER_PUBLIC_FIELDS`.

## Serving

Two routes, two policies. The distinction matters more than it looks.

**`/media/[...key]`** — the CMS's library. Requires a session. Content type from
the database row. Anything a browser could execute is forced to `attachment`
with `default-src 'none'; sandbox`. `private` caching.

**`/api/public/media/[...key]`** — published screenshots. No session, so far
stricter about what it serves: the key must belong to an asset that is ready
and used by at least one **published** record — the same condition every other
public read applies. Withdraw the record and the image 404s on the next
request, without anyone touching storage. Inline rendering only for a raster
allowlist; a derivative is always safe because sharp re-encoded it.

With S3 and a public bucket or CDN, public URLs point straight at storage and
that route is never reached. `publicMediaBaseUrl()` decides, in one place.

## The upload screen

Drag and drop, or a file picker. Per file: progress, the validation result with
its reason if rejected, whether it deduplicated against an existing asset, and
any near-duplicates with their distance.

Deduplication is reported rather than hidden. "This is the same file you
already have" is information a person wants — silently succeeding makes the
library look like it accepted a second copy.

## Deletion

Two operations, deliberately separate.

**Detach** removes a `media_usages` row. The file stays, because it may serve
another record.

**Delete bytes** removes the object and its derivatives and marks the asset
deleted. The row survives — the provenance is the audit trail, and destroying
it to reclaim a few kilobytes trades a permanent record for temporary space.

The Media screen's "unused" filter is the operational one: a library built by a
crawler accumulates orphans, and that is how a team finds them.
