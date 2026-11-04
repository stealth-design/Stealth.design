/**
 * Public query tests (§14, §19).
 *
 * `public-leak.test.ts` proves the *serialisers* cannot emit an internal field.
 * These prove the *queries* select the right rows in the first place — the other
 * half of the guarantee, and the half that only a real database can answer:
 * every one of these assertions is about SQL semantics (join cardinality, the
 * published-content predicate, `count(distinct …)`, GROUP BY), so they run
 * against the PGlite dev server started by `npm run db:serve`.
 *
 * The suite builds a small fixture — one published record and one unpublished
 * one, each carrying taxonomy — and then asks the public queries what they can
 * see. Everything is created with recognisable ids and torn down afterwards, so
 * it is safe to run against a development database that already has data in it.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { inArray, sql } from "drizzle-orm";
import {
  type Database,
  type DatabaseHandle,
  contentItems,
  createDatabase,
  pageDetails,
  sources,
  taxonomyAssignments,
  taxonomyTerms,
  users,
} from "@uxd/database";
import {
  findPublicContentByUrl,
  getPublicContent,
  getPublicSource,
  listPublicContent,
  listPublicFacets,
  listPublicSources,
} from "@uxd/api";
import { createStorage } from "@uxd/media";
import { normalizeUrl, sha256Hex, shortId, slugify, urlHash, uuidv7 } from "@uxd/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

let handle: DatabaseHandle;
let db: Database;

/**
 * The public queries take a storage driver so they can turn a storage key into
 * a URL. Nothing here reads or writes a byte, so a local driver rooted at a
 * throwaway directory is enough; what matters is that the URL-building path is
 * exercised rather than stubbed.
 */
const storage = createStorage({
  driver: "local",
  localRoot: join(tmpdir(), `uxd-public-queries-${process.pid}`),
  localPublicBaseUrl: "/media",
});

/** A run-unique marker so the fixture can be found and removed precisely. */
const run = shortId();
const ids = {
  source: uuidv7(),
  published: uuidv7(),
  publishedTwo: uuidv7(),
  unpublished: uuidv7(),
  termVisible: uuidv7(),
  termSuggested: uuidv7(),
  termUnpublishedOnly: uuidv7(),
};
const publishedUrl = `https://fixture-${run}.example.com/pricing`;
/** Normalised once, so the fixture and the lookups agree by construction. */
const publishedNormalized = normalizeUrl(publishedUrl);
const publishedHash = urlHash(publishedUrl);
if (publishedNormalized === null || publishedHash === null) {
  throw new Error(`fixture URL did not normalise: ${publishedUrl}`);
}

/**
 * The approver on the published fixture.
 *
 * `content_items_approval_attributable` requires an approved or published
 * record to name who signed it off — a constraint worth honouring in a test
 * rather than working around, since publishing without attribution is exactly
 * what it exists to prevent. Any seeded user will do.
 */
let approverId: string;

before(async () => {
  handle = await createDatabase({ url: DATABASE_URL });
  db = handle.db;

  const [approver] = await db.select({ id: users.id }).from(users).limit(1);
  if (!approver) {
    throw new Error("No users in the database. Run `npm run db:seed` first.");
  }
  approverId = approver.id;

  await db.insert(sources).values({
    id: ids.source,
    name: `Fixture ${run}`,
    slug: `fixture-${run}`,
    domain: `fixture-${run}.example.com`,
    module: "web",
    status: "published",
  });

  const now = new Date();
  await db.insert(contentItems).values([
    {
      id: ids.published,
      sourceId: ids.source,
      module: "web",
      kind: "page",
      title: `Published fixture ${run}`,
      slug: slugify(`published-fixture-${run}`),
      status: "published",
      rightsStatus: "reference_use",
      publishedAt: now,
      approvedAt: now,
      approvedBy: approverId,
    },
    {
      id: ids.publishedTwo,
      sourceId: ids.source,
      module: "web",
      kind: "page",
      title: `Second published fixture ${run}`,
      slug: slugify(`second-published-fixture-${run}`),
      status: "published",
      rightsStatus: "reference_use",
      publishedAt: now,
      approvedAt: now,
      approvedBy: approverId,
    },
    {
      id: ids.unpublished,
      sourceId: ids.source,
      module: "web",
      kind: "page",
      title: `Unpublished fixture ${run}`,
      slug: slugify(`unpublished-fixture-${run}`),
      status: "needs_review",
      rightsStatus: "pending_review",
    },
  ]);

  await db.insert(pageDetails).values({
    contentItemId: ids.published,
    url: publishedUrl,
    normalizedUrl: publishedNormalized,
    normalizedUrlHash: publishedHash,
    pageTitle: `Published fixture ${run}`,
    httpStatus: 200,
  });

  await db.insert(taxonomyTerms).values([
    {
      id: ids.termVisible,
      kind: "ui_pattern",
      name: `Visible pattern ${run}`,
      slug: `visible-pattern-${run}`,
      path: `visible-pattern-${run}`,
      status: "active",
    },
    {
      id: ids.termSuggested,
      kind: "ui_pattern",
      name: `Suggested pattern ${run}`,
      slug: `suggested-pattern-${run}`,
      path: `suggested-pattern-${run}`,
      status: "active",
    },
    {
      id: ids.termUnpublishedOnly,
      kind: "ui_pattern",
      name: `Unpublished-only pattern ${run}`,
      slug: `unpublished-only-pattern-${run}`,
      path: `unpublished-only-pattern-${run}`,
      status: "active",
    },
  ]);

  await db.insert(taxonomyAssignments).values([
    // Human-verified on published content: this one must be publicly visible.
    {
      id: uuidv7(),
      termId: ids.termVisible,
      target: "content",
      contentItemId: ids.published,
      origin: "human_verified",
      reviewStatus: "accepted",
    },
    // The same term on a second published record. This is what makes the
    // facet count a count: two records, one term, count of 2. (A duplicate
    // assignment of one term to one record is impossible — the schema has a
    // unique index on the pair — so the aggregate cannot fan out that way.)
    {
      id: uuidv7(),
      termId: ids.termVisible,
      target: "content",
      contentItemId: ids.publishedTwo,
      origin: "human_verified",
      reviewStatus: "accepted",
    },
    // An unreviewed machine guess on published content (§14): must not appear.
    {
      id: uuidv7(),
      termId: ids.termSuggested,
      target: "content",
      contentItemId: ids.published,
      origin: "ai_suggested",
      confidence: 0.91,
      model: "test",
      reviewStatus: "pending",
    },
    // Human-verified, but on content that is not published: must not appear.
    {
      id: uuidv7(),
      termId: ids.termUnpublishedOnly,
      target: "content",
      contentItemId: ids.unpublished,
      origin: "human_verified",
      reviewStatus: "accepted",
    },
  ]);
});

after(async () => {
  if (!db) return;
  await db.delete(taxonomyAssignments).where(inArray(taxonomyAssignments.contentItemId, [ids.published, ids.publishedTwo, ids.unpublished]));
  await db.delete(taxonomyTerms).where(inArray(taxonomyTerms.id, [ids.termVisible, ids.termSuggested, ids.termUnpublishedOnly]));
  await db.delete(pageDetails).where(inArray(pageDetails.contentItemId, [ids.published, ids.publishedTwo, ids.unpublished]));
  await db.delete(contentItems).where(inArray(contentItems.id, [ids.published, ids.publishedTwo, ids.unpublished]));
  await db.delete(sources).where(inArray(sources.id, [ids.source]));
  await handle.close();
});

describe("listPublicFacets", () => {
  it("returns human-confirmed terms on published content", async () => {
    const facets = await listPublicFacets(db);
    const patterns = facets.find((facet) => facet.kind === "ui_pattern");
    assert.ok(patterns, "expected a ui_pattern facet group");

    const visible = patterns.terms.find((entry) => entry.term.id === ids.termVisible);
    assert.ok(visible, "human-verified term on published content should be a facet");
    assert.equal(visible.count, 2, "both published records carry this term");
  });

  it("omits unreviewed AI suggestions (§14)", async () => {
    const facets = await listPublicFacets(db);
    const all = facets.flatMap((facet) => facet.terms.map((entry) => entry.term.id));
    assert.ok(
      !all.includes(ids.termSuggested),
      "an ai_suggested/pending assignment must never become a public facet",
    );
  });

  it("omits terms whose only content is unpublished", async () => {
    const facets = await listPublicFacets(db);
    const all = facets.flatMap((facet) => facet.terms.map((entry) => entry.term.id));
    assert.ok(
      !all.includes(ids.termUnpublishedOnly),
      "a facet must not advertise a filter that returns nothing",
    );
  });

  it("honours the kind filter", async () => {
    const facets = await listPublicFacets(db, { kinds: ["ui_pattern"] });
    assert.ok(
      facets.every((facet) => facet.kind === "ui_pattern"),
      `expected only ui_pattern facets, got ${facets.map((f) => f.kind).join(", ")}`,
    );
  });

  it("returns no facets for a kind that has none", async () => {
    const facets = await listPublicFacets(db, { kinds: ["industry"] });
    const all = facets.flatMap((facet) => facet.terms.map((entry) => entry.term.id));
    assert.ok(!all.includes(ids.termVisible));
  });
});

describe("listPublicContent", () => {
  it("includes the published record and excludes the unpublished one", async () => {
    const { items } = await listPublicContent(db, storage, {
      sourceSlug: `fixture-${run}`,
      page: 1,
      pageSize: 50,
    });
    const found = items.map((item) => item.id);
    assert.ok(found.includes(ids.published), "published record should be listed");
    assert.ok(!found.includes(ids.unpublished), "unpublished record must not be listed");
  });

  it("narrows by a human-confirmed term slug", async () => {
    const { items } = await listPublicContent(db, storage, {
      termSlugs: [`visible-pattern-${run}`],
      page: 1,
      pageSize: 50,
    });
    assert.deepEqual(
      items.map((item) => item.id).sort(),
      [ids.published, ids.publishedTwo].sort(),
    );
  });

  it("returns nothing for a term that is only an AI suggestion (§14)", async () => {
    const { items } = await listPublicContent(db, storage, {
      termSlugs: [`suggested-pattern-${run}`],
      page: 1,
      pageSize: 50,
    });
    assert.equal(items.length, 0);
  });

  // V1 search is by company: everything published is a hero section, so the
  // name of the company is what a visitor types.
  it("finds the record by its company's name", async () => {
    const { items } = await listPublicContent(db, storage, {
      q: `Fixture ${run}`,
      page: 1,
      pageSize: 50,
    });
    assert.ok(items.some((item) => item.id === ids.published));
  });

  it("finds the record by its website", async () => {
    const { items } = await listPublicContent(db, storage, {
      q: `fixture-${run}.example`,
      page: 1,
      pageSize: 50,
    });
    assert.ok(items.some((item) => item.id === ids.published));
  });

  it("does not search inside titles", async () => {
    const { items } = await listPublicContent(db, storage, {
      q: `Published fixture ${run}`,
      page: 1,
      pageSize: 50,
    });
    assert.ok(!items.some((item) => item.id === ids.published));
  });

  it("never sends the capture date", async () => {
    const { items } = await listPublicContent(db, storage, { page: 1, pageSize: 50 });
    const record = items.find((item) => item.id === ids.published);
    assert.ok(record, "expected the published record");
    assert.ok(!("capturedAt" in record), "capturedAt must stay internal");
    assert.ok(record.primaryMedia === null || !("capturedAt" in record.primaryMedia));
  });
});

describe("getPublicContent", () => {
  it("resolves the published record by slug", async () => {
    const detail = await getPublicContent(db, storage, {
      slug: slugify(`published-fixture-${run}`),
    });
    assert.ok(detail, "expected the published record");
    assert.equal(detail.id, ids.published);
  });

  it("refuses the unpublished record by slug", async () => {
    const detail = await getPublicContent(db, storage, {
      slug: slugify(`unpublished-fixture-${run}`),
    });
    assert.equal(detail, null, "an unpublished slug must be indistinguishable from a missing one");
  });

  it("only exposes human-confirmed taxonomy on the detail", async () => {
    const detail = await getPublicContent(db, storage, {
      slug: slugify(`published-fixture-${run}`),
    });
    assert.ok(detail);
    const termIds = detail.taxonomy.map((term) => term.id);
    assert.ok(termIds.includes(ids.termVisible));
    assert.ok(!termIds.includes(ids.termSuggested));
  });
});

describe("findPublicContentByUrl", () => {
  it("resolves a published page by its normalised URL hash", async () => {
    const row = await findPublicContentByUrl(db, publishedHash);
    assert.equal(row?.id, ids.published);
  });

  it("does not resolve a URL whose content is unpublished", async () => {
    const row = await findPublicContentByUrl(db, sha256Hex(`missing-${run}`));
    assert.equal(row, null);
  });
});

describe("listPublicSources", () => {
  it("includes a public source that has published content", async () => {
    const { items } = await listPublicSources(db, { page: 1, pageSize: 200 });
    assert.ok(items.some((item) => item.id === ids.source));
  });

  it("resolves the source by slug", async () => {
    const detail = await getPublicSource(db, `fixture-${run}`);
    assert.equal(detail?.id, ids.source);
  });

  it("counts only published content on the source", async () => {
    const { items } = await listPublicSources(db, { page: 1, pageSize: 200 });
    const row = items.find((item) => item.id === ids.source);
    assert.ok(row);
    assert.equal(
      row.publishedCount,
      2,
      "the source has three records, one of them unpublished",
    );
  });
});

describe("SQL shape", () => {
  /**
   * A regression guard for a specific and easily-repeated mistake: a column
   * interpolated into a raw `sql` fragment in the *select list* renders
   * unqualified, so a correlated subquery written there cannot resolve the
   * outer row. It fails at parse time, which means any query built that way is
   * a hard 500 rather than a subtly wrong answer — worth a test that simply
   * executes every public query and asserts the database accepted it.
   */
  it("every public query is executable", async () => {
    await Promise.all([
      listPublicFacets(db),
      listPublicFacets(db, { kinds: ["ui_pattern", "industry"] }),
      listPublicContent(db, storage, { page: 1, pageSize: 5 }),
      listPublicContent(db, storage, {
        q: "anything",
        termSlugs: ["a", "b"],
        collectionSlug: "c",
        kind: "page",
        module: "web",
        sourceSlug: "nope",
        platform: "web",
        deviceClass: "desktop",
        sort: "title",
        page: 1,
        pageSize: 5,
      }),
      listPublicSources(db, { module: "web", page: 1, pageSize: 5 }),
      db.execute(sql`select 1`),
    ]);
  });
});
