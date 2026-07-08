-- 453_feedback_nps_rollups.sql
-- NL9-P2: aggregate NPS snapshots for quality/admin dashboards.

BEGIN;

CREATE TABLE IF NOT EXISTS feedback_nps_rollups (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grain               VARCHAR(10) NOT NULL
    CHECK (grain IN ('daily', 'weekly')),
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  dimension_type      VARCHAR(40) NOT NULL DEFAULT 'tenant'
    CHECK (dimension_type IN ('tenant', 'department', 'doctor', 'encounter_type', 'channel')),
  dimension_key       VARCHAR(120) NOT NULL DEFAULT 'all',
  dimension_label     VARCHAR(255),
  response_count      INTEGER NOT NULL DEFAULT 0 CHECK (response_count >= 0),
  request_count       INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  promoter_count      INTEGER NOT NULL DEFAULT 0 CHECK (promoter_count >= 0),
  passive_count       INTEGER NOT NULL DEFAULT 0 CHECK (passive_count >= 0),
  detractor_count     INTEGER NOT NULL DEFAULT 0 CHECK (detractor_count >= 0),
  nps_score           NUMERIC(6,2),
  response_rate       NUMERIC(6,2),
  minimum_sample_size INTEGER NOT NULL DEFAULT 5 CHECK (minimum_sample_size >= 1),
  sample_visible      BOOLEAN NOT NULL DEFAULT FALSE,
  source_range        JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT feedback_nps_rollup_period_ck CHECK (period_end >= period_start),
  CONSTRAINT feedback_nps_rollup_counts_ck CHECK (
    response_count = promoter_count + passive_count + detractor_count
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_nps_rollups_slice
  ON feedback_nps_rollups (tenant_id, grain, period_start, dimension_type, dimension_key);

CREATE INDEX IF NOT EXISTS idx_feedback_nps_rollups_tenant_period
  ON feedback_nps_rollups (tenant_id, grain, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_nps_rollups_dimension
  ON feedback_nps_rollups (tenant_id, dimension_type, dimension_key, period_start DESC);

ALTER TABLE feedback_nps_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_nps_rollups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feedback_nps_rollups;
CREATE POLICY tenant_isolation ON feedback_nps_rollups
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
