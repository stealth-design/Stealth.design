/**
 * Who may throw a capture away.
 *
 * Creation and publishing are separate jobs: a researcher can capture, tag and
 * discard their own mistakes, and never touch anything that has been public.
 * These assert the rule `canDiscardScreen` applies — the same function the
 * service enforces and the product page uses to decide whether to show a ✕.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor } from "@uxd/auth";
import { canDiscardScreen } from "@uxd/api";
import { ROLES, type Role } from "@uxd/types";

const actorFor = (role: Role): Actor => ({
  id: `00000000-0000-7000-8000-00000000000${ROLES.indexOf(role)}`,
  email: `${role}@example.test`,
  name: role,
  role,
});

const OTHER = "00000000-0000-7000-8000-0000000000ff";

describe("canDiscardScreen", () => {
  it("lets a researcher discard their own unpublished capture", () => {
    const researcher = actorFor("researcher");
    assert.equal(
      canDiscardScreen(researcher, { createdBy: researcher.id, status: "needs_review", everPublished: false }),
      true,
    );
  });

  it("does not let a researcher discard someone else's capture", () => {
    assert.equal(
      canDiscardScreen(actorFor("researcher"), { createdBy: OTHER, status: "needs_review", everPublished: false }),
      false,
    );
  });

  it("never discards a published screen, whoever asks", () => {
    for (const role of ROLES) {
      const actor = actorFor(role);
      assert.equal(canDiscardScreen(actor, { createdBy: actor.id, status: "published", everPublished: true }), false, role);
    }
  });

  it("never discards a screen that was public once, even after it was unpublished", () => {
    const admin = actorFor("admin");
    assert.equal(canDiscardScreen(admin, { createdBy: admin.id, status: "approved", everPublished: true }), false);
  });

  it("lets an admin discard anyone's unpublished capture", () => {
    assert.equal(
      canDiscardScreen(actorFor("admin"), { createdBy: OTHER, status: "needs_review", everPublished: false }),
      true,
    );
  });

  it("gives viewers and reviewers nothing to discard", () => {
    for (const role of ["viewer", "reviewer"] as const) {
      const actor = actorFor(role);
      assert.equal(canDiscardScreen(actor, { createdBy: actor.id, status: "needs_review", everPublished: false }), false, role);
    }
  });
});
