/**
 * Postgres enum types.
 *
 * Every enum is built from the corresponding `as const` array in `@uxd/types`,
 * so the database, the API validators and the CMS UI cannot disagree about
 * what values exist. Adding a value means editing one array and generating a
 * migration.
 *
 * Enums are used where the set is genuinely closed and integrity matters
 * (a status, a role, a rights position). Open or fast-growing vocabularies —
 * audit action names, job event codes, error codes, device profile keys — are
 * plain `text` validated by Zod at the boundary, because a migration per new
 * log code would be friction with no benefit.
 */
import { pgEnum } from "drizzle-orm/pg-core";
import {
  CAPTURE_METHODS,
  CAPTURE_SESSION_STATUSES,
  CAPTURE_STATUSES,
  CLASSIFICATION_ORIGINS,
  COLLECTION_STATUSES,
  COLLECTION_VISIBILITIES,
  CONTENT_KINDS,
  CONTENT_RELATION_TYPES,
  DEVICE_CLASSES,
  DISCOVERED_PAGE_STATUSES,
  INTERACTION_TYPES,
  JOB_EVENT_LEVELS,
  JOB_ITEM_STATUSES,
  JOB_STATUSES,
  LEGAL_REVIEW_STATUSES,
  LIFECYCLE_STATUSES,
  MEDIA_DERIVATIVE_KINDS,
  MEDIA_KINDS,
  MEDIA_SCAN_STATUSES,
  MEDIA_STATUSES,
  MEDIA_UPLOAD_SOURCES,
  MEDIA_USAGE_ROLES,
  MODULE_KEYS,
  PERMISSION_STATUSES,
  PLATFORMS,
  REVIEW_ASSIGNMENT_STATUSES,
  REVIEW_DECISIONS,
  REVIEW_REASONS,
  RIGHTS_STATUSES,
  ROBOTS_STATUSES,
  ROLES,
  SCREENSHOT_SCOPES,
  SESSION_COMMAND_STATUSES,
  SOURCE_HEALTH_STATUSES,
  SOURCE_TYPES,
  SUGGESTION_REVIEW_STATUSES,
  TAKEDOWN_STATUSES,
  TAXONOMY_KINDS,
  TAXONOMY_TARGETS,
  TAXONOMY_TERM_STATUSES,
  URL_VALIDATION_OUTCOMES,
  USER_STATUSES,
} from "@uxd/types";

// --- Identity and access --------------------------------------------------
export const roleEnum = pgEnum("role", ROLES);
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);

// --- Modules and content --------------------------------------------------
export const moduleEnum = pgEnum("module", MODULE_KEYS);
export const contentKindEnum = pgEnum("content_kind", CONTENT_KINDS);
export const contentRelationTypeEnum = pgEnum("content_relation_type", CONTENT_RELATION_TYPES);
export const lifecycleStatusEnum = pgEnum("lifecycle_status", LIFECYCLE_STATUSES);

// --- Rights and provenance ------------------------------------------------
export const rightsStatusEnum = pgEnum("rights_status", RIGHTS_STATUSES);
export const permissionStatusEnum = pgEnum("permission_status", PERMISSION_STATUSES);
export const takedownStatusEnum = pgEnum("takedown_status", TAKEDOWN_STATUSES);
export const legalReviewStatusEnum = pgEnum("legal_review_status", LEGAL_REVIEW_STATUSES);
export const robotsStatusEnum = pgEnum("robots_status", ROBOTS_STATUSES);

// --- Sources --------------------------------------------------------------
export const sourceTypeEnum = pgEnum("source_type", SOURCE_TYPES);
export const sourceHealthEnum = pgEnum("source_health", SOURCE_HEALTH_STATUSES);

// --- Capture --------------------------------------------------------------
export const platformEnum = pgEnum("platform", PLATFORMS);
export const deviceClassEnum = pgEnum("device_class", DEVICE_CLASSES);
export const captureMethodEnum = pgEnum("capture_method", CAPTURE_METHODS);
export const captureStatusEnum = pgEnum("capture_status", CAPTURE_STATUSES);
export const interactionTypeEnum = pgEnum("interaction_type", INTERACTION_TYPES);
export const screenshotScopeEnum = pgEnum("screenshot_scope", SCREENSHOT_SCOPES);

// --- Discovery and the capture studio -------------------------------------
export const discoveredPageStatusEnum = pgEnum("discovered_page_status", DISCOVERED_PAGE_STATUSES);
export const captureSessionStatusEnum = pgEnum("capture_session_status", CAPTURE_SESSION_STATUSES);
export const sessionCommandStatusEnum = pgEnum("session_command_status", SESSION_COMMAND_STATUSES);

// --- Media ----------------------------------------------------------------
export const mediaKindEnum = pgEnum("media_kind", MEDIA_KINDS);
export const mediaStatusEnum = pgEnum("media_status", MEDIA_STATUSES);
export const mediaUsageRoleEnum = pgEnum("media_usage_role", MEDIA_USAGE_ROLES);
export const mediaUploadSourceEnum = pgEnum("media_upload_source", MEDIA_UPLOAD_SOURCES);
export const mediaScanStatusEnum = pgEnum("media_scan_status", MEDIA_SCAN_STATUSES);
export const mediaDerivativeKindEnum = pgEnum("media_derivative_kind", MEDIA_DERIVATIVE_KINDS);

// --- Taxonomy and classification -----------------------------------------
export const taxonomyKindEnum = pgEnum("taxonomy_kind", TAXONOMY_KINDS);
export const taxonomyTargetEnum = pgEnum("taxonomy_target", TAXONOMY_TARGETS);
export const taxonomyTermStatusEnum = pgEnum("taxonomy_term_status", TAXONOMY_TERM_STATUSES);
export const classificationOriginEnum = pgEnum("classification_origin", CLASSIFICATION_ORIGINS);
export const suggestionReviewStatusEnum = pgEnum("suggestion_review_status", SUGGESTION_REVIEW_STATUSES);

// --- Jobs -----------------------------------------------------------------
export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);
export const jobItemStatusEnum = pgEnum("job_item_status", JOB_ITEM_STATUSES);
export const jobPriorityEnum = pgEnum("job_priority", ["low", "normal", "high"] as const);
export const jobEventLevelEnum = pgEnum("job_event_level", JOB_EVENT_LEVELS);
export const urlValidationOutcomeEnum = pgEnum("url_validation_outcome", URL_VALIDATION_OUTCOMES);

// --- Review ---------------------------------------------------------------
export const reviewAssignmentStatusEnum = pgEnum("review_assignment_status", REVIEW_ASSIGNMENT_STATUSES);
export const reviewDecisionEnum = pgEnum("review_decision", REVIEW_DECISIONS);
export const reviewReasonEnum = pgEnum("review_reason", REVIEW_REASONS);

// --- Collections ----------------------------------------------------------
export const collectionVisibilityEnum = pgEnum("collection_visibility", COLLECTION_VISIBILITIES);
export const collectionStatusEnum = pgEnum("collection_status", COLLECTION_STATUSES);

// --- Audit ----------------------------------------------------------------
export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "worker", "system"] as const);
export const auditEntityTypeEnum = pgEnum("audit_entity_type", [
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
] as const);
