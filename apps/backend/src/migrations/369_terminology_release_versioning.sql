-- 369_terminology_release_versioning.sql
--
-- NL-5 P1: versioned terminology release ingestion.
--
-- Terminology content stays GLOBAL reference data: no tenant_id and no RLS,
-- matching migrations 275 and 307. This migration only adds per-concept release
-- provenance so importer runs can stamp the release that last observed each
-- active concept and link the row back to terminology_import_batches.

BEGIN;

ALTER TABLE terminology_concepts
  ADD COLUMN IF NOT EXISTS last_seen_release VARCHAR(120);

ALTER TABLE terminology_concepts
  ADD COLUMN IF NOT EXISTS last_import_batch_id BIGINT
    REFERENCES terminology_import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_terminology_concepts_last_seen_release
  ON terminology_concepts (system_key, last_seen_release)
  WHERE last_seen_release IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_terminology_concepts_last_import_batch
  ON terminology_concepts (last_import_batch_id)
  WHERE last_import_batch_id IS NOT NULL;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TERMINOLOGY_RELEASE_VERSIONING_APPLIED',
  'terminology_concepts',
  'terminology_concepts',
  jsonb_build_object(
    'migration', '369_terminology_release_versioning.sql',
    'program', 'NL-5 P1',
    'reason', 'Add last_seen_release and last_import_batch_id for non-destructive terminology release imports and rollback drills.',
    'global_reference_data', true,
    'phi_tenant_id', 'No tenant_id on terminology_concepts; global reference data by design.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TERMINOLOGY_RELEASE_VERSIONING_APPLIED'
    AND resource = 'terminology_concepts'
);

COMMIT;
