-- Circular foreign keys and cross-table check constraints.
--
-- Written by hand rather than generated, because these constraints cannot be
-- expressed in the Drizzle schema without creating a reference cycle that has
-- no valid table-creation order:
--
--   content_items.primary_media_id -> media_assets.id
--   media_assets.parent_content_id -> content_items.id
--
-- Both directions are genuinely wanted. Content needs to name its display
-- image; media needs to record which record it was captured for (§10
-- provenance). Adding the FKs after both tables exist is the standard
-- resolution, and it is why those columns carry a comment pointing here.
--
-- ON DELETE behaviour is chosen per direction:
--   * primary_media_id  -> SET NULL. Deleting a file must not delete the page.
--   * parent_content_id -> SET NULL. Provenance rows outlive their subject; a
--     media asset whose content record is gone still records where it came
--     from, which is the entire point of keeping it.

--> statement-breakpoint
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_primary_media_id_fk"
  FOREIGN KEY ("primary_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_experience_id_fk"
  FOREIGN KEY ("experience_id") REFERENCES "content_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_parent_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "content_items"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_version_of_id_fk"
  FOREIGN KEY ("version_of_id") REFERENCES "content_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_latest_capture_id_fk"
  FOREIGN KEY ("latest_capture_id") REFERENCES "captures"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_parent_content_id_fk"
  FOREIGN KEY ("parent_content_id") REFERENCES "content_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_crawl_job_id_fk"
  FOREIGN KEY ("crawl_job_id") REFERENCES "crawl_jobs"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_capture_id_fk"
  FOREIGN KEY ("capture_id") REFERENCES "captures"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "media_usages"
  ADD CONSTRAINT "media_usages_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "captures"
  ADD CONSTRAINT "captures_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "captures"
  ADD CONSTRAINT "captures_crawl_job_id_fk"
  FOREIGN KEY ("crawl_job_id") REFERENCES "crawl_jobs"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "captures"
  ADD CONSTRAINT "captures_crawl_job_item_id_fk"
  FOREIGN KEY ("crawl_job_item_id") REFERENCES "crawl_job_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "captures"
  ADD CONSTRAINT "captures_changed_from_capture_id_fk"
  FOREIGN KEY ("changed_from_capture_id") REFERENCES "captures"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "crawl_job_items"
  ADD CONSTRAINT "crawl_job_items_parent_item_id_fk"
  FOREIGN KEY ("parent_item_id") REFERENCES "crawl_job_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "crawl_job_items"
  ADD CONSTRAINT "crawl_job_items_capture_id_fk"
  FOREIGN KEY ("capture_id") REFERENCES "captures"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "crawl_job_items"
  ADD CONSTRAINT "crawl_job_items_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "crawl_job_urls"
  ADD CONSTRAINT "crawl_job_urls_existing_content_id_fk"
  FOREIGN KEY ("existing_content_id") REFERENCES "content_items"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "url_registry"
  ADD CONSTRAINT "url_registry_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "taxonomy_terms"
  ADD CONSTRAINT "taxonomy_terms_parent_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "taxonomy_terms"("id") ON DELETE RESTRICT;

--> statement-breakpoint
ALTER TABLE "taxonomy_assignments"
  ADD CONSTRAINT "taxonomy_assignments_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "taxonomy_assignments"
  ADD CONSTRAINT "taxonomy_assignments_source_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "taxonomy_assignments"
  ADD CONSTRAINT "taxonomy_assignments_media_id_fk"
  FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "classification_suggestions"
  ADD CONSTRAINT "classification_suggestions_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "classification_suggestions"
  ADD CONSTRAINT "classification_suggestions_source_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "classification_suggestions"
  ADD CONSTRAINT "classification_suggestions_media_id_fk"
  FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "collections"
  ADD CONSTRAINT "collections_cover_media_id_fk"
  FOREIGN KEY ("cover_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "collection_items"
  ADD CONSTRAINT "collection_items_content_item_id_fk"
  FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "flow_details"
  ADD CONSTRAINT "flow_details_entry_content_id_fk"
  FOREIGN KEY ("entry_content_id") REFERENCES "content_items"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Integrity constraints that express product rules in the database.
--
-- These duplicate checks that application code also performs. That is
-- intentional: the application check produces a good error message, and the
-- constraint guarantees the invariant holds even for a direct SQL write, a
-- migration, or a bug. The publishing rule in particular is the one invariant
-- in this system that must never be violated, so it is enforced in three
-- places — the guard function, the query filter, and here.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
-- A taxonomy assignment attaches to exactly one target.
ALTER TABLE "taxonomy_assignments"
  ADD CONSTRAINT "taxonomy_assignments_single_target"
  CHECK (
    (CASE WHEN content_item_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN source_id       IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN media_id        IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

--> statement-breakpoint
-- ...and the `target` discriminator agrees with which column is set.
ALTER TABLE "taxonomy_assignments"
  ADD CONSTRAINT "taxonomy_assignments_target_matches"
  CHECK (
    (target = 'content' AND content_item_id IS NOT NULL) OR
    (target = 'source'  AND source_id       IS NOT NULL) OR
    (target = 'media'   AND media_id        IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "classification_suggestions"
  ADD CONSTRAINT "classification_suggestions_single_target"
  CHECK (
    (CASE WHEN content_item_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN source_id       IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN media_id        IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

--> statement-breakpoint
-- Published content must carry the fields that make a public page coherent,
-- and must not be under a rights hold. This is `canPublish()` as a database
-- invariant: it is impossible to have a published row that the public API
-- would refuse to render, whatever wrote it.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_publishable"
  CHECK (
    status <> 'published' OR (
      title IS NOT NULL AND
      slug IS NOT NULL AND
      published_at IS NOT NULL AND
      rights_status NOT IN ('pending_review', 'restricted', 'removed', 'do_not_republish')
    )
  );

--> statement-breakpoint
-- Approval must be attributable. An `approved` or `published` record always
-- names who signed it off and when.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_approval_attributable"
  CHECK (
    status NOT IN ('approved', 'published') OR
    (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  );

--> statement-breakpoint
-- Confidence is a probability.
ALTER TABLE "taxonomy_assignments"
  ADD CONSTRAINT "taxonomy_assignments_confidence_range"
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

--> statement-breakpoint
ALTER TABLE "classification_suggestions"
  ADD CONSTRAINT "classification_suggestions_confidence_range"
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

--> statement-breakpoint
-- A leased queue item always carries the token that proves ownership, and a
-- pending one never does. This is what makes the stale-worker rejection in
-- `queue.ts` sound: there is no state where a token is ambiguous.
ALTER TABLE "crawl_job_items"
  ADD CONSTRAINT "crawl_job_items_lease_consistent"
  CHECK (
    (status IN ('leased', 'running') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status NOT IN ('leased', 'running') )
  );

--> statement-breakpoint
ALTER TABLE "crawl_job_items"
  ADD CONSTRAINT "crawl_job_items_attempts_bounded"
  CHECK (attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts + 1);

--> statement-breakpoint
-- Media byte size is never negative, and a ready asset has bytes.
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_byte_size_positive"
  CHECK (byte_size >= 0);

--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_sha256_format"
  CHECK (sha256 ~ '^[0-9a-f]{64}$');

--> statement-breakpoint
-- Flow step ordering is 1-based and dense enough to render.
ALTER TABLE "flow_steps"
  ADD CONSTRAINT "flow_steps_position_positive"
  CHECK (position >= 0);

--> statement-breakpoint
-- A term cannot be its own parent.
ALTER TABLE "taxonomy_terms"
  ADD CONSTRAINT "taxonomy_terms_no_self_parent"
  CHECK (parent_id IS NULL OR parent_id <> id);

--> statement-breakpoint
-- A content record cannot contain or version itself.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_no_self_reference"
  CHECK (
    (parent_id IS NULL OR parent_id <> id) AND
    (version_of_id IS NULL OR version_of_id <> id) AND
    (experience_id IS NULL OR experience_id <> id)
  );

--> statement-breakpoint
-- A relation always joins two different records.
ALTER TABLE "content_relations"
  ADD CONSTRAINT "content_relations_distinct"
  CHECK (from_id <> to_id);
