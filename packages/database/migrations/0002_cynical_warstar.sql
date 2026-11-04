CREATE TYPE "public"."capture_session_status" AS ENUM('pending', 'starting', 'live', 'closed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."discovered_page_status" AS ENUM('new', 'captured', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."session_command_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'discovered_page' BEFORE 'collection';--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'capture_session' BEFORE 'collection';--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'flow' BEFORE 'collection';--> statement-breakpoint
CREATE TABLE "discovered_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "discovered_page_status" DEFAULT 'new' NOT NULL,
	"source_id" uuid,
	"job_id" uuid,
	"job_item_id" uuid,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"final_url" text,
	"host" text NOT NULL,
	"path" text,
	"http_status" integer,
	"title" text,
	"description" text,
	"og_title" text,
	"og_type" text,
	"h1" text,
	"lang_attr" text,
	"word_count" integer,
	"preview_media_id" uuid,
	"depth" smallint DEFAULT 0 NOT NULL,
	"discovered_from_url" text,
	"screen_count" integer DEFAULT 0 NOT NULL,
	"ignore_reason" text,
	"ignore_note" text,
	"triaged_by" uuid,
	"triaged_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(path, '') || ' ' || coalesce(h1, '')), 'B') || setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(url, '')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "capture_session_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "session_command_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capture_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "capture_session_status" DEFAULT 'pending' NOT NULL,
	"target_url" text NOT NULL,
	"current_url" text,
	"current_title" text,
	"device_profile" text NOT NULL,
	"device_class" "device_class" NOT NULL,
	"viewport_width" integer NOT NULL,
	"viewport_height" integer NOT NULL,
	"device_scale_factor" integer NOT NULL,
	"source_id" uuid,
	"discovered_page_id" uuid,
	"flow_id" uuid,
	"worker_name" text,
	"worker_instance_id" uuid,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"frame" "bytea",
	"frame_width" integer,
	"frame_height" integer,
	"frame_bytes" integer,
	"frame_at" timestamp with time zone,
	"frame_seq" integer DEFAULT 0 NOT NULL,
	"viewer_seen_at" timestamp with time zone,
	"screens_captured" integer DEFAULT 0 NOT NULL,
	"command_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screen_details" ALTER COLUMN "acquisition" SET DEFAULT 'interactive_capture';--> statement-breakpoint
ALTER TABLE "screen_details" ALTER COLUMN "acquisition" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "screen_details" ADD COLUMN "state_label" text;--> statement-breakpoint
ALTER TABLE "screen_details" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "screen_details" ADD COLUMN "device_profile" text;--> statement-breakpoint
ALTER TABLE "screen_details" ADD COLUMN "device_scale_factor" integer;--> statement-breakpoint
ALTER TABLE "screen_details" ADD COLUMN "capture_session_id" uuid;--> statement-breakpoint
ALTER TABLE "screen_details" ADD COLUMN "discovered_page_id" uuid;--> statement-breakpoint
ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_job_id_crawl_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."crawl_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_triaged_by_users_id_fk" FOREIGN KEY ("triaged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_session_commands" ADD CONSTRAINT "capture_session_commands_session_id_capture_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."capture_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_session_commands" ADD CONSTRAINT "capture_session_commands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_discovered_page_id_discovered_pages_id_fk" FOREIGN KEY ("discovered_page_id") REFERENCES "public"."discovered_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_page_url_key" ON "discovered_pages" USING btree ("normalized_url_hash");--> statement-breakpoint
CREATE INDEX "discovered_page_status_idx" ON "discovered_pages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "discovered_page_source_idx" ON "discovered_pages" USING btree ("source_id","status");--> statement-breakpoint
CREATE INDEX "discovered_page_job_idx" ON "discovered_pages" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "discovered_page_host_idx" ON "discovered_pages" USING btree ("host");--> statement-breakpoint
CREATE INDEX "discovered_page_search_idx" ON "discovered_pages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "discovered_page_queue_idx" ON "discovered_pages" USING btree ("created_at" DESC NULLS LAST) WHERE "discovered_pages"."status" = 'new';--> statement-breakpoint
CREATE UNIQUE INDEX "capture_session_command_seq_key" ON "capture_session_commands" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "capture_session_command_pending_idx" ON "capture_session_commands" USING btree ("session_id","seq") WHERE "capture_session_commands"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "capture_session_command_session_idx" ON "capture_session_commands" USING btree ("session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "capture_session_claim_idx" ON "capture_sessions" USING btree ("created_at") WHERE "capture_sessions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "capture_session_lease_idx" ON "capture_sessions" USING btree ("lease_expires_at") WHERE "capture_sessions"."status" in ('starting','live');--> statement-breakpoint
CREATE INDEX "capture_session_creator_idx" ON "capture_sessions" USING btree ("created_by","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "capture_session_flow_idx" ON "capture_sessions" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "capture_session_discovered_idx" ON "capture_sessions" USING btree ("discovered_page_id");--> statement-breakpoint
CREATE INDEX "screen_url_idx" ON "screen_details" USING btree ("url");--> statement-breakpoint
CREATE INDEX "screen_session_idx" ON "screen_details" USING btree ("capture_session_id");--> statement-breakpoint
CREATE INDEX "screen_discovered_idx" ON "screen_details" USING btree ("discovered_page_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-written tail.
--
-- Everything above is generated from the Drizzle schema. Everything below is
-- not expressible there: foreign keys whose declaration would create an import
-- cycle between schema modules, a backfill that has to run before a NOT NULL
-- can hold, and a data migration for the crawl configuration that this change
-- redefines. Same arrangement as migration 0001, for the same reason.
-- ---------------------------------------------------------------------------

-- Deferred foreign keys.
--
-- `screen_details.capture_session_id` and `capture_sessions.flow_id` point in
-- opposite directions across the content/studio module boundary, so declaring
-- both in TypeScript would make `content.ts` and `studio.ts` import each other.
-- The constraint is what matters, not where it is written.
--
-- Every one is ON DELETE SET NULL: these are provenance links. A Screen whose
-- studio session was purged is still a Screen, and losing the link must never
-- take the record with it.
ALTER TABLE "discovered_pages"
  ADD CONSTRAINT "discovered_pages_job_item_id_fk"
  FOREIGN KEY ("job_item_id") REFERENCES "crawl_job_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "discovered_pages"
  ADD CONSTRAINT "discovered_pages_preview_media_id_fk"
  FOREIGN KEY ("preview_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "screen_details"
  ADD CONSTRAINT "screen_details_capture_session_id_fk"
  FOREIGN KEY ("capture_session_id") REFERENCES "capture_sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "screen_details"
  ADD CONSTRAINT "screen_details_discovered_page_id_fk"
  FOREIGN KEY ("discovered_page_id") REFERENCES "discovered_pages"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_flow_id_fk"
  FOREIGN KEY ("flow_id") REFERENCES "content_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_worker_instance_id_fk"
  FOREIGN KEY ("worker_instance_id") REFERENCES "worker_instances"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- A frame is a preview, never an artefact. The ceiling is ten times the
-- expected size of one, so it catches a bug without ever refusing a legitimate
-- frame from a very busy page.
ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_frame_size_check"
  CHECK ("frame_bytes" IS NULL OR "frame_bytes" <= 8388608);
--> statement-breakpoint

-- A session that ended must say when, and one that is live must not claim to
-- have ended. Cheap to enforce, and it makes "how long do sessions last?"
-- answerable without qualification.
ALTER TABLE "capture_sessions"
  ADD CONSTRAINT "capture_sessions_closed_check"
  CHECK (("status" IN ('closed','failed','expired')) = ("closed_at" IS NOT NULL));
--> statement-breakpoint

-- An ignored candidate records why. The vocabulary is `IGNORE_REASONS`, kept
-- as text so it can grow from operator experience, but its presence is
-- structural: "how much of what we crawl is worthless, and in which way?" is
-- the question that tells us the crawl scope is wrong.
ALTER TABLE "discovered_pages"
  ADD CONSTRAINT "discovered_pages_ignore_reason_check"
  CHECK ("status" <> 'ignored' OR "ignore_reason" IS NOT NULL);
--> statement-breakpoint

-- Backfill before the NOT NULL above can be trusted. Any screen_details row
-- predating this migration was produced by an automated job, which is exactly
-- what the pipeline no longer does — labelling them truthfully is what keeps
-- "how many Screens did a researcher actually choose?" answerable.
UPDATE "screen_details" SET "acquisition" = 'automated_capture' WHERE "acquisition" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Crawl configuration data migration.
--
-- A crawl no longer captures content, so the keys that told it how to are gone
-- from `crawlJobConfigSchema`, which is `.strict()` — an existing job whose
-- stored config still carries them would fail to parse and the job page would
-- 500. Strip the removed keys and supply the new ones.
--
-- `capturePreview` is set false rather than derived from the old screenshot
-- flags: those flags asked for full-page research images, and quietly
-- reinterpreting them as a request for triage thumbnails would be a different
-- job than the one the operator configured.
-- ---------------------------------------------------------------------------
UPDATE "crawl_jobs" SET "config" =
  ("config"
    - 'autoCreateContent' - 'contentKind' - 'sendToReview'
    - 'captureDesktop' - 'captureMobile' - 'desktopProfile' - 'mobileProfile'
    - 'fullPageScreenshot' - 'viewportScreenshot' - 'storeHtmlSnapshot'
    - 'captureOgImage' - 'captureFavicon'
    - 'captureInteractionStates' - 'interactionSteps'
  )
  || jsonb_build_object(
       'capturePreview', false,
       'previewProfile', 'desktop_1440',
       -- Level 3 no longer exists in the schema. Anything above 2 becomes 2.
       'maxCaptureLevel', least(coalesce(("config"->>'maxCaptureLevel')::int, 1), 2)
     );
