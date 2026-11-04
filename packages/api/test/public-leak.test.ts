/**
 * Public API leak tests (§19).
 *
 * These assert the two independent guarantees that keep internal data off the
 * public surface:
 *
 *   1. The serialisers build their output from an allowlist, so no field from
 *      `NEVER_PUBLIC_FIELDS` can appear even when the row handed in is full of
 *      them. `findLeakedFields` walks the result at every depth.
 *   2. `assertPublishable` refuses to serialise a record that is not published,
 *      so a query bug cannot become a disclosure.
 *
 * The rows fed in below are deliberately *hostile*: every internal field is
 * populated with a recognisable sentinel. A serialiser that spreads its input
 * instead of picking fields fails immediately.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findLeakedFields,
  serialiseCollection,
  serialiseContentDetail,
  serialiseContentSummary,
  serialiseFlowDetail,
  serialiseFlowSummary,
  serialiseMedia,
  serialiseSource,
  serialiseTerm,
} from "@uxd/api";
import { LIFECYCLE_STATUSES, NEVER_PUBLIC_FIELDS, RIGHTS_STATUSES, rightsBlocksPublishing } from "@uxd/types";

const SECRET = "LEAKED-INTERNAL-VALUE";

/**
 * A content row carrying every internal field, each set to a sentinel.
 *
 * Left with its inferred literal type and cast at each call site, so that a
 * spread (`{ ...hostileContentRow, status }`) still typechecks. Casting the
 * declaration itself to `never` would make every spread of it an error, and the
 * point is to hand the serialiser more than its interface declares — exactly as
 * a real database row does.
 */
const hostileContentRow = {
  // Fields the serialiser is supposed to publish.
  id: "11111111-1111-7111-8111-111111111111",
  kind: "page",
  module: "web",
  title: "Stripe — Pricing",
  slug: "stripe-pricing",
  description: "A public description.",
  sourceUrl: "https://stripe.example.com/pricing",
  platform: "web",
  deviceClass: "desktop",
  capturedAt: new Date("2026-01-02T03:04:05Z"),
  publishedAt: new Date("2026-01-03T00:00:00Z"),
  attribution: "Stripe",
  status: "published" as const,
  rightsStatus: "permissioned" as const,
  deletedAt: null,

  // Every field that must never be published.
  internalNotes: SECRET,
  reviewNotes: SECRET,
  rightsNotes: SECRET,
  notes: SECRET,
  legalReviewStatus: SECRET,
  permissionStatus: SECRET,
  takedownStatus: SECRET,
  createdBy: SECRET,
  updatedBy: SECRET,
  approvedBy: SECRET,
  publishedBy: SECRET,
  reviewedBy: SECRET,
  assignedTo: SECRET,
  crawlJobId: SECRET,
  crawlJobItemId: SECRET,
  captureId: SECRET,
  leaseToken: SECRET,
  leasedBy: SECRET,
  errorMessage: SECRET,
  errorCode: SECRET,
  resultSummary: { secret: SECRET },
  storageKey: SECRET,
  storageBucket: SECRET,
  storageDriver: SECRET,
  scanStatus: SECRET,
  scanNotes: SECRET,
  passwordHash: SECRET,
  tokenHash: SECRET,
  userAgent: SECRET,
  ip: SECRET,
  consecutiveFailures: 42,
  robotsStatus: SECRET,
  crawlStatus: SECRET,
  health: SECRET,
};

const hostileSourceRow = {
  id: "22222222-2222-7222-8222-222222222222",
  name: "Stripe",
  slug: "stripe",
  domain: "stripe.example.com",
  companyName: "Stripe, Inc.",
  productName: "Stripe",
  type: "website",
  module: "web",
  // Internal.
  internalNotes: SECRET,
  rightsNotes: SECRET,
  health: SECRET,
  robotsStatus: SECRET,
  consecutiveFailures: 9,
  createdBy: SECRET,
  errorMessage: SECRET,
};

const hostileMediaRow = {
  id: "33333333-3333-7333-8333-333333333333",
  kind: "image",
  mimeType: "image/png",
  width: 1440,
  height: 3200,
  altText: "The pricing page",
  caption: null,
  capturedAt: new Date("2026-01-02T03:04:05Z"),
  viewportWidth: 1440,
  viewportHeight: 900,
  deviceClass: "desktop",
  status: "ready",
  // Internal.
  storageKey: SECRET,
  storageBucket: SECRET,
  storageDriver: SECRET,
  scanStatus: SECRET,
  scanNotes: SECRET,
  internalNotes: SECRET,
  crawlJobId: SECRET,
  captureId: SECRET,
  uploadedBy: SECRET,
};

const mediaUrls = {
  url: "https://cdn.example.test/media/a.png",
  originalUrl: "https://cdn.example.test/media/a.png",
  thumbnailUrl: "https://cdn.example.test/media/a-thumbnail.webp",
  previewUrl: "https://cdn.example.test/media/a-preview.webp",
  largeUrl: "https://cdn.example.test/media/a-large.webp",
};

/** Assert a payload contains neither a forbidden field name nor a sentinel. */
function assertNoLeak(label: string, payload: unknown): void {
  const leaked = findLeakedFields(payload);
  assert.deepEqual(leaked, [], `${label} leaked forbidden fields at: ${leaked.join(", ")}`);

  const serialised = JSON.stringify(payload);
  assert.ok(
    !serialised.includes(SECRET),
    `${label} contains the internal sentinel value somewhere in its output`,
  );
}

describe("serialisers publish an allowlist, not a filtered row", () => {
  it("content summary omits every internal field", () => {
    const payload = serialiseContentSummary(hostileContentRow, {
      source: serialiseSource(hostileSourceRow),
      primaryMedia: serialiseMedia(hostileMediaRow, mediaUrls),
    });
    assertNoLeak("content summary", payload);
    // ...while still publishing what it should.
    assert.equal(payload.title, "Stripe — Pricing");
    assert.equal(payload.slug, "stripe-pricing");
    assert.equal(payload.source?.name, "Stripe");
    assert.equal(payload.primaryMedia?.url, mediaUrls.url);
  });

  it("content detail omits every internal field at every depth", () => {
    const nested = serialiseContentSummary(hostileContentRow);
    const payload = serialiseContentDetail(hostileContentRow, {
      source: serialiseSource(hostileSourceRow),
      primaryMedia: serialiseMedia(hostileMediaRow, mediaUrls),
      media: [serialiseMedia(hostileMediaRow, mediaUrls)],
      taxonomy: [
        serialiseTerm({
          id: "t1",
          kind: "page_type",
          name: "Pricing",
          slug: "pricing",
          path: "marketing/pricing",
          description: null,
          // Internal fields on a term row.
          usageCount: 12,
          isSeed: true,
          createdBy: SECRET,
        } as never),
      ],
      relatedContent: [nested],
      flows: [
        serialiseFlowSummary({
          id: "f1",
          title: "Sign-up",
          slug: "sign-up",
          description: null,
          stepCount: 3,
          goal: null,
          status: "published",
          rightsStatus: "unknown",
          deletedAt: null,
        }),
      ],
      states: [nested],
      interactions: [nested],
      parent: nested,
      experience: nested,
    });

    assertNoLeak("content detail", payload);
    assert.equal(payload.media.length, 1);
    assert.equal(payload.taxonomy.length, 1);
    assert.equal(payload.flows.length, 1);
  });

  it("media omits storage keys and scan results", () => {
    const payload = serialiseMedia(hostileMediaRow, mediaUrls);
    assertNoLeak("media", payload);
    // A public consumer gets a URL, never a storage key: the key would expose
    // the bucket layout and, with a misconfigured bucket, the object itself.
    assert.equal(payload.url, mediaUrls.url);
    assert.ok(!("storageKey" in payload));
  });

  it("source omits health, robots status and internal notes", () => {
    const payload = serialiseSource(hostileSourceRow);
    assertNoLeak("source", payload);
    // Crawl health is operational information about our pipeline, not a fact
    // about the product, so it stays internal.
    assert.ok(!("health" in payload));
    assert.ok(!("robotsStatus" in payload));
  });

  it("flow detail omits internal fields", () => {
    const payload = serialiseFlowDetail(
      {
        id: "f1",
        title: "Sign-up",
        slug: "sign-up",
        description: "How Stripe onboards.",
        stepCount: 2,
        goal: "Create an account",
        status: "published",
        rightsStatus: "unknown",
        deletedAt: null,
      },
      {
        source: serialiseSource(hostileSourceRow),
        steps: [
          { position: 1, label: "Landing", content: serialiseContentSummary(hostileContentRow) },
          { position: 2, label: "Details", content: serialiseContentSummary(hostileContentRow) },
        ],
      },
    );
    assertNoLeak("flow detail", payload);
    assert.equal(payload.steps.length, 2);
  });

  it("collection omits curator and internal notes", () => {
    const payload = serialiseCollection({
      id: "c1",
      name: "Great onboarding",
      slug: "great-onboarding",
      description: "A set.",
      itemCount: 8,
      visibility: "public",
      status: "active",
      deletedAt: null,
      notes: SECRET,
      curatedBy: SECRET,
      createdBy: SECRET,
    } as never);
    assertNoLeak("collection", payload);
  });
});

describe("assertPublishable refuses anything not public", () => {
  it("throws for every non-published status", () => {
    for (const status of LIFECYCLE_STATUSES) {
      if (status === "published") continue;
      assert.throws(
        () => serialiseContentSummary({ ...hostileContentRow, status } as never),
        (error: unknown) => {
          const err = error as { status: number; publicMessage: string };
          // A non-public record is reported as "not found" to the caller. It
          // must not say "this exists but is a draft" — that is itself a
          // disclosure about the pipeline.
          assert.equal(err.publicMessage, "Not found");
          return true;
        },
        `status ${status} must not serialise`,
      );
    }
  });

  it("throws for every publish-blocking rights status", () => {
    for (const rightsStatus of RIGHTS_STATUSES) {
      const attempt = () =>
        serialiseContentSummary({ ...hostileContentRow, rightsStatus } as never);
      if (rightsBlocksPublishing(rightsStatus)) {
        assert.throws(attempt, `rights ${rightsStatus} must not serialise`);
      } else {
        assert.doesNotThrow(attempt, `rights ${rightsStatus} should serialise`);
      }
    }
  });

  it("throws for a soft-deleted record", () => {
    assert.throws(() =>
      serialiseContentSummary({ ...hostileContentRow, deletedAt: new Date() } as never),
    );
  });

  it("refuses a private or draft collection", () => {
    for (const [visibility, status] of [
      ["private", "active"],
      ["internal", "active"],
      ["public", "draft"],
      ["public", "archived"],
    ] as const) {
      assert.throws(
        () =>
          serialiseCollection({
            id: "c1",
            name: "n",
            slug: "s",
            description: null,
            itemCount: 0,
            visibility,
            status,
            deletedAt: null,
          } as never),
        `${visibility}/${status} must not serialise`,
      );
    }
  });
});

describe("findLeakedFields", () => {
  it("finds a forbidden field at any depth", () => {
    assert.deepEqual(findLeakedFields({ a: { b: { internalNotes: "x" } } }), ["$.a.b.internalNotes"]);
    assert.deepEqual(findLeakedFields({ items: [{ storageKey: "x" }] }), ["$.items[0].storageKey"]);
    assert.deepEqual(findLeakedFields({ ok: 1, nested: { fine: true } }), []);
  });

  it("covers the documented forbidden list", () => {
    // Every name in NEVER_PUBLIC_FIELDS must actually be detected, so the list
    // and the detector cannot drift.
    for (const field of NEVER_PUBLIC_FIELDS) {
      assert.deepEqual(
        findLeakedFields({ [field]: "x" }),
        [`$.${field}`],
        `${field} should be detected`,
      );
    }
  });

  it("does not recurse forever on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { safe: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => findLeakedFields(cyclic));
  });
});
