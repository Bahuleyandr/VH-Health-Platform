-- Migration 402: NL-5 P4 immunisation schedule pack versioning.
--
-- Adds additive source/version columns to vaccine_catalogue while preserving
-- the existing UNIQUE (tenant_id, code, dose_number) semantics.

BEGIN;

ALTER TABLE vaccine_catalogue
  ADD COLUMN IF NOT EXISTS schedule_source VARCHAR(10) NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS source_version VARCHAR(40),
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_vaccine_catalogue_schedule_source'
  ) THEN
    ALTER TABLE vaccine_catalogue
      ADD CONSTRAINT chk_vaccine_catalogue_schedule_source
      CHECK (schedule_source IN ('uip', 'iap', 'custom'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vaccine_catalogue_schedule_source
  ON vaccine_catalogue(tenant_id, schedule_source, source_version, active);

CREATE TABLE IF NOT EXISTS immunisation_schedule_import_batches (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule        VARCHAR(10) NOT NULL,
  source_version  VARCHAR(40) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  rows_processed  INTEGER NOT NULL DEFAULT 0,
  rows_upserted   INTEGER NOT NULL DEFAULT 0,
  rows_retired    INTEGER NOT NULL DEFAULT 0,
  rows_skipped    INTEGER NOT NULL DEFAULT 0,
  rows_failed     INTEGER NOT NULL DEFAULT 0,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  error_detail    TEXT,
  run_by          UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ(6),
  finished_at     TIMESTAMPTZ(6),
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_immunisation_schedule_import_schedule
    CHECK (schedule IN ('uip', 'iap', 'both')),
  CONSTRAINT chk_immunisation_schedule_import_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_immunisation_schedule_import_tenant_created
  ON immunisation_schedule_import_batches(tenant_id, created_at DESC);

ALTER TABLE immunisation_schedule_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE immunisation_schedule_import_batches FORCE ROW LEVEL SECURITY;

ALTER TABLE immunisation_schedule_import_batches
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DROP POLICY IF EXISTS tenant_isolation ON immunisation_schedule_import_batches;
CREATE POLICY tenant_isolation ON immunisation_schedule_import_batches
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
