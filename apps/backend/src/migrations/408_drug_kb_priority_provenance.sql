-- 408_drug_kb_priority_provenance.sql
--
-- NL-5 P2 drug-KB seams. Adds deterministic source precedence, immutable
-- edition metadata for VH-owned indigenous KB releases, and row-level
-- provenance columns on every drug_kb_* content table. This is substrate only:
-- no drug facts or clinical content rows are authored here.

BEGIN;

ALTER TABLE drug_kb_sources
  ADD COLUMN IF NOT EXISTS priority INTEGER,
  ADD COLUMN IF NOT EXISTS source_family VARCHAR(80),
  ADD COLUMN IF NOT EXISTS edition_status VARCHAR(24),
  ADD COLUMN IF NOT EXISTS license_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS accepted_by UUID,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS source_hash VARCHAR(128);

UPDATE drug_kb_sources
   SET priority = 100
 WHERE priority IS NULL;

UPDATE drug_kb_sources
   SET source_family = source_key
 WHERE source_family IS NULL OR btrim(source_family) = '';

UPDATE drug_kb_sources
   SET edition_status = CASE WHEN is_active THEN 'accepted' ELSE 'retired' END
 WHERE edition_status IS NULL OR btrim(edition_status) = '';

UPDATE drug_kb_sources
   SET license_status = CASE
     WHEN is_starter THEN 'permission_recorded'
     ELSE 'permission_required'
   END
 WHERE license_status IS NULL OR btrim(license_status) = '';

UPDATE drug_kb_sources
   SET activated_at = COALESCE(imported_at, created_at)
 WHERE is_active = TRUE
   AND activated_at IS NULL;

ALTER TABLE drug_kb_sources
  ALTER COLUMN priority SET DEFAULT 100,
  ALTER COLUMN priority SET NOT NULL,
  ALTER COLUMN source_family SET DEFAULT 'external',
  ALTER COLUMN source_family SET NOT NULL,
  ALTER COLUMN edition_status SET DEFAULT 'accepted',
  ALTER COLUMN edition_status SET NOT NULL,
  ALTER COLUMN license_status SET DEFAULT 'permission_required',
  ALTER COLUMN license_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_drug_kb_sources_priority'
  ) THEN
    ALTER TABLE drug_kb_sources
      ADD CONSTRAINT chk_drug_kb_sources_priority CHECK (priority >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_drug_kb_sources_license_status'
  ) THEN
    ALTER TABLE drug_kb_sources
      ADD CONSTRAINT chk_drug_kb_sources_license_status CHECK (
        license_status IN (
          'hospital_owned',
          'government_open_data_attribution',
          'permission_recorded',
          'permission_required',
          'operator_supplied_terms',
          'reference_only',
          'prohibited'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_drug_kb_sources_edition_status'
  ) THEN
    ALTER TABLE drug_kb_sources
      ADD CONSTRAINT chk_drug_kb_sources_edition_status CHECK (
        edition_status IN ('candidate', 'accepted', 'rejected', 'retired', 'rolled_back')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_drug_kb_indigenous_activation_snapshot'
  ) THEN
    ALTER TABLE drug_kb_sources
      ADD CONSTRAINT chk_drug_kb_indigenous_activation_snapshot CHECK (
        source_family <> 'vh_indigenous'
        OR is_active = FALSE
        OR metadata ? 'acceptance_snapshot'
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drug_kb_sources_active_priority
  ON drug_kb_sources (is_active, priority DESC, source_key);

CREATE INDEX IF NOT EXISTS idx_drug_kb_sources_family_status
  ON drug_kb_sources (source_family, edition_status, version);

CREATE UNIQUE INDEX IF NOT EXISTS uq_drug_kb_sources_active_vh_indigenous
  ON drug_kb_sources (source_family)
  WHERE source_family = 'vh_indigenous' AND is_active = TRUE;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'drug_kb_monographs',
    'drug_kb_interactions',
    'drug_kb_allergy_groups',
    'drug_kb_allergy_cross_reactivity',
    'drug_kb_condition_cautions',
    'drug_kb_dose_ranges',
    'drug_kb_iv_compatibility'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT ''{}''::jsonb', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS source_refs JSONB NOT NULL DEFAULT ''[]''::jsonb', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS license_status VARCHAR(40) NOT NULL DEFAULT ''permission_recorded''', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS review_status VARCHAR(24) NOT NULL DEFAULT ''legacy''', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS authored_by UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS authored_at TIMESTAMPTZ(6)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS clinical_reviewer_by UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS clinical_reviewed_at TIMESTAMPTZ(6)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS pharmacy_reviewer_by UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS pharmacy_reviewed_at TIMESTAMPTZ(6)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS approved_by UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ(6)', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_source_refs_json_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (jsonb_typeof(source_refs) = ''array'')',
        t,
        t || '_source_refs_json_check'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_license_status_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (license_status IN (''hospital_owned'', ''government_open_data_attribution'', ''permission_recorded'', ''permission_required'', ''operator_supplied_terms'', ''reference_only'', ''prohibited''))',
        t,
        t || '_license_status_check'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_review_status_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (review_status IN (''legacy'', ''draft'', ''in_review'', ''approved'', ''rejected'', ''retired''))',
        t,
        t || '_review_status_check'
      );
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_drug_kb_monographs_review
  ON drug_kb_monographs (source_key, review_status, license_status);
CREATE INDEX IF NOT EXISTS idx_drug_kb_interactions_review
  ON drug_kb_interactions (source_key, review_status, license_status);
CREATE INDEX IF NOT EXISTS idx_drug_kb_allergy_groups_review
  ON drug_kb_allergy_groups (source_key, review_status, license_status);
CREATE INDEX IF NOT EXISTS idx_drug_kb_allergy_xreact_review
  ON drug_kb_allergy_cross_reactivity (source_key, review_status, license_status);
CREATE INDEX IF NOT EXISTS idx_drug_kb_condition_cautions_review
  ON drug_kb_condition_cautions (source_key, review_status, license_status);
CREATE INDEX IF NOT EXISTS idx_drug_kb_dose_ranges_review
  ON drug_kb_dose_ranges (source_key, review_status, license_status);
CREATE INDEX IF NOT EXISTS idx_drug_kb_iv_compatibility_review
  ON drug_kb_iv_compatibility (source_key, review_status, license_status);

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'DRUG_KB_PRIORITY_PROVENANCE_APPLIED',
  'drug_kb_sources',
  '408_drug_kb_priority_provenance',
  jsonb_build_object(
    'migration', '408_drug_kb_priority_provenance.sql',
    'scope', 'NL-5 P2 drug-KB source precedence, immutable edition metadata, and row provenance substrate',
    'content_rows_authored', 0
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'DRUG_KB_PRIORITY_PROVENANCE_APPLIED'
    AND resource_id = '408_drug_kb_priority_provenance'
);

COMMIT;
