/**
 * A subdomain added on purpose is its own website (weave.figma.com is
 * "Figma Weave", not a page of Figma), and pages on it find it. Everything
 * else keeps the one-domain-one-website rule.
 *
 * Runs against the PGlite dev server started by `npm run db:serve`, with
 * run-unique domains, and removes what it made.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { inArray } from "drizzle-orm";
import { type Database, type DatabaseHandle, createDatabase, sources } from "@uxd/database";
import { resolveSourceForUrl } from "@uxd/api";
import { shortId, validateUrl } from "@uxd/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const ROOT = `acme${shortId(6).toLowerCase()}.com`;

let handle: DatabaseHandle;
let db: Database;
const made: string[] = [];

function parsed(url: string) {
  const result = validateUrl(url, { assumeHttps: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function resolve(url: string, ownSubdomain?: boolean) {
  const result = await resolveSourceForUrl(db, parsed(url), { ownSubdomain });
  if (result.created) made.push(result.sourceId);
  return result;
}

async function row(id: string) {
  const [found] = await db.select().from(sources).where(inArray(sources.id, [id]));
  return found!;
}

before(async () => {
  handle = await createDatabase({ url: DATABASE_URL });
  db = handle.db;
});

after(async () => {
  if (made.length) await db.delete(sources).where(inArray(sources.id, made));
  await handle.close();
});

describe("subdomain websites", () => {
  let parent: string;
  let weave: string;

  it("files a page on a subdomain under its parent website by default", async () => {
    parent = (await resolve(`https://www.${ROOT}/`)).sourceId;
    const page = await resolve(`https://weave.${ROOT}/pricing`);
    assert.equal(page.sourceId, parent);
    assert.equal(page.created, false);
  });

  it("makes a subdomain added on purpose its own website, named after both", async () => {
    const added = await resolve(`https://weave.${ROOT}/`, true);
    assert.equal(added.created, true);
    assert.notEqual(added.sourceId, parent);
    weave = added.sourceId;
    const record = await row(weave);
    assert.equal(record.site, `weave.${ROOT}`);
    assert.equal(record.domain, `weave.${ROOT}`);
    assert.match(record.name, / Weave$/);
    assert.match(record.slug, /-weave(-\d+)?$/);
  });

  it("sends later pages on that subdomain to it, and the rest to the parent", async () => {
    assert.equal((await resolve(`https://weave.${ROOT}/features`)).sourceId, weave);
    assert.equal((await resolve(`https://${ROOT}/about`)).sourceId, parent);
    assert.equal((await resolve(`https://app.${ROOT}/`)).sourceId, parent);
  });

  it("does not split www or the bare domain off as a subdomain", async () => {
    assert.equal((await resolve(`https://www.${ROOT}/`, true)).sourceId, parent);
    assert.equal((await resolve(`https://${ROOT}/`, true)).sourceId, parent);
  });

  it("adding the same subdomain again finds it rather than making another", async () => {
    const again = await resolve(`https://weave.${ROOT}/`, true);
    assert.equal(again.sourceId, weave);
    assert.equal(again.created, false);
  });
});
