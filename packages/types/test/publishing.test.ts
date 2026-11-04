/**
 * Publishing-gate tests (§37 "tests for publishing logic").
 *
 * The public frontend has no data source other than the public API, and the
 * public API has no row source other than records this gate admits. So these
 * tests are the guarantee behind "draft/rejected/internal content must never
 * appear in the public API" — they enumerate the full status × rights matrix
 * rather than sampling it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
  PUBLISH_BLOCKER_CODES,
  type PublishabilityInput,
  RIGHTS_STATUSES,
  type RightsStatus,
  canPublish,
  isPubliclyVisible,
  publishedContentFilter,
  rightsBlocksPublishing,
} from "@uxd/types";

const publishable = (overrides: Partial<PublishabilityInput> = {}): PublishabilityInput => ({
  status: "approved",
  rightsStatus: "unknown",
  title: "Stripe — Pricing",
  slug: "stripe-pricing",
  hasPrimaryMedia: true,
  requiresMedia: true,
  approvedAt: new Date("2026-01-01T00:00:00Z"),
  approvedBy: "3f8c6e1a-0000-7000-8000-000000000001",
  ...overrides,
});

const codes = (input: PublishabilityInput): string[] => canPublish(input).blockers.map((b) => b.code);

describe("canPublish — the approved-only rule", () => {
  it("allows a fully approved record", () => {
    const result = canPublish(publishable());
    assert.equal(result.allowed, true, JSON.stringify(result.blockers));
    assert.deepEqual(result.blockers, []);
  });

  it("refuses every status except approved", () => {
    for (const status of LIFECYCLE_STATUSES) {
      const result = canPublish(publishable({ status }));
      if (status === "approved") {
        assert.equal(result.allowed, true, "approved should pass");
        continue;
      }
      assert.equal(result.allowed, false, `${status} must not be publishable`);
      const expected =
        status === "published"
          ? PUBLISH_BLOCKER_CODES.ALREADY_PUBLISHED
          : PUBLISH_BLOCKER_CODES.NOT_APPROVED;
      assert.ok(codes(publishable({ status })).includes(expected), `${status} -> ${expected}`);
    }
  });

  it("refuses an approved record with no recorded approver", () => {
    // Guards against a status set by a script or a bad migration rather than by
    // a review decision — publishing must always be attributable.
    assert.ok(
      codes(publishable({ approvedBy: null })).includes(PUBLISH_BLOCKER_CODES.NO_APPROVAL_RECORD),
    );
    assert.ok(
      codes(publishable({ approvedAt: null })).includes(PUBLISH_BLOCKER_CODES.NO_APPROVAL_RECORD),
    );
  });
});

describe("canPublish — rights holds override approval", () => {
  it("refuses every publish-blocking rights status even when approved", () => {
    for (const rightsStatus of RIGHTS_STATUSES) {
      const result = canPublish(publishable({ rightsStatus }));
      if (rightsBlocksPublishing(rightsStatus)) {
        assert.equal(result.allowed, false, `${rightsStatus} must block publishing`);
        assert.ok(
          result.blockers.some((b) => b.code === PUBLISH_BLOCKER_CODES.RIGHTS_HOLD),
          `${rightsStatus} should report a rights hold`,
        );
      } else {
        assert.equal(result.allowed, true, `${rightsStatus} should not block a valid record`);
      }
    }
  });

  it("blocks the specific statuses the rights model marks as holds", () => {
    for (const status of ["pending_review", "restricted", "removed", "do_not_republish"] as const) {
      assert.equal(canPublish(publishable({ rightsStatus: status })).allowed, false, status);
    }
    for (const status of ["unknown", "permissioned", "licensed", "public_submission", "reference_use"] as const) {
      assert.equal(canPublish(publishable({ rightsStatus: status })).allowed, true, status);
    }
  });
});

describe("canPublish — completeness requirements", () => {
  it("requires a title", () => {
    for (const title of [null, "", "   "]) {
      assert.ok(codes(publishable({ title })).includes(PUBLISH_BLOCKER_CODES.MISSING_TITLE), JSON.stringify(title));
    }
  });

  it("requires a slug, since it is the public URL", () => {
    assert.ok(codes(publishable({ slug: null })).includes(PUBLISH_BLOCKER_CODES.MISSING_SLUG));
  });

  it("requires media only for kinds that need it", () => {
    assert.ok(
      codes(publishable({ hasPrimaryMedia: false, requiresMedia: true })).includes(
        PUBLISH_BLOCKER_CODES.MISSING_MEDIA,
      ),
    );
    // A flow or an interaction is meaningful without its own image.
    assert.equal(canPublish(publishable({ hasPrimaryMedia: false, requiresMedia: false })).allowed, true);
  });

  it("reports every blocker at once rather than stopping at the first", () => {
    // The CMS shows all of them next to the disabled Publish button, so an
    // operator fixes one record once instead of discovering problems serially.
    const result = canPublish(
      publishable({
        status: "needs_review",
        rightsStatus: "restricted",
        title: null,
        slug: null,
        hasPrimaryMedia: false,
      }),
    );
    assert.equal(result.allowed, false);
    assert.deepEqual(new Set(result.blockers.map((b) => b.code)), new Set([
      PUBLISH_BLOCKER_CODES.NOT_APPROVED,
      PUBLISH_BLOCKER_CODES.RIGHTS_HOLD,
      PUBLISH_BLOCKER_CODES.MISSING_TITLE,
      PUBLISH_BLOCKER_CODES.MISSING_SLUG,
      PUBLISH_BLOCKER_CODES.MISSING_MEDIA,
    ]));
  });

  it("attaches a field to each fixable blocker so the CMS can focus it", () => {
    const result = canPublish(publishable({ title: null, slug: null, hasPrimaryMedia: false }));
    for (const blocker of result.blockers) {
      assert.ok(blocker.field, `${blocker.code} should name a field`);
      assert.ok(blocker.message.length > 0, `${blocker.code} should explain itself`);
    }
  });
});

describe("isPubliclyVisible — the full status x rights matrix", () => {
  it("admits exactly one combination class: published + non-blocking rights", () => {
    let visibleCount = 0;
    for (const status of LIFECYCLE_STATUSES) {
      for (const rightsStatus of RIGHTS_STATUSES) {
        const visible = isPubliclyVisible({ status, rightsStatus });
        const expected = status === "published" && !rightsBlocksPublishing(rightsStatus);
        assert.equal(visible, expected, `status=${status} rights=${rightsStatus}`);
        if (visible) visibleCount += 1;
      }
    }
    // Sanity check that the matrix actually admits something, so a bug that
    // made everything invisible would not pass as "no leaks".
    const allowedRights = RIGHTS_STATUSES.filter((r) => !rightsBlocksPublishing(r)).length;
    assert.equal(visibleCount, allowedRights);
    assert.ok(visibleCount > 0);
  });

  it("hides every non-published status regardless of rights", () => {
    const nonPublished = LIFECYCLE_STATUSES.filter((s) => s !== "published");
    for (const status of nonPublished) {
      for (const rightsStatus of RIGHTS_STATUSES) {
        assert.equal(
          isPubliclyVisible({ status, rightsStatus }),
          false,
          `${status}/${rightsStatus} must never be public`,
        );
      }
    }
  });

  it("keeps drafts, rejects and internal states out", () => {
    for (const status of ["draft", "discovered", "queued", "capturing", "processed", "ai_classified", "needs_review", "approved", "rejected", "archived", "failed", "restricted", "removed"] satisfies LifecycleStatus[]) {
      assert.equal(isPubliclyVisible({ status, rightsStatus: "permissioned" }), false, status);
    }
  });
});

describe("publishedContentFilter — the SQL-level filter agrees with the code-level check", () => {
  it("names only public statuses", () => {
    const filter = publishedContentFilter();
    assert.deepEqual(filter.statuses, ["published"]);
  });

  it("excludes exactly the publish-blocking rights statuses", () => {
    const filter = publishedContentFilter();
    assert.deepEqual(
      new Set(filter.excludedRightsStatuses),
      new Set(RIGHTS_STATUSES.filter(rightsBlocksPublishing)),
    );
  });

  it("is equivalent to isPubliclyVisible for every combination", () => {
    // Defence in depth is only defence if both layers agree. This asserts the
    // WHERE clause and the application predicate select the same rows.
    const filter = publishedContentFilter();
    const statusSet = new Set<LifecycleStatus>(filter.statuses);
    const excludedSet = new Set<RightsStatus>(filter.excludedRightsStatuses);
    for (const status of LIFECYCLE_STATUSES) {
      for (const rightsStatus of RIGHTS_STATUSES) {
        const bySql = statusSet.has(status) && !excludedSet.has(rightsStatus);
        assert.equal(bySql, isPubliclyVisible({ status, rightsStatus }), `${status}/${rightsStatus}`);
      }
    }
  });
});
