CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'worker', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_entity_type" AS ENUM('content', 'source', 'media', 'taxonomy_term', 'taxonomy_assignment', 'crawl_job', 'crawl_job_item', 'capture', 'collection', 'review', 'classification', 'user', 'session', 'setting', 'worker', 'system');--> statement-breakpoint
CREATE TYPE "public"."capture_method" AS ENUM('http_fetch', 'browser_render', 'browser_interaction', 'manual_upload', 'import');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."classification_origin" AS ENUM('ai_suggested', 'human_verified', 'human_modified', 'human_added', 'imported', 'rule_based');--> statement-breakpoint
CREATE TYPE "public"."collection_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."collection_visibility" AS ENUM('private', 'internal', 'public');--> statement-breakpoint
CREATE TYPE "public"."content_kind" AS ENUM('website', 'app', 'page', 'screen', 'flow', 'state', 'interaction');--> statement-breakpoint
CREATE TYPE "public"."content_relation_type" AS ENUM('related', 'variant_of', 'responsive_equivalent', 'precedes', 'alternative_of', 'supersedes', 'references');--> statement-breakpoint
CREATE TYPE "public"."device_class" AS ENUM('desktop', 'laptop', 'tablet', 'mobile', 'tv', 'watch', 'other');--> statement-breakpoint
CREATE TYPE "public"."interaction_type" AS ENUM('hover', 'click', 'focus', 'scroll', 'dropdown', 'modal', 'accordion', 'tabs', 'carousel', 'menu', 'tooltip', 'drawer', 'form_fill', 'form_submit', 'drag', 'keyboard', 'video_play', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_event_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_item_status" AS ENUM('pending', 'leased', 'running', 'succeeded', 'failed', 'skipped_duplicate', 'skipped_limit', 'blocked', 'cancelled', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."job_priority" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('draft', 'validating', 'ready', 'queued', 'running', 'paused', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed');--> statement-breakpoint
CREATE TYPE "public"."legal_review_status" AS ENUM('not_started', 'queued', 'in_review', 'reviewed', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('draft', 'discovered', 'queued', 'capturing', 'processed', 'ai_classified', 'needs_review', 'approved', 'published', 'rejected', 'archived', 'failed', 'restricted', 'removed');--> statement-breakpoint
CREATE TYPE "public"."media_derivative_kind" AS ENUM('thumbnail', 'preview', 'large', 'poster');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'document', 'other');--> statement-breakpoint
CREATE TYPE "public"."media_scan_status" AS ENUM('pending', 'passed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('pending', 'processing', 'ready', 'failed', 'quarantined', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."media_upload_source" AS ENUM('capture', 'manual_upload', 'import', 'derived');--> statement-breakpoint
CREATE TYPE "public"."media_usage_role" AS ENUM('primary', 'screenshot_desktop', 'screenshot_mobile', 'screenshot_full_page', 'screenshot_viewport', 'og_image', 'favicon', 'html_snapshot', 'before_state', 'after_state', 'recording', 'cover', 'attachment');--> statement-breakpoint
CREATE TYPE "public"."module" AS ENUM('web', 'app', 'brand', 'graphic', 'motion', 'three_d', 'packaging', 'email', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."permission_status" AS ENUM('not_requested', 'requested', 'granted', 'declined', 'expired', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('web', 'ios', 'android', 'macos', 'windows', 'linux', 'tvos', 'watchos', 'other');--> statement-breakpoint
CREATE TYPE "public"."review_assignment_status" AS ENUM('pending', 'in_progress', 'done', 'released');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approved', 'rejected', 'changes_requested', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."review_reason" AS ENUM('new_capture', 'recapture_changed', 'low_confidence_classification', 'missing_metadata', 'duplicate_suspected', 'rights_question', 'changes_requested', 'manual');--> statement-breakpoint
CREATE TYPE "public"."rights_status" AS ENUM('unknown', 'pending_review', 'permissioned', 'licensed', 'public_submission', 'reference_use', 'restricted', 'removed', 'do_not_republish');--> statement-breakpoint
CREATE TYPE "public"."robots_status" AS ENUM('unknown', 'allowed', 'disallowed', 'partial', 'unreachable', 'overridden');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'editor', 'reviewer', 'researcher', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."screenshot_scope" AS ENUM('viewport', 'full_page', 'element');--> statement-breakpoint
CREATE TYPE "public"."source_health" AS ENUM('unknown', 'healthy', 'changed', 'needs_recapture', 'unavailable', 'blocked', 'redirected', 'requires_review', 'archived');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('website', 'app', 'hybrid', 'other');--> statement-breakpoint
CREATE TYPE "public"."suggestion_review_status" AS ENUM('pending', 'accepted', 'modified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."takedown_status" AS ENUM('none', 'received', 'in_progress', 'actioned', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_kind" AS ENUM('industry', 'page_type', 'screen_type', 'ux_pattern', 'ui_pattern', 'component', 'interaction_type', 'design_style', 'platform', 'device', 'state', 'function', 'tag');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_target" AS ENUM('content', 'source', 'media');--> statement-breakpoint
CREATE TYPE "public"."taxonomy_term_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."url_validation_outcome" AS ENUM('valid', 'invalid', 'duplicate_in_batch', 'already_in_database', 'blocked', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid,
	"content_item_id" uuid,
	"crawl_job_id" uuid,
	"crawl_job_item_id" uuid,
	"method" "capture_method" NOT NULL,
	"capture_level" smallint DEFAULT 2 NOT NULL,
	"status" "capture_status" NOT NULL,
	"requested_url" text,
	"final_url" text,
	"http_status" integer,
	"redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"viewport_width" integer,
	"viewport_height" integer,
	"device_scale_factor" integer,
	"device_profile" text,
	"device_class" "device_class",
	"full_page" boolean DEFAULT false NOT NULL,
	"browser_name" text,
	"browser_version" text,
	"user_agent" text,
	"worker_name" text,
	"page_title" text,
	"page_description" text,
	"page_width" integer,
	"page_height" integer,
	"content_hash" text,
	"layout_hash" text,
	"dom_hash" text,
	"changed" boolean,
	"changed_from_capture_id" uuid,
	"change_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"load_time_ms" integer,
	"resource_count" integer,
	"bytes_transferred" bigint,
	"screenshot_count" integer DEFAULT 0 NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"browser_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "robots_cache" (
	"origin" text PRIMARY KEY NOT NULL,
	"body" text,
	"http_status" integer,
	"fetch_failed" boolean DEFAULT false NOT NULL,
	"crawl_delay_ms" integer,
	"sitemap_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "url_registry" (
	"normalized_url_hash" text PRIMARY KEY NOT NULL,
	"normalized_url" text NOT NULL,
	"host" text NOT NULL,
	"registrable_domain" text NOT NULL,
	"resolved_url_hash" text,
	"canonical_url_hash" text,
	"source_id" uuid,
	"content_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_captured_at" timestamp with time zone,
	"capture_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_http_status" integer,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module" "module" DEFAULT 'web' NOT NULL,
	"kind" "content_kind" NOT NULL,
	"status" "lifecycle_status" DEFAULT 'draft' NOT NULL,
	"source_id" uuid,
	"experience_id" uuid,
	"parent_id" uuid,
	"title" text,
	"slug" text,
	"description" text,
	"source_url" text,
	"original_company" text,
	"original_product" text,
	"platform" "platform",
	"device_class" "device_class",
	"primary_media_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current_version" boolean DEFAULT true NOT NULL,
	"version_of_id" uuid,
	"latest_capture_id" uuid,
	"content_hash" text,
	"layout_hash" text,
	"captured_at" timestamp with time zone,
	"first_published_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"unpublished_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"published_by" uuid,
	"ai_classified_at" timestamp with time zone,
	"classification_model" text,
	"classification_confidence" real,
	"rights_status" "rights_status" DEFAULT 'unknown' NOT NULL,
	"rights_owner" text,
	"attribution" text,
	"permission_status" "permission_status" DEFAULT 'not_requested' NOT NULL,
	"takedown_status" "takedown_status" DEFAULT 'none' NOT NULL,
	"legal_review_status" "legal_review_status" DEFAULT 'not_started' NOT NULL,
	"rights_notes" text,
	"notes" text,
	"internal_notes" text,
	"review_notes" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(original_company, '') || ' ' || coalesce(original_product, '') || ' ' || coalesce(slug, '')), 'B') || setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(source_url, '')), 'C') || setweight(to_tsvector('english', coalesce(notes, '')), 'D')) STORED
);
--> statement-breakpoint
CREATE TABLE "content_relations" (
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation_type" "content_relation_type" DEFAULT 'related' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_relations_from_id_to_id_relation_type_pk" PRIMARY KEY("from_id","to_id","relation_type")
);
--> statement-breakpoint
CREATE TABLE "experience_details" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"home_url" text,
	"app_store_url" text,
	"play_store_url" text,
	"app_bundle_id" text,
	"app_version" text,
	"page_count" integer DEFAULT 0 NOT NULL,
	"screen_count" integer DEFAULT 0 NOT NULL,
	"flow_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_details" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"goal" text,
	"step_count" integer DEFAULT 0 NOT NULL,
	"entry_content_id" uuid,
	"exit_content_id" uuid,
	"observations" text
);
--> statement-breakpoint
CREATE TABLE "flow_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flow_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_details" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"interaction_type" "interaction_type" NOT NULL,
	"trigger" text,
	"selector" text,
	"before_state_id" uuid,
	"after_state_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settle_ms" integer,
	"observations" text
);
--> statement-breakpoint
CREATE TABLE "page_details" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"final_url" text,
	"final_url_hash" text,
	"canonical_url" text,
	"canonical_url_hash" text,
	"http_status" integer,
	"page_title" text,
	"meta_description" text,
	"og_title" text,
	"og_description" text,
	"og_type" text,
	"lang_attr" text,
	"h1" text,
	"word_count" integer,
	"page_width" integer,
	"page_height" integer,
	"viewport_width" integer,
	"viewport_height" integer,
	"depth" smallint DEFAULT 0 NOT NULL,
	"discovered_from_url" text
);
--> statement-breakpoint
CREATE TABLE "screen_details" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"screen_name" text,
	"deep_link" text,
	"app_version" text,
	"os_version" text,
	"acquisition" text,
	"viewport_width" integer,
	"viewport_height" integer
);
--> statement-breakpoint
CREATE TABLE "state_details" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"state_name" text NOT NULL,
	"trigger" text,
	"is_default_state" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" DEFAULT 'viewer' NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_id" uuid,
	"name" text NOT NULL,
	"hostname" text,
	"version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"items_in_flight" integer DEFAULT 0 NOT NULL,
	"items_completed" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"last_seen_at" timestamp with time zone,
	"last_ip" "inet",
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_job_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"item_id" uuid,
	"level" "job_event_level" DEFAULT 'info' NOT NULL,
	"code" text NOT NULL,
	"message" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_job_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"status" "job_item_status" DEFAULT 'pending' NOT NULL,
	"url" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"host" text NOT NULL,
	"depth" smallint DEFAULT 0 NOT NULL,
	"parent_item_id" uuid,
	"discovered_from_url" text,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_token" text,
	"leased_by" text,
	"leased_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"http_status" integer,
	"final_url" text,
	"error_code" text,
	"error_message" text,
	"result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capture_id" uuid,
	"content_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_job_urls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"raw_url" text NOT NULL,
	"normalized_url" text,
	"normalized_url_hash" text,
	"outcome" "url_validation_outcome" NOT NULL,
	"reason_code" text,
	"reason_message" text,
	"duplicate_of_url_hash" text,
	"existing_content_id" uuid,
	"included" boolean DEFAULT false NOT NULL,
	"line_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"module" "module" DEFAULT 'web' NOT NULL,
	"status" "job_status" DEFAULT 'draft' NOT NULL,
	"priority" "job_priority" DEFAULT 'normal' NOT NULL,
	"config" jsonb NOT NULL,
	"source_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"duration_ms" integer,
	"submitted_count" integer DEFAULT 0 NOT NULL,
	"queued_count" integer DEFAULT 0 NOT NULL,
	"running_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"retried_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"screenshot_count" integer DEFAULT 0 NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"bytes_stored" bigint DEFAULT 0 NOT NULL,
	"content_created_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"avg_item_duration_ms" integer,
	"error_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "media_kind" NOT NULL,
	"status" "media_status" DEFAULT 'pending' NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_bucket" text,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_filename" text,
	"byte_size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"has_alpha" boolean,
	"is_animated" boolean,
	"color_profile" text,
	"dominant_color_hex" text,
	"sha256" text NOT NULL,
	"perceptual_hash" char(16),
	"source_url" text,
	"origin_domain" text,
	"source_id" uuid,
	"parent_content_id" uuid,
	"crawl_job_id" uuid,
	"capture_id" uuid,
	"capture_method" "capture_method" DEFAULT 'manual_upload' NOT NULL,
	"upload_source" "media_upload_source" DEFAULT 'manual_upload' NOT NULL,
	"captured_at" timestamp with time zone,
	"viewport_width" integer,
	"viewport_height" integer,
	"device_scale_factor" integer,
	"device_profile" text,
	"device_class" "device_class",
	"browser_name" text,
	"browser_version" text,
	"screenshot_scope" "screenshot_scope",
	"title" text,
	"alt_text" text,
	"caption" text,
	"internal_notes" text,
	"scan_status" "media_scan_status" DEFAULT 'pending' NOT NULL,
	"scan_notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"bytes_deleted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(original_filename, '')), 'A') || setweight(to_tsvector('english', coalesce(alt_text, '') || ' ' || coalesce(origin_domain, '')), 'B') || setweight(to_tsvector('english', coalesce(caption, '') || ' ' || coalesce(source_url, '')), 'C') || setweight(to_tsvector('english', coalesce(internal_notes, '')), 'D')) STORED
);
--> statement-breakpoint
CREATE TABLE "media_derivatives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"media_id" uuid NOT NULL,
	"kind" "media_derivative_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_usages" (
	"media_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"role" "media_usage_role" DEFAULT 'attachment' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_usages_media_id_content_item_id_role_pk" PRIMARY KEY("media_id","content_item_id","role")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module" "module" DEFAULT 'web' NOT NULL,
	"type" "source_type" DEFAULT 'website' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text,
	"canonical_url" text,
	"canonical_url_hash" text,
	"company_name" text,
	"product_name" text,
	"description" text,
	"platforms" "platform"[] DEFAULT '{}'::platform[] NOT NULL,
	"primary_device_class" "device_class",
	"status" "lifecycle_status" DEFAULT 'draft' NOT NULL,
	"health" "source_health" DEFAULT 'unknown' NOT NULL,
	"first_captured_at" timestamp with time zone,
	"last_captured_at" timestamp with time zone,
	"last_successful_capture_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_response_status" integer,
	"last_load_time_ms" integer,
	"last_error_code" text,
	"last_error_message" text,
	"capture_interval_days" integer,
	"next_scheduled_capture_at" timestamp with time zone,
	"robots_status" "robots_status" DEFAULT 'unknown' NOT NULL,
	"robots_checked_at" timestamp with time zone,
	"requests_per_minute_override" integer,
	"crawl_blocked_at" timestamp with time zone,
	"crawl_blocked_reason" text,
	"rights_status" "rights_status" DEFAULT 'unknown' NOT NULL,
	"rights_owner" text,
	"attribution" text,
	"permission_status" "permission_status" DEFAULT 'not_requested' NOT NULL,
	"takedown_status" "takedown_status" DEFAULT 'none' NOT NULL,
	"legal_review_status" "legal_review_status" DEFAULT 'not_started' NOT NULL,
	"rights_notes" text,
	"notes" text,
	"internal_notes" text,
	"content_count" integer DEFAULT 0 NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"capture_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', coalesce(company_name, '') || ' ' || coalesce(product_name, '') || ' ' || coalesce(domain, '')), 'B') || setweight(to_tsvector('english', coalesce(description, '')), 'C') || setweight(to_tsvector('english', coalesce(notes, '')), 'D')) STORED
);
--> statement-breakpoint
CREATE TABLE "classification_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target" "taxonomy_target" NOT NULL,
	"content_item_id" uuid,
	"source_id" uuid,
	"media_id" uuid,
	"field" text NOT NULL,
	"suggested_value" jsonb NOT NULL,
	"confidence" real,
	"rationale" text,
	"model" text NOT NULL,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"review_status" "suggestion_review_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"applied_value" jsonb,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"term_id" uuid NOT NULL,
	"target" "taxonomy_target" NOT NULL,
	"content_item_id" uuid,
	"source_id" uuid,
	"media_id" uuid,
	"origin" "classification_origin" DEFAULT 'human_added' NOT NULL,
	"confidence" real,
	"model" text,
	"prompt_version" text,
	"suggested_at" timestamp with time zone,
	"review_status" "suggestion_review_status" DEFAULT 'accepted' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"replaced_term_id" uuid,
	"is_primary" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "taxonomy_kind" NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "taxonomy_term_status" DEFAULT 'active' NOT NULL,
	"path" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"color" text,
	"is_seed" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', coalesce(slug, '')), 'B') || setweight(to_tsvector('english', coalesce(description, '')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" "audit_actor_type" DEFAULT 'user' NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" "audit_entity_type" NOT NULL,
	"entity_id" uuid,
	"entity_label" text,
	"before" jsonb,
	"after" jsonb,
	"batch_id" uuid,
	"request_id" text,
	"ip" "inet",
	"user_agent" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_collection_id_content_item_id_pk" PRIMARY KEY("collection_id","content_item_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module" "module",
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"visibility" "collection_visibility" DEFAULT 'private' NOT NULL,
	"status" "collection_status" DEFAULT 'draft' NOT NULL,
	"cover_media_id" uuid,
	"item_count" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"curated_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content_item_id" uuid NOT NULL,
	"reason" "review_reason" DEFAULT 'new_capture' NOT NULL,
	"assigned_to" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone,
	"status" "review_assignment_status" DEFAULT 'pending' NOT NULL,
	"decision" "review_decision",
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"notes" text,
	"duration_ms" integer,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_registry" ADD CONSTRAINT "url_registry_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_relations" ADD CONSTRAINT "content_relations_from_id_content_items_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_relations" ADD CONSTRAINT "content_relations_to_id_content_items_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_relations" ADD CONSTRAINT "content_relations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_details" ADD CONSTRAINT "experience_details_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_details" ADD CONSTRAINT "flow_details_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_details" ADD CONSTRAINT "flow_details_entry_content_id_content_items_id_fk" FOREIGN KEY ("entry_content_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_details" ADD CONSTRAINT "flow_details_exit_content_id_content_items_id_fk" FOREIGN KEY ("exit_content_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_flow_id_content_items_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_details" ADD CONSTRAINT "interaction_details_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_details" ADD CONSTRAINT "interaction_details_before_state_id_content_items_id_fk" FOREIGN KEY ("before_state_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_details" ADD CONSTRAINT "interaction_details_after_state_id_content_items_id_fk" FOREIGN KEY ("after_state_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_details" ADD CONSTRAINT "page_details_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_details" ADD CONSTRAINT "screen_details_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_details" ADD CONSTRAINT "state_details_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD CONSTRAINT "worker_instances_token_id_worker_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."worker_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_tokens" ADD CONSTRAINT "worker_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_job_events" ADD CONSTRAINT "crawl_job_events_job_id_crawl_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."crawl_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_job_events" ADD CONSTRAINT "crawl_job_events_item_id_crawl_job_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."crawl_job_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_job_items" ADD CONSTRAINT "crawl_job_items_job_id_crawl_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."crawl_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_job_urls" ADD CONSTRAINT "crawl_job_urls_job_id_crawl_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."crawl_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_usages" ADD CONSTRAINT "media_usages_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_usages" ADD CONSTRAINT "media_usages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_suggestions" ADD CONSTRAINT "classification_suggestions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_assignments" ADD CONSTRAINT "taxonomy_assignments_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_assignments" ADD CONSTRAINT "taxonomy_assignments_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_assignments" ADD CONSTRAINT "taxonomy_assignments_replaced_term_id_taxonomy_terms_id_fk" FOREIGN KEY ("replaced_term_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_assignments" ADD CONSTRAINT "taxonomy_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_terms" ADD CONSTRAINT "taxonomy_terms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_terms" ADD CONSTRAINT "taxonomy_terms_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_curated_by_users_id_fk" FOREIGN KEY ("curated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_content_idx" ON "captures" USING btree ("content_item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "captures_source_idx" ON "captures" USING btree ("source_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "captures_job_idx" ON "captures" USING btree ("crawl_job_id");--> statement-breakpoint
CREATE INDEX "captures_job_item_idx" ON "captures" USING btree ("crawl_job_item_id");--> statement-breakpoint
CREATE INDEX "captures_status_idx" ON "captures" USING btree ("status");--> statement-breakpoint
CREATE INDEX "captures_created_idx" ON "captures" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "captures_content_hash_idx" ON "captures" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "captures_changed_idx" ON "captures" USING btree ("created_at" DESC NULLS LAST) WHERE "captures"."changed" = true;--> statement-breakpoint
CREATE INDEX "captures_failed_idx" ON "captures" USING btree ("created_at" DESC NULLS LAST) WHERE "captures"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "robots_cache_expires_idx" ON "robots_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "url_registry_host_idx" ON "url_registry" USING btree ("host");--> statement-breakpoint
CREATE INDEX "url_registry_domain_idx" ON "url_registry" USING btree ("registrable_domain");--> statement-breakpoint
CREATE INDEX "url_registry_resolved_idx" ON "url_registry" USING btree ("resolved_url_hash");--> statement-breakpoint
CREATE INDEX "url_registry_canonical_idx" ON "url_registry" USING btree ("canonical_url_hash");--> statement-breakpoint
CREATE INDEX "url_registry_content_idx" ON "url_registry" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "url_registry_source_idx" ON "url_registry" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "url_registry_last_seen_idx" ON "url_registry" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "content_kind_slug_key" ON "content_items" USING btree ("kind","slug") WHERE "content_items"."slug" is not null and "content_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "content_status_idx" ON "content_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_kind_idx" ON "content_items" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "content_module_idx" ON "content_items" USING btree ("module");--> statement-breakpoint
CREATE INDEX "content_source_idx" ON "content_items" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "content_experience_idx" ON "content_items" USING btree ("experience_id");--> statement-breakpoint
CREATE INDEX "content_parent_idx" ON "content_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "content_version_of_idx" ON "content_items" USING btree ("version_of_id");--> statement-breakpoint
CREATE INDEX "content_updated_idx" ON "content_items" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_captured_idx" ON "content_items" USING btree ("captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_content_hash_idx" ON "content_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "content_review_queue_idx" ON "content_items" USING btree ("created_at") WHERE "content_items"."status" = 'needs_review' and "content_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "content_published_idx" ON "content_items" USING btree ("published_at" DESC NULLS LAST) WHERE "content_items"."status" = 'published' and "content_items"."deleted_at" is null and "content_items"."rights_status" not in ('pending_review','restricted','removed','do_not_republish');--> statement-breakpoint
CREATE INDEX "content_status_kind_idx" ON "content_items" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "content_search_idx" ON "content_items" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "content_relation_to_idx" ON "content_relations" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_step_position_key" ON "flow_steps" USING btree ("flow_id","position");--> statement-breakpoint
CREATE INDEX "flow_step_flow_idx" ON "flow_steps" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "flow_step_content_idx" ON "flow_steps" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "interaction_type_idx" ON "interaction_details" USING btree ("interaction_type");--> statement-breakpoint
CREATE UNIQUE INDEX "page_normalized_url_key" ON "page_details" USING btree ("normalized_url_hash");--> statement-breakpoint
CREATE INDEX "page_final_url_hash_idx" ON "page_details" USING btree ("final_url_hash");--> statement-breakpoint
CREATE INDEX "page_canonical_hash_idx" ON "page_details" USING btree ("canonical_url_hash");--> statement-breakpoint
CREATE INDEX "page_http_status_idx" ON "page_details" USING btree ("http_status");--> statement-breakpoint
CREATE INDEX "screen_app_version_idx" ON "screen_details" USING btree ("app_version");--> statement-breakpoint
CREATE INDEX "state_name_idx" ON "state_details" USING btree ("state_name");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "worker_instances_heartbeat_idx" ON "worker_instances" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "worker_instances_token_idx" ON "worker_instances" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_tokens_hash_key" ON "worker_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "worker_tokens_revoked_idx" ON "worker_tokens" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "crawl_job_events_job_idx" ON "crawl_job_events" USING btree ("job_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crawl_job_events_item_idx" ON "crawl_job_events" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "crawl_job_events_level_idx" ON "crawl_job_events" USING btree ("job_id","level");--> statement-breakpoint
CREATE INDEX "crawl_job_events_code_idx" ON "crawl_job_events" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_job_items_job_url_key" ON "crawl_job_items" USING btree ("job_id","normalized_url_hash");--> statement-breakpoint
CREATE INDEX "crawl_job_items_claim_idx" ON "crawl_job_items" USING btree ("priority" DESC NULLS LAST,"available_at","id") WHERE "crawl_job_items"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "crawl_job_items_lease_idx" ON "crawl_job_items" USING btree ("lease_expires_at") WHERE "crawl_job_items"."status" in ('leased','running');--> statement-breakpoint
CREATE INDEX "crawl_job_items_job_status_idx" ON "crawl_job_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "crawl_job_items_host_idx" ON "crawl_job_items" USING btree ("host");--> statement-breakpoint
CREATE INDEX "crawl_job_items_hash_idx" ON "crawl_job_items" USING btree ("normalized_url_hash");--> statement-breakpoint
CREATE INDEX "crawl_job_items_capture_idx" ON "crawl_job_items" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "crawl_job_items_content_idx" ON "crawl_job_items" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "crawl_job_items_failed_idx" ON "crawl_job_items" USING btree ("job_id") WHERE "crawl_job_items"."status" in ('failed','dead_letter');--> statement-breakpoint
CREATE INDEX "crawl_job_urls_job_idx" ON "crawl_job_urls" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "crawl_job_urls_outcome_idx" ON "crawl_job_urls" USING btree ("job_id","outcome");--> statement-breakpoint
CREATE INDEX "crawl_job_urls_hash_idx" ON "crawl_job_urls" USING btree ("normalized_url_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_jobs_reference_key" ON "crawl_jobs" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "crawl_jobs_status_idx" ON "crawl_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crawl_jobs_created_idx" ON "crawl_jobs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crawl_jobs_source_idx" ON "crawl_jobs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "crawl_jobs_created_by_idx" ON "crawl_jobs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "crawl_jobs_active_idx" ON "crawl_jobs" USING btree ("priority","created_at") WHERE "crawl_jobs"."status" in ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "media_sha256_key" ON "media_assets" USING btree ("sha256") WHERE "media_assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_phash_idx" ON "media_assets" USING btree ("perceptual_hash") WHERE "media_assets"."perceptual_hash" is not null and "media_assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_kind_idx" ON "media_assets" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "media_status_idx" ON "media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media_assets" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_captured_idx" ON "media_assets" USING btree ("captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_source_idx" ON "media_assets" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "media_parent_content_idx" ON "media_assets" USING btree ("parent_content_id");--> statement-breakpoint
CREATE INDEX "media_crawl_job_idx" ON "media_assets" USING btree ("crawl_job_id");--> statement-breakpoint
CREATE INDEX "media_capture_idx" ON "media_assets" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "media_mime_idx" ON "media_assets" USING btree ("mime_type");--> statement-breakpoint
CREATE INDEX "media_origin_domain_idx" ON "media_assets" USING btree ("origin_domain");--> statement-breakpoint
CREATE INDEX "media_byte_size_idx" ON "media_assets" USING btree ("byte_size" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_unused_idx" ON "media_assets" USING btree ("created_at" DESC NULLS LAST) WHERE "media_assets"."usage_count" = 0 and "media_assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_search_idx" ON "media_assets" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_key_key" ON "media_assets" USING btree ("storage_driver","storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "media_derivative_key" ON "media_derivatives" USING btree ("media_id","kind");--> statement-breakpoint
CREATE INDEX "media_derivative_media_idx" ON "media_derivatives" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "media_usage_content_idx" ON "media_usages" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "media_usage_media_idx" ON "media_usages" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_slug_key" ON "sources" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_domain_key" ON "sources" USING btree ("domain") WHERE "sources"."deleted_at" is null and "sources"."domain" is not null;--> statement-breakpoint
CREATE INDEX "sources_module_idx" ON "sources" USING btree ("module");--> statement-breakpoint
CREATE INDEX "sources_status_idx" ON "sources" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sources_health_idx" ON "sources" USING btree ("health");--> statement-breakpoint
CREATE INDEX "sources_last_captured_idx" ON "sources" USING btree ("last_captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sources_next_scheduled_idx" ON "sources" USING btree ("next_scheduled_capture_at") WHERE "sources"."next_scheduled_capture_at" is not null and "sources"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "sources_rights_idx" ON "sources" USING btree ("rights_status");--> statement-breakpoint
CREATE INDEX "sources_canonical_hash_idx" ON "sources" USING btree ("canonical_url_hash");--> statement-breakpoint
CREATE INDEX "sources_search_idx" ON "sources" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "sources_name_trgm_idx" ON "sources" USING btree ("name");--> statement-breakpoint
CREATE INDEX "classification_content_idx" ON "classification_suggestions" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "classification_source_idx" ON "classification_suggestions" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "classification_media_idx" ON "classification_suggestions" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "classification_field_idx" ON "classification_suggestions" USING btree ("field");--> statement-breakpoint
CREATE INDEX "classification_model_idx" ON "classification_suggestions" USING btree ("model");--> statement-breakpoint
CREATE INDEX "classification_pending_idx" ON "classification_suggestions" USING btree ("created_at") WHERE "classification_suggestions"."review_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "classification_content_field_key" ON "classification_suggestions" USING btree ("content_item_id","field","model") WHERE "classification_suggestions"."content_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_assign_content_key" ON "taxonomy_assignments" USING btree ("term_id","content_item_id") WHERE "taxonomy_assignments"."content_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_assign_source_key" ON "taxonomy_assignments" USING btree ("term_id","source_id") WHERE "taxonomy_assignments"."source_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_assign_media_key" ON "taxonomy_assignments" USING btree ("term_id","media_id") WHERE "taxonomy_assignments"."media_id" is not null;--> statement-breakpoint
CREATE INDEX "taxonomy_assign_content_idx" ON "taxonomy_assignments" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "taxonomy_assign_source_idx" ON "taxonomy_assignments" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "taxonomy_assign_media_idx" ON "taxonomy_assignments" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "taxonomy_assign_term_idx" ON "taxonomy_assignments" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "taxonomy_assign_origin_idx" ON "taxonomy_assignments" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "taxonomy_assign_pending_idx" ON "taxonomy_assignments" USING btree ("created_at") WHERE "taxonomy_assignments"."review_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_kind_slug_key" ON "taxonomy_terms" USING btree ("kind","slug");--> statement-breakpoint
CREATE INDEX "taxonomy_kind_idx" ON "taxonomy_terms" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "taxonomy_parent_idx" ON "taxonomy_terms" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "taxonomy_status_idx" ON "taxonomy_terms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "taxonomy_path_idx" ON "taxonomy_terms" USING btree ("kind","path");--> statement-breakpoint
CREATE INDEX "taxonomy_usage_idx" ON "taxonomy_terms" USING btree ("usage_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "taxonomy_search_idx" ON "taxonomy_terms" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "taxonomy_aliases_idx" ON "taxonomy_terms" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_events" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_events" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_batch_idx" ON "audit_events" USING btree ("batch_id") WHERE "audit_events"."batch_id" is not null;--> statement-breakpoint
CREATE INDEX "collection_items_collection_idx" ON "collection_items" USING btree ("collection_id","position");--> statement-breakpoint
CREATE INDEX "collection_items_content_idx" ON "collection_items" USING btree ("content_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_slug_key" ON "collections" USING btree ("slug") WHERE "collections"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "collections_visibility_idx" ON "collections" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "collections_status_idx" ON "collections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "collections_module_idx" ON "collections" USING btree ("module");--> statement-breakpoint
CREATE INDEX "collections_public_idx" ON "collections" USING btree ("sort_order","name") WHERE "collections"."visibility" = 'public' and "collections"."status" = 'active' and "collections"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "reviews_content_idx" ON "reviews" USING btree ("content_item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_assigned_idx" ON "reviews" USING btree ("assigned_to","status");--> statement-breakpoint
CREATE INDEX "reviews_decided_idx" ON "reviews" USING btree ("decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reviews_open_idx" ON "reviews" USING btree ("assigned_to","created_at") WHERE "reviews"."status" in ('pending','in_progress');--> statement-breakpoint
CREATE INDEX "settings_updated_idx" ON "settings" USING btree ("updated_at" DESC NULLS LAST);