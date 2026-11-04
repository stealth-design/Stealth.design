/**
 * Audit log (§21).
 *
 * A closed catalogue of auditable actions, each with the entity type it applies
 * to, a human sentence template, and whether a before/after snapshot is worth
 * storing. Closing the set is what makes the audit log filterable and makes it
 * obvious, at review time, when a new mutation forgot to record itself.
 */

export const AUDIT_ENTITY_TYPES = [
  "content",
  "source",
  "media",
  "taxonomy_term",
  "taxonomy_assignment",
  "crawl_job",
  "crawl_job_item",
  "capture",
  "discovered_page",
  "capture_session",
  "flow",
  "collection",
  "review",
  "classification",
  "user",
  "session",
  "setting",
  "worker",
  "system",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTOR_TYPES = ["user", "worker", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditActionMeta {
  readonly entity: AuditEntityType;
  readonly label: string;
  /** Store a before/after snapshot of the changed fields. */
  readonly snapshot: boolean;
  /** Highlighted in the audit log as consequential. */
  readonly significant: boolean;
}

export const AUDIT_ACTIONS = {
  // --- Discovery and the capture studio -----------------------------------
  // Triage is deliberately `significant: false`: it happens in bulk, hundreds
  // of candidates at a time, and flagging every one as significant would bury
  // the decisions that actually matter — approving and publishing — in noise.
  // Capturing a Screen is significant, because that is the moment a person
  // added something to the library.
  "discovered_page.added": {
    entity: "discovered_page",
    label: "added a page to the discovery queue",
    snapshot: false,
    significant: false,
  },
  "discovered_page.ignored": {
    entity: "discovered_page",
    label: "set discovered pages aside",
    snapshot: false,
    significant: false,
  },
  "discovered_page.restored": {
    entity: "discovered_page",
    label: "returned discovered pages to the queue",
    snapshot: false,
    significant: false,
  },
  "capture_session.opened": {
    entity: "capture_session",
    label: "opened a capture session",
    snapshot: false,
    significant: false,
  },
  "capture_session.closed": {
    entity: "capture_session",
    label: "closed a capture session",
    snapshot: false,
    significant: false,
  },
  "screen.captured": {
    entity: "content",
    label: "captured a screen",
    snapshot: false,
    significant: true,
  },
  "flow.created": { entity: "flow", label: "created a flow", snapshot: false, significant: false },
  "flow.updated": { entity: "flow", label: "edited a flow", snapshot: true, significant: false },
  "flow.steps_changed": {
    entity: "flow",
    label: "changed a flow's steps",
    snapshot: true,
    significant: false,
  },

  "content.created": { entity: "content", label: "created content", snapshot: false, significant: false },
  "content.updated": { entity: "content", label: "edited content", snapshot: true, significant: false },
  "content.deleted": { entity: "content", label: "deleted content", snapshot: true, significant: true },
  "content.status_changed": {
    entity: "content",
    label: "changed content status",
    snapshot: true,
    significant: false,
  },
  "content.approved": { entity: "content", label: "approved content", snapshot: false, significant: true },
  "content.rejected": { entity: "content", label: "rejected content", snapshot: true, significant: true },
  "content.published": { entity: "content", label: "published content", snapshot: false, significant: true },
  "content.unpublished": {
    entity: "content",
    label: "unpublished content",
    snapshot: false,
    significant: true,
  },
  "content.featured": { entity: "content", label: "featured", snapshot: false, significant: false },
  "content.unfeatured": { entity: "content", label: "stopped featuring", snapshot: false, significant: false },
  "content.archived": { entity: "content", label: "archived content", snapshot: false, significant: false },
  "content.merged": { entity: "content", label: "merged duplicate content", snapshot: true, significant: true },
  "content.recapture_requested": {
    entity: "content",
    label: "requested a recapture",
    snapshot: false,
    significant: false,
  },
  "content.version_created": {
    entity: "content",
    label: "recorded a new version",
    snapshot: false,
    significant: false,
  },
  "content.rights_changed": {
    entity: "content",
    label: "changed rights information",
    snapshot: true,
    significant: true,
  },

  "source.created": { entity: "source", label: "created a source", snapshot: false, significant: false },
  "source.updated": { entity: "source", label: "edited a source", snapshot: true, significant: false },
  "source.merged": { entity: "source", label: "merged a duplicate product", snapshot: true, significant: true },
  "source.deleted": { entity: "source", label: "deleted a source", snapshot: true, significant: true },
  "source.flagged": { entity: "source", label: "flagged a source", snapshot: false, significant: true },
  "source.taken_down": { entity: "source", label: "took a website down", snapshot: false, significant: true },
  "source.restored": { entity: "source", label: "allowed a website to be captured again", snapshot: false, significant: true },
  "source.rights_changed": {
    entity: "source",
    label: "changed a source's rights position",
    snapshot: true,
    significant: true,
  },
  "source.health_changed": {
    entity: "source",
    label: "source health changed",
    snapshot: true,
    significant: false,
  },

  "media.uploaded": { entity: "media", label: "uploaded media", snapshot: false, significant: false },
  "media.updated": { entity: "media", label: "edited media metadata", snapshot: true, significant: false },
  "media.replaced": { entity: "media", label: "replaced a media file", snapshot: true, significant: true },
  "media.archived": { entity: "media", label: "archived media", snapshot: false, significant: false },
  "media.deleted": { entity: "media", label: "deleted media", snapshot: true, significant: true },
  "media.quarantined": {
    entity: "media",
    label: "quarantined an upload",
    snapshot: true,
    significant: true,
  },
  "media.dedupe_reused": {
    entity: "media",
    label: "reused an identical existing file",
    snapshot: false,
    significant: false,
  },

  "taxonomy.created": { entity: "taxonomy_term", label: "created a term", snapshot: false, significant: false },
  "taxonomy.updated": { entity: "taxonomy_term", label: "edited a term", snapshot: true, significant: false },
  "taxonomy.archived": { entity: "taxonomy_term", label: "archived a term", snapshot: false, significant: false },
  "taxonomy.deleted": { entity: "taxonomy_term", label: "deleted a tag", snapshot: true, significant: true },
  "taxonomy.merged": { entity: "taxonomy_term", label: "merged terms", snapshot: true, significant: true },
  "taxonomy.assigned": {
    entity: "taxonomy_assignment",
    label: "classified content",
    snapshot: false,
    significant: false,
  },
  "taxonomy.unassigned": {
    entity: "taxonomy_assignment",
    label: "removed a classification",
    snapshot: true,
    significant: false,
  },

  "crawl.job_created": { entity: "crawl_job", label: "created a crawl job", snapshot: false, significant: false },
  "crawl.job_started": { entity: "crawl_job", label: "started a crawl job", snapshot: false, significant: true },
  "crawl.job_paused": { entity: "crawl_job", label: "paused a crawl job", snapshot: false, significant: false },
  "crawl.job_resumed": { entity: "crawl_job", label: "resumed a crawl job", snapshot: false, significant: false },
  "crawl.job_cancelled": {
    entity: "crawl_job",
    label: "cancelled a crawl job",
    snapshot: false,
    significant: true,
  },
  "crawl.job_failed": { entity: "crawl_job", label: "crawl job failed", snapshot: false, significant: true },
  "crawl.job_completed": { entity: "crawl_job", label: "crawl job finished", snapshot: false, significant: false },
  "crawl.items_retried": { entity: "crawl_job", label: "retried crawl items", snapshot: false, significant: false },
  "crawl.robots_overridden": {
    entity: "crawl_job",
    label: "overrode robots.txt",
    snapshot: false,
    significant: true,
  },
  "crawl.item_blocked": {
    entity: "crawl_job_item",
    label: "a URL was blocked by a safety rule",
    snapshot: false,
    significant: true,
  },

  "review.assigned": { entity: "review", label: "assigned a reviewer", snapshot: false, significant: false },
  "review.decided": { entity: "review", label: "recorded a review decision", snapshot: false, significant: true },

  "collection.created": { entity: "collection", label: "created a collection", snapshot: false, significant: false },
  "collection.updated": { entity: "collection", label: "edited a collection", snapshot: true, significant: false },
  "collection.deleted": { entity: "collection", label: "deleted a collection", snapshot: true, significant: true },
  "collection.published": {
    entity: "collection",
    label: "published a collection",
    snapshot: false,
    significant: true,
  },

  "classification.requested": {
    entity: "classification",
    label: "requested classification",
    snapshot: false,
    significant: false,
  },
  "classification.suggested": {
    entity: "classification",
    label: "recorded model suggestions",
    snapshot: false,
    significant: false,
  },
  "classification.accepted": {
    entity: "classification",
    label: "accepted a suggestion",
    snapshot: false,
    significant: false,
  },
  "classification.modified": {
    entity: "classification",
    label: "modified a suggestion",
    snapshot: true,
    significant: false,
  },
  "classification.rejected": {
    entity: "classification",
    label: "rejected a suggestion",
    snapshot: false,
    significant: false,
  },

  "bulk.executed": { entity: "system", label: "ran a bulk operation", snapshot: true, significant: true },

  "user.created": { entity: "user", label: "created a user", snapshot: false, significant: true },
  "user.updated": { entity: "user", label: "edited a user", snapshot: true, significant: true },
  "user.role_changed": { entity: "user", label: "changed a user's role", snapshot: true, significant: true },
  "user.suspended": { entity: "user", label: "suspended a user", snapshot: false, significant: true },
  "user.password_changed": {
    entity: "user",
    label: "changed a password",
    snapshot: false,
    significant: true,
  },
  "auth.login": { entity: "session", label: "signed in", snapshot: false, significant: false },
  "auth.login_failed": { entity: "session", label: "failed to sign in", snapshot: false, significant: true },
  "auth.logout": { entity: "session", label: "signed out", snapshot: false, significant: false },

  "setting.updated": { entity: "setting", label: "changed a setting", snapshot: true, significant: true },
  "worker.registered": { entity: "worker", label: "a capture worker connected", snapshot: false, significant: false },
  "worker.token_created": { entity: "worker", label: "issued a worker token", snapshot: false, significant: true },
  "worker.token_revoked": { entity: "worker", label: "revoked a worker token", snapshot: false, significant: true },
} as const satisfies Record<string, AuditActionMeta>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_ACTION_KEYS = Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]];

export function auditActionMeta(action: AuditAction): AuditActionMeta {
  return AUDIT_ACTIONS[action];
}

export const SIGNIFICANT_AUDIT_ACTIONS = AUDIT_ACTION_KEYS.filter((a) => AUDIT_ACTIONS[a].significant);

/** Human sentence for one audit row: "Ada published content — Stripe pricing". */
export function auditSentence(actorLabel: string, action: AuditAction, entityLabel: string | null): string {
  const verb = AUDIT_ACTIONS[action].label;
  return entityLabel ? `${actorLabel} ${verb} — ${entityLabel}` : `${actorLabel} ${verb}`;
}
