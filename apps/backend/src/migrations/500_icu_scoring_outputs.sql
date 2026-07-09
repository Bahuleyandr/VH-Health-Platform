-- NL-14 P1: ICU scoring outputs as decision support.
--
-- RASS/CAM-ICU/CPOT/SOFA/SBT readiness rows store inputs, outputs, content
-- provenance, and reviewer identity. A hard CHECK prevents these records from
-- claiming order mutation authority.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_scoring_outputs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  scoring_kind VARCHAR(30) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  input_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  score_value NUMERIC(8, 2),
  score_label VARCHAR(120),
  output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reference_source TEXT,
  reference_version VARCHAR(80),
  policy_version_id BIGINT REFERENCES icu_chart_policy_versions(id) ON DELETE SET NULL,
  reviewer_uid UUID,
  reviewer_role VARCHAR(80),
  reviewed_at TIMESTAMPTZ(6),
  review_status VARCHAR(30) NOT NULL DEFAULT 'reviewed',
  protocol_available BOOLEAN NOT NULL DEFAULT TRUE,
  unavailable_reason TEXT,
  order_mutation_performed BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT icu_scoring_kind_check
    CHECK (scoring_kind IN ('rass', 'cam_icu', 'cpot', 'sofa', 'sbt_readiness')),
  CONSTRAINT icu_scoring_review_status_check
    CHECK (review_status IN ('draft', 'reviewed', 'signed', 'protocol_unavailable')),
  CONSTRAINT icu_scoring_no_order_mutation_check
    CHECK (order_mutation_performed = FALSE),
  CONSTRAINT icu_scoring_reference_gate_check
    CHECK (
      protocol_available = FALSE
      OR (reference_source IS NOT NULL AND reference_version IS NOT NULL AND reviewer_uid IS NOT NULL)
    ),
  CONSTRAINT icu_scoring_unavailable_gate_check
    CHECK (
      protocol_available = TRUE
      OR (review_status = 'protocol_unavailable' AND unavailable_reason IS NOT NULL)
    ),
  CONSTRAINT fk_icu_scoring_outputs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_icu_scoring_outputs_admission
  ON icu_scoring_outputs (tenant_id, icu_admission_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_icu_scoring_outputs_kind
  ON icu_scoring_outputs (tenant_id, icu_admission_id, scoring_kind, recorded_at DESC);

ALTER TABLE icu_scoring_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_scoring_outputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_scoring_outputs;
CREATE POLICY tenant_isolation ON icu_scoring_outputs
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
