/**
 * Permission checks (§20).
 *
 * Call sites ask `can(actor, "content.publish")`, never `actor.role === "admin"`.
 * That indirection is the whole reason the role matrix is extensible: adding a
 * role or moving a capability between roles touches `ROLE_PERMISSIONS` and
 * nothing else.
 *
 * `requirePermission` throws an `AppError` with a 403 status, which the API
 * error handler turns into a response and the CMS turns into a message. It is
 * the only way a permission failure should ever be raised, so that a missing
 * check is a missing throw rather than a silently permissive branch.
 */
import { AppError, ErrorCode, forbidden, unauthenticated } from "@uxd/shared";
import {
  type Permission,
  type Role,
  PERMISSION_META,
  ROLE_META,
  roleHasPermission,
} from "@uxd/types";

/** The authenticated principal behind a request. */
export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
}

/**
 * A non-user principal: the capture worker, or a scheduled task.
 *
 * Deliberately not an `Actor` and deliberately not given a `Role`. The worker
 * reaches only `/api/internal/*`, whose handlers check `scopes`, so there is no
 * code path where worker credentials could satisfy a CMS permission check.
 */
export interface ServiceActor {
  readonly kind: "worker" | "system";
  readonly name: string;
  readonly tokenId?: string;
  readonly scopes: readonly string[];
}

export type Principal = Actor | ServiceActor;

export function isUserActor(principal: Principal | null | undefined): principal is Actor {
  return principal !== null && principal !== undefined && "role" in principal;
}

/**
 * Does this actor hold this permission?
 *
 * Fails closed for anything that is not a recognised user actor: no actor, a
 * service principal (which carries scopes, not a role), or a row whose role
 * string this deployment does not know. There is no input to this function that
 * produces a throw, because a permission check that can throw is a permission
 * check that can be turned into a 500 by hostile input.
 */
export function can(actor: Actor | null | undefined, permission: Permission): boolean {
  if (!isUserActor(actor)) return false;
  return roleHasPermission(actor.role, permission);
}

/** True only if the actor holds every listed permission. */
export function canAll(actor: Actor | null | undefined, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(actor, p));
}

/** True if the actor holds at least one of the listed permissions. */
export function canAny(actor: Actor | null | undefined, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(actor, p));
}

/**
 * Assert a permission, or throw.
 *
 * Distinguishes 401 from 403 on purpose: an unauthenticated request should be
 * sent to sign in, while an authenticated one that lacks the capability should
 * be told what it needs.
 */
export function requirePermission(
  actor: Actor | null | undefined,
  permission: Permission,
): asserts actor is Actor {
  if (!isUserActor(actor)) throw unauthenticated();
  if (!can(actor, permission)) {
    const roleLabel = ROLE_META[actor.role]?.label ?? actor.role;
    throw forbidden(
      `Your role (${roleLabel}) cannot ${PERMISSION_META[permission].label.toLowerCase()}.`,
      {
        detail: `missing permission ${permission}`,
        context: { actorId: actor.id, role: actor.role, permission },
      },
    );
  }
}

export function requireAllPermissions(
  actor: Actor | null | undefined,
  permissions: readonly Permission[],
): asserts actor is Actor {
  for (const permission of permissions) requirePermission(actor, permission);
}

/** Assert a service principal holds a scope. Used by `/api/internal/*`. */
export function requireScope(principal: ServiceActor, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw new AppError(ErrorCode.FORBIDDEN, "This credential is not permitted to do that", {
      detail: `missing scope ${scope}`,
      context: { worker: principal.name, scope },
    });
  }
}

/**
 * The capability set sent to the browser.
 *
 * The CMS uses this to hide actions the current user cannot perform. It is a
 * *convenience*, not a control: every one of these is re-checked server side by
 * `requirePermission` before anything happens. Hiding a button is UI polish;
 * the check on the write path is the security boundary.
 */
export function capabilityMap(actor: Actor): Record<Permission, boolean> {
  const out = {} as Record<Permission, boolean>;
  for (const permission of Object.keys(PERMISSION_META) as Permission[]) {
    out[permission] = roleHasPermission(actor.role, permission);
  }
  return out;
}
