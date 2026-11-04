/**
 * Regenerate derivatives from the stored masters.
 *
 * The originals are never touched — that is the point. A change to
 * `DERIVATIVE_SPECS` only affects renditions, so there is no reason to re-crawl
 * ten sites to see it; the masters are already on disk and are the input this
 * reads. Recapturing would also lose the comparison, because the pages would
 * have changed underneath us.
 *
 * Old renditions are deleted only after the new ones are written, so an
 * interrupted run degrades to duplicate rows rather than to a record with no
 * images at all.
 *
 *   node scripts/reprocess-derivatives.mjs --published   # published records only
 *   node scripts/reprocess-derivatives.mjs --all
 *   node scripts/reprocess-derivatives.mjs --published --dry-run
 */
import { eq, inArray } from "drizzle-orm";
import {
  contentItems,
  createDatabase,
  mediaAssets,
  mediaDerivatives,
  mediaUsages,
} from "@uxd/database";
import { buildStorageKey, createStorage, generateDerivatives } from "@uxd/media";
import { createLogger, uuidv7 } from "@uxd/shared";
import { loadCmsEnv, loadEnvFile } from "@uxd/shared/env";

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const R = "[31m";
const X = "[0m";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const publishedOnly = !args.has("--all");

loadEnvFile();
const env = loadCmsEnv();
const logger = createLogger({ name: "reprocess", level: "warn", format: "pretty" });
const handle = createDatabase({ url: env.DATABASE_URL, applicationName: "uxd-reprocess" });
const db = handle.db;
const storage = createStorage({
  driver: "local",
  localRoot: env.STORAGE_LOCAL_ROOT ?? ".data/media",
  localPublicBaseUrl: env.STORAGE_LOCAL_PUBLIC_BASE_URL ?? "/media",
});

/** Media attached to the records in scope. */
const rows = publishedOnly
  ? await db
      .selectDistinct({
        id: mediaAssets.id,
        storageKey: mediaAssets.storageKey,
        mimeType: mediaAssets.mimeType,
        width: mediaAssets.width,
        height: mediaAssets.height,
        capturedAt: mediaAssets.capturedAt,
      })
      .from(mediaAssets)
      .innerJoin(mediaUsages, eq(mediaUsages.mediaId, mediaAssets.id))
      .innerJoin(contentItems, eq(contentItems.id, mediaUsages.contentItemId))
      .where(eq(contentItems.status, "published"))
  : await db
      .select({
        id: mediaAssets.id,
        storageKey: mediaAssets.storageKey,
        mimeType: mediaAssets.mimeType,
        width: mediaAssets.width,
        height: mediaAssets.height,
        capturedAt: mediaAssets.capturedAt,
      })
      .from(mediaAssets);

console.log(
  `${B}Reprocessing derivatives for ${rows.length} master file(s)${X}` +
    `${dryRun ? ` ${Y}(dry run)${X}` : ""}`,
);
console.log(`${D}masters are read, never written${X}\n`);

let done = 0;
let created = 0;
let removed = 0;
let failed = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const media of rows) {
  let bytes;
  try {
    // `get` hands back a stream; sharp needs the whole buffer.
    const chunks = [];
    for await (const chunk of await storage.get(media.storageKey)) chunks.push(chunk);
    bytes = Buffer.concat(chunks);
  } catch (error) {
    console.log(`  ${R}missing master${X} ${media.storageKey}`);
    failed += 1;
    continue;
  }

  const existing = await db
    .select({
      id: mediaDerivatives.id,
      kind: mediaDerivatives.kind,
      storageKey: mediaDerivatives.storageKey,
      width: mediaDerivatives.width,
      byteSize: mediaDerivatives.byteSize,
    })
    .from(mediaDerivatives)
    .where(eq(mediaDerivatives.mediaId, media.id));
  for (const e of existing) bytesBefore += e.byteSize ?? 0;

  let generated;
  try {
    generated = await generateDerivatives(bytes, {
      mimeType: media.mimeType,
      width: media.width,
      height: media.height,
      logger,
    });
  } catch (error) {
    console.log(`  ${R}generate failed${X} ${media.storageKey} ${D}${String(error).slice(0, 70)}${X}`);
    failed += 1;
    continue;
  }

  if (generated.length === 0) {
    // Formats that cannot be rasterised (SVG, HTML snapshots) legitimately
    // produce nothing. Leaving their old rows alone is correct.
    done += 1;
    continue;
  }

  const before = existing
    .map((e) => `${e.kind[0]}${e.width}`)
    .sort()
    .join(" ");
  const after = generated
    .map((g) => `${g.kind[0]}${g.width}`)
    .sort()
    .join(" ");

  if (!dryRun) {
    // Bytes first: every rendition is already generated in memory, and
    // `buildStorageKey` is deterministic per (media, kind), so a rendition
    // that still exists simply overwrites its predecessor in place.
    const written = [];
    for (const derivative of generated) {
      const key = buildStorageKey({
        extension: derivative.extension,
        id: media.id,
        variant: derivative.kind,
        at: media.capturedAt ?? new Date(),
      });
      await storage.put({
        key,
        body: derivative.bytes,
        contentType: derivative.mimeType,
        contentLength: derivative.byteSize,
      });
      written.push({ derivative, key });
      bytesAfter += derivative.byteSize;
    }

    // `media_derivatives` is unique on (media_id, kind), so the old rows have
    // to go before the new ones land. Both happen in one transaction: a
    // half-applied swap would leave a record with no renditions at all.
    await db.transaction(async (tx) => {
      if (existing.length > 0) {
        await tx.delete(mediaDerivatives).where(
          inArray(
            mediaDerivatives.id,
            existing.map((e) => e.id),
          ),
        );
      }
      for (const { derivative, key } of written) {
        await tx.insert(mediaDerivatives).values({
          id: uuidv7(),
          mediaId: media.id,
          kind: derivative.kind,
          storageKey: key,
          mimeType: derivative.mimeType,
          width: derivative.width,
          height: derivative.height,
          byteSize: derivative.byteSize,
        });
        created += 1;
      }
    });

    // Only files that no new rendition claimed. A `large` that is no longer
    // generated for a narrow source leaves one behind; everything else was
    // overwritten above, and deleting those keys would delete what we just
    // wrote.
    const claimed = new Set(written.map((w) => w.key));
    for (const e of existing) {
      if (claimed.has(e.storageKey)) continue;
      await storage.delete(e.storageKey).catch(() => {});
      removed += 1;
    }
  } else {
    for (const g of generated) bytesAfter += g.byteSize;
  }

  done += 1;
  if (before !== after) {
    console.log(`  ${G}${String(done).padStart(3)}${X} ${D}${before || "(none)"}${X} -> ${after}`);
  }
}

console.log(`\n${B}Done${X}`);
console.log(`  ${done} master(s) processed · ${created} rendition(s) written · ${removed} retired · ${failed} failed`);
console.log(
  `  rendition bytes ${D}${(bytesBefore / 1024 / 1024).toFixed(1)}MB -> ${(bytesAfter / 1024 / 1024).toFixed(1)}MB${X}`,
);
if (dryRun) console.log(`  ${Y}nothing was written${X}`);

await handle.close();
