/**
 * Permission-boundary tests (§37 "tests for permission boundaries").
 *
 * These assert the *shape* of the role matrix rather than sampling it: for
 * every role and every permission, the answer `can()` gives must match
 * `ROLE_PERMISSIONS`, and the separations §20 describes must hold.
 *
 * The most important assertions here are the negative ones. Publishing is the
 * only irreversible, outward-facing action in the CMS, and the matrix must keep
 * it away from the roles that capture content.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Actor,
  type ServiceActor,
  can,
  canAll,
  canAny,
  capabilityMap,
  isUserActor,
  requirePermission,
  requireScope,
} from "@uxd/auth";
import {
  PERMISSIONS,
  type Permission,
  ROLES,
  ROLE_PERMISSIONS,
  type Role,
  roleHasPermission,
} from "@uxd/types";

const actorFor = (role: Role): Actor => ({
  id: `00000000-0000-7000-8000-00000000000${ROLES.indexOf(role)}`,
  email: `${role}@example.test`,
  name: role,
  role,
});

const worker: ServiceActor = { kind: "worker", name: "w1", scopes: ["capture"] };

describe("can() agrees with the declared matrix for every role and permission", () => {
  it("covers all roles x all permissions", () => {
    let checks = 0;
    for (const role of ROLES) {
      const actor = actorFor(role);
      for (const permission of PERMISSIONS) {
        assert.equal(
          can(actor, permission),
          roleHasPermission(role, permission),
          `${role} / ${permission}`,
        );
        checks += 1;
      }
    }
    assert.equal(checks, ROLES.length * PERMISSIONS.length);
    assert.ok(checks > 250, "the matrix should be substantial");
  });

  it("denies everything to an absent actor", () => {
    for (const permission of PERMISSIONS) {
      assert.equal(can(null, permission), false, permission);
      assert.equal(can(undefined, permission), false, permission);
    }
  });
});

describe("role separations required by §20", () => {
  it("gives admin every permission", () => {
    const admin = actorFor("admin");
    for (const permission of PERMISSIONS) {
      assert.equal(can(admin, permission), true, `admin should have ${permission}`);
    }
  });

  it("makes viewer strictly read-only", () => {
    const viewer = actorFor("viewer");
    const writePermissions = PERMISSIONS.filter((p) => !p.endsWith(".read"));
    for (const permission of writePermissions) {
      assert.equal(can(viewer, permission), false, `viewer must not have ${permission}`);
    }
    // ...and it can still read.
    assert.ok(canAll(viewer, ["content.read", "media.read", "source.read", "taxonomy.read"]));
  });

  it("keeps publishing away from the roles that capture content", () => {
    // The person who ingested a page is not the person who signs it off.
    assert.equal(can(actorFor("researcher"), "content.publish"), false);
    assert.equal(can(actorFor("editor"), "content.publish"), false);
    assert.equal(can(actorFor("viewer"), "content.publish"), false);
    // Only reviewer and admin can.
    assert.equal(can(actorFor("reviewer"), "content.publish"), true);
    assert.equal(can(actorFor("admin"), "content.publish"), true);
  });

  it("keeps review decisions away from researchers and editors", () => {
    for (const role of ["researcher", "editor", "viewer"] as const) {
      assert.equal(can(actorFor(role), "review.decide"), false, role);
      assert.equal(can(actorFor(role), "content.approve"), false, role);
    }
  });

  it("keeps administration to admins alone", () => {
    const adminOnly: Permission[] = [
      "settings.update",
      "users.manage",
      "worker.manage",
      "audit.read",
      "content.delete",
      "media.delete",
      "source.delete",
    ];
    for (const role of ROLES) {
      if (role === "admin") continue;
      for (const permission of adminOnly) {
        assert.equal(can(actorFor(role), permission), false, `${role} must not have ${permission}`);
      }
    }
  });

  it("lets only researchers, editors and admins start ingestion", () => {
    assert.equal(can(actorFor("researcher"), "ingestion.create"), true);
    assert.equal(can(actorFor("editor"), "ingestion.create"), true);
    assert.equal(can(actorFor("reviewer"), "ingestion.create"), false);
    assert.equal(can(actorFor("viewer"), "ingestion.create"), false);
  });

  it("restricts overriding robots.txt to admins", () => {
    for (const role of ROLES) {
      assert.equal(
        can(actorFor(role), "ingestion.override_robots"),
        role === "admin",
        `${role} / ingestion.override_robots`,
      );
    }
  });

  it("gives editors the taxonomy vocabulary and others only assignment", () => {
    assert.equal(can(actorFor("editor"), "taxonomy.create"), true);
    assert.equal(can(actorFor("researcher"), "taxonomy.create"), false);
    assert.equal(can(actorFor("researcher"), "taxonomy.assign"), true);
    assert.equal(can(actorFor("reviewer"), "taxonomy.assign"), true);
    assert.equal(can(actorFor("viewer"), "taxonomy.assign"), false);
  });
});

describe("requirePermission", () => {
  it("throws 401 when nobody is signed in", () => {
    assert.throws(
      () => requirePermission(null, "content.read"),
      (e: unknown) => (e as { status: number; code: string }).status === 401,
    );
  });

  it("throws 403 when signed in without the capability", () => {
    assert.throws(
      () => requirePermission(actorFor("viewer"), "content.publish"),
      (e: unknown) => {
        const err = e as { status: number; code: string; publicMessage: string };
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        // The message should name the role and the action, so the operator
        // knows what to ask for rather than just seeing "forbidden".
        assert.match(err.publicMessage, /Viewer/);
        assert.match(err.publicMessage, /publish/i);
        return true;
      },
    );
  });

  it("does not throw when the capability is held", () => {
    assert.doesNotThrow(() => requirePermission(actorFor("reviewer"), "content.publish"));
  });

  it("does not leak the internal permission string in the public message", () => {
    try {
      requirePermission(actorFor("viewer"), "settings.update");
      assert.fail("should have thrown");
    } catch (e) {
      const err = e as { publicMessage: string; detail?: string };
      assert.doesNotMatch(err.publicMessage, /settings\.update/);
      // ...but an operator reading logs still gets the precise reason.
      assert.match(err.detail ?? "", /settings\.update/);
    }
  });
});

describe("service principals are not user actors", () => {
  it("a worker credential cannot satisfy any CMS permission", () => {
    assert.equal(isUserActor(worker), false);
    // The type system prevents passing a ServiceActor to can(); this asserts
    // the runtime guard agrees, which is what the API middleware relies on.
    for (const permission of PERMISSIONS) {
      assert.equal(can(worker as unknown as Actor, permission), false, permission);
    }
  });

  it("recognises a user actor", () => {
    assert.equal(isUserActor(actorFor("admin")), true);
    assert.equal(isUserActor(null), false);
  });

  it("enforces worker scopes", () => {
    assert.doesNotThrow(() => requireScope(worker, "capture"));
    assert.throws(
      () => requireScope(worker, "admin"),
      (e: unknown) => (e as { status: number }).status === 403,
    );
  });
});

describe("canAny / canAll", () => {
  it("canAll requires every permission", () => {
    const reviewer = actorFor("reviewer");
    assert.equal(canAll(reviewer, ["content.read", "content.publish"]), true);
    assert.equal(canAll(reviewer, ["content.publish", "settings.update"]), false);
  });

  it("canAny requires one", () => {
    const researcher = actorFor("researcher");
    assert.equal(canAny(researcher, ["content.publish", "ingestion.create"]), true);
    assert.equal(canAny(researcher, ["content.publish", "settings.update"]), false);
  });

  it("returns false for an empty actor regardless of list", () => {
    assert.equal(canAll(null, ["content.read"]), false);
    assert.equal(canAny(null, ["content.read"]), false);
  });
});

describe("capabilityMap sent to the browser", () => {
  it("mirrors the matrix exactly and lists every permission", () => {
    for (const role of ROLES) {
      const map = capabilityMap(actorFor(role));
      assert.equal(Object.keys(map).length, PERMISSIONS.length, `${role} map size`);
      for (const permission of PERMISSIONS) {
        assert.equal(map[permission], roleHasPermission(role, permission), `${role}/${permission}`);
      }
    }
  });

  it("never reports a capability the role lacks", () => {
    const map = capabilityMap(actorFor("viewer"));
    const granted = Object.entries(map).filter(([, v]) => v).map(([k]) => k);
    assert.deepEqual(new Set(granted), new Set(ROLE_PERMISSIONS.viewer));
  });
});
