/**
 * Roles and permissions (§20).
 *
 * Five fixed roles, each mapped to an explicit set of capabilities. There is no
 * inheritance, no role hierarchy, no per-record ACL and no permission
 * expressions — §20 asks to keep it simple and extensible, and a flat matrix is
 * both. Every capability a role has is written down in `ROLE_PERMISSIONS`, so
 * answering "can a Researcher publish?" means reading one array.
 *
 * Extending later means either adding a capability (and deciding, visibly,
 * which roles get it) or adding a role. Neither requires touching call sites,
 * because call sites ask `can(user, "content.publish")` rather than
 * `user.role === "admin"`.
 */

export const ROLES = ["admin", "editor", "reviewer", "researcher", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Content
  "content.read",
  "content.create",
  "content.update",
  "content.delete",
  "content.discard_own",
  "content.approve",
  "content.reject",
  "content.publish",
  "content.unpublish",
  "content.archive",
  "content.recapture",
  "content.merge",
  "content.notes",

  // Sources
  "source.read",
  "source.create",
  "source.update",
  "source.delete",
  "source.flag",

  // Media
  "media.read",
  "media.upload",
  "media.update",
  "media.replace",
  "media.archive",
  "media.delete",

  // Taxonomy
  "taxonomy.read",
  "taxonomy.create",
  "taxonomy.update",
  "taxonomy.archive",
  "taxonomy.assign",

  // Ingestion and crawl jobs
  "ingestion.read",
  "ingestion.create",
  "ingestion.control",
  "ingestion.retry",
  "ingestion.override_robots",

  // Review
  "review.read",
  "review.assign",
  "review.decide",

  // Collections
  "collection.read",
  "collection.create",
  "collection.update",
  "collection.delete",
  "collection.publish",

  // Classification
  "classification.read",
  "classification.request",
  "classification.review",

  // Rights
  "rights.read",
  "rights.update",

  // Administration
  "settings.read",
  "settings.update",
  "audit.read",
  "users.read",
  "users.manage",
  "worker.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionMeta {
  readonly label: string;
  readonly group: string;
  /** Irreversible or outward-facing. The CMS confirms before performing these. */
  readonly destructive?: boolean;
}

export const PERMISSION_META: Record<Permission, PermissionMeta> = {
  "content.read": { label: "View content", group: "Content" },
  "content.create": { label: "Create content", group: "Content" },
  "content.update": { label: "Edit content", group: "Content" },
  "content.delete": { label: "Delete content", group: "Content", destructive: true },
  "content.discard_own": {
    label: "Discard your own unpublished captures",
    group: "Content",
  },
  "content.approve": { label: "Approve content", group: "Content" },
  "content.reject": { label: "Reject content", group: "Content" },
  "content.publish": { label: "Publish content", group: "Content", destructive: true },
  "content.unpublish": { label: "Unpublish content", group: "Content", destructive: true },
  "content.archive": { label: "Archive content", group: "Content" },
  "content.recapture": { label: "Trigger recapture", group: "Content" },
  "content.merge": { label: "Merge duplicates", group: "Content", destructive: true },
  "content.notes": { label: "Write internal notes", group: "Content" },

  "source.read": { label: "View sources", group: "Sources" },
  "source.create": { label: "Create sources", group: "Sources" },
  "source.update": { label: "Edit sources", group: "Sources" },
  "source.delete": { label: "Delete sources", group: "Sources", destructive: true },
  "source.flag": { label: "Flag a source", group: "Sources" },

  "media.read": { label: "View media", group: "Media" },
  "media.upload": { label: "Upload media", group: "Media" },
  "media.update": { label: "Edit media metadata", group: "Media" },
  "media.replace": { label: "Replace media files", group: "Media", destructive: true },
  "media.archive": { label: "Archive media", group: "Media" },
  "media.delete": { label: "Delete media", group: "Media", destructive: true },

  "taxonomy.read": { label: "View taxonomy", group: "Taxonomy" },
  "taxonomy.create": { label: "Create terms", group: "Taxonomy" },
  "taxonomy.update": { label: "Edit terms", group: "Taxonomy" },
  "taxonomy.archive": { label: "Archive terms", group: "Taxonomy" },
  "taxonomy.assign": { label: "Classify content", group: "Taxonomy" },

  "ingestion.read": { label: "View crawl jobs", group: "Ingestion" },
  "ingestion.create": { label: "Create crawl jobs", group: "Ingestion" },
  "ingestion.control": { label: "Pause, resume and cancel jobs", group: "Ingestion" },
  "ingestion.retry": { label: "Retry failed items", group: "Ingestion" },
  "ingestion.override_robots": {
    label: "Override robots.txt",
    group: "Ingestion",
    destructive: true,
  },

  "review.read": { label: "View the review queue", group: "Review" },
  "review.assign": { label: "Assign reviewers", group: "Review" },
  "review.decide": { label: "Approve or reject in review", group: "Review" },

  "collection.read": { label: "View collections", group: "Collections" },
  "collection.create": { label: "Create collections", group: "Collections" },
  "collection.update": { label: "Edit collections", group: "Collections" },
  "collection.delete": { label: "Delete collections", group: "Collections", destructive: true },
  "collection.publish": { label: "Publish collections", group: "Collections", destructive: true },

  "classification.read": { label: "View classification suggestions", group: "Classification" },
  "classification.request": { label: "Request classification", group: "Classification" },
  "classification.review": { label: "Accept or reject suggestions", group: "Classification" },

  "rights.read": { label: "View rights information", group: "Rights" },
  "rights.update": { label: "Edit rights information", group: "Rights" },

  "settings.read": { label: "View settings", group: "Administration" },
  "settings.update": { label: "Change settings", group: "Administration", destructive: true },
  "audit.read": { label: "Read the audit log", group: "Administration" },
  "users.read": { label: "View users", group: "Administration" },
  "users.manage": { label: "Manage users and roles", group: "Administration", destructive: true },
  "worker.manage": { label: "Manage capture workers", group: "Administration", destructive: true },
};

/** Everything a Viewer can do: read, and nothing else. */
const VIEWER: readonly Permission[] = [
  "content.read",
  "source.read",
  "media.read",
  "taxonomy.read",
  "ingestion.read",
  "review.read",
  "collection.read",
  "classification.read",
  "rights.read",
];

/**
 * Researcher: runs ingestion and works on content, but does not decide what
 * goes public. Note the absence of `content.publish` and `review.decide` —
 * the person who captured something is not the person who signs it off.
 */
const RESEARCHER: readonly Permission[] = [
  ...VIEWER,
  "content.create",
  "content.update",
  // A bad capture is the researcher's to throw away — but only their own, and
  // only before it has ever been public. Anything else is a delete.
  "content.discard_own",
  "content.notes",
  "content.recapture",
  "source.create",
  "source.update",
  "source.flag",
  "media.upload",
  "media.update",
  "taxonomy.assign",
  "ingestion.create",
  "ingestion.control",
  "ingestion.retry",
  "collection.create",
  "collection.update",
  "classification.request",
];

/** Editor: content, taxonomy and media, including deletes. Not publishing. */
const EDITOR: readonly Permission[] = [
  ...RESEARCHER,
  "content.archive",
  "content.merge",
  "media.replace",
  "media.archive",
  "taxonomy.create",
  "taxonomy.update",
  "taxonomy.archive",
  "collection.delete",
  "classification.review",
  "rights.update",
];

/** Reviewer: the review queue, metadata corrections, and publishing. */
const REVIEWER: readonly Permission[] = [
  ...VIEWER,
  "content.update",
  "content.notes",
  "content.approve",
  "content.reject",
  "content.publish",
  "content.unpublish",
  "content.archive",
  "content.recapture",
  "content.merge",
  "media.update",
  "media.archive",
  "taxonomy.assign",
  "review.assign",
  "review.decide",
  "classification.review",
  "rights.update",
  "collection.update",
  "collection.publish",
  "source.flag",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  editor: [...new Set(EDITOR)],
  reviewer: [...new Set(REVIEWER)],
  researcher: [...new Set(RESEARCHER)],
  viewer: [...new Set(VIEWER)],
};

export interface RoleMeta {
  readonly label: string;
  readonly description: string;
  /** One-line summary shown next to the role picker. */
  readonly summary: string;
}

export const ROLE_META: Record<Role, RoleMeta> = {
  admin: {
    label: "Admin",
    description:
      "Full access, including settings, users, workers and the audit log. Keep this to the smallest possible group.",
    summary: "Everything",
  },
  editor: {
    label: "Editor",
    description:
      "Owns the content, taxonomy and media libraries. Can create, edit, organise and archive, but cannot publish.",
    summary: "Content, taxonomy and media",
  },
  reviewer: {
    label: "Reviewer",
    description:
      "Works the review queue: approves, rejects, corrects metadata and publishes. The only non-admin role that can make content public.",
    summary: "Review, correct and publish",
  },
  researcher: {
    label: "Researcher",
    description:
      "Runs ingestion and builds up the library: submits URLs, drives crawl jobs, creates content and writes notes. Cannot publish.",
    summary: "Ingestion, content and notes",
  },
  viewer: {
    label: "Viewer",
    description: "Read-only access to the CMS. Cannot change anything.",
    summary: "Read only",
  },
};

const ROLE_PERMISSION_SETS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ROLE_PERMISSIONS.admin),
  editor: new Set(ROLE_PERMISSIONS.editor),
  reviewer: new Set(ROLE_PERMISSIONS.reviewer),
  researcher: new Set(ROLE_PERMISSIONS.researcher),
  viewer: new Set(ROLE_PERMISSIONS.viewer),
};

/**
 * Does this role hold this permission?
 *
 * Fails closed on an unrecognised role rather than throwing. The input is
 * typed, but at runtime it can arrive from a database row written by an older
 * or newer deployment, or from a principal that has no role at all (the capture
 * worker). A thrown TypeError inside a permission check would surface as a 500
 * — or worse, be swallowed by a caller's try/catch and treated as "no error" —
 * whereas returning false is an unambiguous deny.
 */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSION_SETS[role]?.has(permission) ?? false;
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Roles that can make content public. Used by the publishing guard's tests. */
export const PUBLISHING_ROLES = ROLES.filter((r) => roleHasPermission(r, "content.publish"));

/**
 * The roles a person can be given from the Team page. The others still exist
 * — permissions are defined for all five — but v1 runs on two: someone who
 * captures, and someone who runs the place.
 */
export const TEAM_ROLES = ["admin", "researcher"] as const satisfies readonly Role[];
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_META: Record<TeamRole, { label: string; description: string }> = {
  admin: {
    label: "Admin",
    description: "Everything: publish, unpublish, manage tags and settings, add and remove people.",
  },
  researcher: {
    label: "Researcher",
    description: "Adds products, captures, names and tags screens, and discards their own captures. Cannot publish.",
  },
};

export const USER_STATUSES = ["invited", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
