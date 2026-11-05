/**
 * One-off: copy the CMS from SOURCE_DATABASE_URL into DATABASE_URL, and move
 * local media files (.data/media) into Vercel Blob.
 *
 *   node scripts/migrate-from-source.mjs            dry run: full copy inside a
 *                                                   transaction, then ROLLBACK;
 *                                                   no uploads
 *   node scripts/migrate-from-source.mjs --apply    copy (COMMIT) + upload files
 *   node scripts/migrate-from-source.mjs --media-only --apply
 *                                                   only upload files (re-run
 *                                                   after adding more files)
 *
 * The copy REPLACES every row in the target's public schema. Both databases
 * must be at the same migration (checked). Foreign keys are dropped and
 * re-added inside the transaction, so re-adding them validates every row.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import pg from "pg";
import { list, put } from "@vercel/blob";

process.loadEnvFile(".env");
const APPLY = process.argv.includes("--apply");
const MEDIA_ONLY = process.argv.includes("--media-only");
const MEDIA_ROOT = ".data/media";
const { SOURCE_DATABASE_URL, DATABASE_URL, BLOB_READ_WRITE_TOKEN } = process.env;
const BLOB_ACCESS = process.env.STORAGE_BLOB_ACCESS === "private" ? "private" : "public";
if (!SOURCE_DATABASE_URL || !DATABASE_URL) throw new Error("SOURCE_DATABASE_URL and DATABASE_URL must be set");
if (new URL(SOURCE_DATABASE_URL).hostname === new URL(DATABASE_URL).hostname) throw new Error("Source and target are the same host");

// Every value as text, so nothing is reshaped on the way through (timestamps
// keep microseconds, bigints stay exact, arrays/json/bytea stay in text form).
const rawTypes = { getTypeParser: () => (v) => v };
const connect = async (url) => { const c = new pg.Client({ connectionString: url, types: rawTypes }); await c.connect(); return c; };
const log = (...a) => console.log(...a);
const ident = (s) => `"${s.replaceAll('"', '""')}"`;

const src = await connect(SOURCE_DATABASE_URL);
const dst = await connect(DATABASE_URL);

try {
  const hashes = async (c) => (await c.query("select hash from drizzle.__drizzle_migrations order by id")).rows.map((r) => r.hash).join();
  if ((await hashes(src)) !== (await hashes(dst))) throw new Error("Source and target are at different migrations");

  if (!MEDIA_ONLY) await copyDatabase();
  await moveMedia();
} finally {
  await src.end();
  await dst.end();
}

async function copyDatabase() {
  const tables = (await dst.query(
    "select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1",
  )).rows.map((r) => r.relname);

  await src.query("begin isolation level repeatable read read only");
  await dst.query("begin");
  try {
    const fks = (await dst.query(`
      select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
      from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`)).rows;
    for (const fk of fks) await dst.query(`alter table ${fk.tbl} drop constraint ${ident(fk.conname)}`);
    await dst.query(`truncate ${tables.map(ident).join(", ")}`);

    const counts = [];
    for (const table of tables) {
      const cols = (await dst.query(
        `select attname from pg_attribute where attrelid = $1::regclass and attnum > 0
           and not attisdropped and attgenerated = '' order by attnum`, [`public.${ident(table)}`],
      )).rows.map((r) => r.attname);
      const colList = cols.map(ident).join(", ");
      const rows = (await src.query({ text: `select ${colList} from public.${ident(table)}`, rowMode: "array" })).rows;
      const perBatch = Math.max(1, Math.floor(60000 / cols.length));
      for (let i = 0; i < rows.length; i += perBatch) {
        const batch = rows.slice(i, i + perBatch);
        const params = [];
        const tuples = batch.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`);
        await dst.query(`insert into public.${ident(table)} (${colList}) values ${tuples.join(", ")}`, params);
      }
      const after = Number((await dst.query(`select count(*) from public.${ident(table)}`)).rows[0].count);
      if (after !== rows.length) throw new Error(`${table}: copied ${rows.length} but target has ${after}`);
      if (rows.length) counts.push(`${table}=${rows.length}`);
    }
    log("Copied rows:", counts.join(" "));

    for (const fk of fks) await dst.query(`alter table ${fk.tbl} add constraint ${ident(fk.conname)} ${fk.def}`);
    log(`Re-added and validated ${fks.length} foreign keys`);

    const switched = await dst.query(
      "update media_assets set storage_driver = 'blob', storage_bucket = null where storage_driver = 'local'");
    log(`Media records switched to blob: ${switched.rowCount}`);

    if (APPLY) { await dst.query("commit"); log("DATABASE COPY COMMITTED"); }
    else { await dst.query("rollback"); log("Dry run: database copy rolled back, production unchanged"); }
  } catch (error) {
    await dst.query("rollback").catch(() => {});
    throw error;
  } finally {
    await src.query("rollback").catch(() => {});
  }
}

async function moveMedia() {
  // Records come from the source (identical to the target after the copy).
  const assets = (await src.query("select storage_key as key, mime_type as type from media_assets")).rows;
  const derivs = (await src.query("select storage_key as key, mime_type as type from media_derivatives")).rows;
  const wanted = [...assets, ...derivs];

  // Files may sit at their full key or flat; match exact path first, then name.
  const files = readdirSync(MEDIA_ROOT, { recursive: true })
    .map((f) => String(f))
    .filter((f) => statSync(join(MEDIA_ROOT, f)).isFile());
  const byPath = new Map(files.map((f) => [f.split(sep).join("/"), f]));
  const byName = new Map(files.map((f) => [basename(f), f]));

  const existing = new Set();
  let cursor;
  do {
    const r = await list({ cursor, limit: 1000, token: BLOB_READ_WRITE_TOKEN });
    for (const b of r.blobs) existing.add(b.pathname);
    cursor = r.cursor;
  } while (cursor);

  const toUpload = [], missing = [];
  let already = 0;
  for (const w of wanted) {
    if (existing.has(w.key)) { already++; continue; }
    const file = byPath.get(w.key) ?? byPath.get(w.key.replace(/^media\//, "")) ?? byName.get(basename(w.key));
    if (file) toUpload.push({ ...w, file }); else missing.push(w.key);
  }
  log(`Media: ${wanted.length} files referenced, ${already} already in Blob, ${toUpload.length} to upload, ${missing.length} with no local file`);

  if (!APPLY) { log("Dry run: no files uploaded"); return; }
  let done = 0;
  for (const u of toUpload) {
    await put(u.key, readFileSync(join(MEDIA_ROOT, u.file)), {
      token: BLOB_READ_WRITE_TOKEN, access: BLOB_ACCESS, contentType: u.type,
      addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000,
    });
    if (++done % 20 === 0) log(`  uploaded ${done}/${toUpload.length}`);
  }
  log(`UPLOADED ${done} files to Blob`);
}
