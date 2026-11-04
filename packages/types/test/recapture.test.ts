/**
 * Re-capture status tests (§12, §15).
 *
 * These exist because the bug they guard against is silent. A re-capture that
 * reset `needs_review` to a pipeline state would take items *out* of the review
 * queue while leaving their open review rows behind: the backlog count falls,
 * the work is still outstanding, and nothing reports an error. It was found by
 * running a real re-capture and reading the resulting row, not by a type error.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIFECYCLE_STATUSES,
  LIFECYCLE_STATUS_META,
  RECAPTURE_ADVANCEABLE_STATUSES,
  type LifecycleStatus,
  statusAfterRecapture,
} from "@uxd/types";

describe("statusAfterRecapture — a capture never overwrites a human decision", () => {
  it("advances a successful capture of a pre-review record to processed", () => {
    for (const status of RECAPTURE_ADVANCEABLE_STATUSES) {
      assert.equal(statusAfterRecapture(status, true), "processed", status);
    }
  });

  it("marks a failed capture of a pre-review record as failed", () => {
    for (const status of RECAPTURE_ADVANCEABLE_STATUSES) {
      assert.equal(statusAfterRecapture(status, false), "failed", status);
    }
  });

  it("PRESERVES every status a person owns", () => {
    // The regression: `needs_review` in particular must survive, or a nightly
    // refresh empties the review queue without saying so.
    const humanOwned: LifecycleStatus[] = [
      "needs_review",
      "approved",
      "published",
      "rejected",
      "archived",
      "restricted",
      "removed",
    ];
    for (const status of humanOwned) {
      assert.equal(statusAfterRecapture(status, true), status, `${status} after success`);
      assert.equal(statusAfterRecapture(status, false), status, `${status} after failure`);
    }
  });

  it("keeps published content published through a re-capture", () => {
    // Otherwise a refresh would pull live content off the public site.
    assert.equal(statusAfterRecapture("published", true), "published");
    assert.equal(statusAfterRecapture("published", false), "published");
  });

  it("never silently discards a rights hold", () => {
    assert.equal(statusAfterRecapture("restricted", true), "restricted");
    assert.equal(statusAfterRecapture("removed", true), "removed");
  });

  it("partitions the status set exactly — every status is handled", () => {
    // No status may be missing from both sides of the rule, which is what
    // would happen if a new status were added and this list forgotten.
    for (const status of LIFECYCLE_STATUSES) {
      const advanceable = RECAPTURE_ADVANCEABLE_STATUSES.includes(status);
      const result = statusAfterRecapture(status, true);
      if (advanceable) {
        assert.equal(result, "processed", `${status} should advance`);
      } else {
        assert.equal(result, status, `${status} should be preserved`);
      }
    }
  });

  it("treats exactly the non-public, non-review statuses as advanceable", () => {
    // A cross-check against the status metadata: nothing advanceable may be
    // public, and nothing advanceable may be a review-or-later state.
    for (const status of RECAPTURE_ADVANCEABLE_STATUSES) {
      assert.equal(
        LIFECYCLE_STATUS_META[status].isPublic,
        false,
        `${status} is public and must not be advanceable`,
      );
      assert.notEqual(
        LIFECYCLE_STATUS_META[status].group,
        "review",
        `${status} is a review state and must not be advanceable`,
      );
      assert.notEqual(
        LIFECYCLE_STATUS_META[status].group,
        "live",
        `${status} is live and must not be advanceable`,
      );
    }
  });
});
