-- Migration 401: NL-5 P4 growth LMS reference table.
--
-- Global reference content only: no tenant_id, no RLS, no PHI. This mirrors
-- the terminology reference-data stance from migrations 275/307.

BEGIN;

CREATE TABLE IF NOT EXISTS growth_lms_import_batches (
  id              BIGSERIAL PRIMARY KEY,
  dataset         VARCHAR(20) NOT NULL,
  source_ref      TEXT NOT NULL,
  source_version  VARCHAR(80),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  rows_processed  INTEGER NOT NULL DEFAULT 0,
  rows_upserted   INTEGER NOT NULL DEFAULT 0,
  rows_skipped    INTEGER NOT NULL DEFAULT 0,
  rows_failed     INTEGER NOT NULL DEFAULT 0,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  error_detail    TEXT,
  started_at      TIMESTAMPTZ(6),
  finished_at     TIMESTAMPTZ(6),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_growth_lms_import_dataset
    CHECK (dataset IN ('WHO_0_5', 'IAP_5_18', 'CDC_2_20', 'FENTON')),
  CONSTRAINT chk_growth_lms_import_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_growth_lms_import_dataset_created
  ON growth_lms_import_batches(dataset, created_at DESC);

CREATE TABLE IF NOT EXISTS growth_reference_lms (
  id              BIGSERIAL PRIMARY KEY,
  dataset         VARCHAR(20) NOT NULL,
  sex             CHAR(1) NOT NULL,
  metric          VARCHAR(40) NOT NULL,
  age_days        INTEGER NOT NULL CHECK (age_days >= 0),
  l               NUMERIC(12, 8) NOT NULL,
  m               NUMERIC(12, 6) NOT NULL CHECK (m > 0),
  s               NUMERIC(12, 8) NOT NULL CHECK (s > 0),
  source_version  VARCHAR(80),
  import_batch_id BIGINT REFERENCES growth_lms_import_batches(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_growth_reference_lms_dataset
    CHECK (dataset IN ('WHO_0_5', 'IAP_5_18', 'CDC_2_20', 'FENTON')),
  CONSTRAINT chk_growth_reference_lms_sex
    CHECK (sex IN ('M', 'F')),
  CONSTRAINT chk_growth_reference_lms_metric
    CHECK (metric IN ('height_cm', 'weight_kg', 'head_circumference_cm', 'bmi')),
  CONSTRAINT growth_reference_lms_dataset_sex_metric_age_key
    UNIQUE (dataset, sex, metric, age_days)
);

CREATE INDEX IF NOT EXISTS idx_growth_reference_lms_lookup
  ON growth_reference_lms(dataset, sex, metric, age_days);

COMMIT;
