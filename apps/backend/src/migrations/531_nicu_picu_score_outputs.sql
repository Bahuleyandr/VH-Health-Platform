-- NL-14 P3: neonatal/pediatric score outputs as governed decision support.
--
-- Score FORMULAS are clinical-governance-owned (spec §3, §6.5) and are NOT
-- built here. nicu_picu_score_definitions is the owner-approval evidence
-- catalog: a score kind is usable only after an operator supplies an ACTIVE
-- definition with reference source/version and approver identity. Output rows
-- mirror the P1 icu_scoring_outputs decision-support posture: input facts,
-- score value entered by a clinician against the approved reference,
-- version/reference/reviewer slots, a fail-closed unavailable lane, and a
-- hard CHECK that these rows never claim order-mutation authority.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_picu_score_definitions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  score_kind VARCHAR(60) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  description TEXT,
  age_scope VARCHAR(20) NOT NULL DEFAULT 'neonatal',
  source VARCHAR(80) NOT NULL DEFAULT 'operator_supplied',
  reference_source TEXT,
  reference_version VARCHAR(80),
  reference_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by UUID,
  approved_at TIMESTAMPTZ(6),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  retired_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT nicu_picu_score_def_kind_not_blank CHECK (length(trim(score_kind)) > 0),
  CONSTRAINT nicu_picu_score_def_age_scope_check
    CHECK (age_scope IN ('neonatal', 'pediatric', 'both')),
  CONSTRAINT nicu_picu_score_def_source_check
    CHECK (source IN ('nl5_content_studio', 'operator_supplied', 'external_reference')),
  -- Activation is the owner-approval gate: no approver/reference, no active score.
  CONSTRAINT nicu_picu_score_def_approval_check
    CHECK (
      active = FALSE
      OR (
        approved_by IS NOT NULL AND approved_at IS NOT NULL
        AND reference_source IS NOT NULL AND reference_version IS NOT NULL
      )
    ),
  CONSTRAINT fk_nicu_picu_score_def_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_nicu_picu_score_def_kind_version
  ON nicu_picu_score_definitions (tenant_id, score_kind, (COALESCE(reference_version, '')));

CREATE UNIQUE INDEX IF NOT EXISTS ux_nicu_picu_score_def_active
  ON nicu_picu_score_definitions (tenant_id, score_kind)
  WHERE active = TRUE;

ALTER TABLE nicu_picu_score_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_picu_score_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_picu_score_definitions;
CREATE POLICY tenant_isolation ON nicu_picu_score_definitions
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

CREATE TABLE IF NOT EXISTS nicu_picu_scoring_outputs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  score_definition_id BIGINT REFERENCES nicu_picu_score_definitions(id) ON DELETE SET NULL,
  score_kind VARCHAR(60) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  input_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  score_value NUMERIC(8, 2),
  score_label VARCHAR(120),
  output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reference_source TEXT,
  reference_version VARCHAR(80),
  reviewer_uid UUID,
  reviewer_role VARCHAR(80),
  reviewed_at TIMESTAMPTZ(6),
  review_status VARCHAR(30) NOT NULL DEFAULT 'reviewed',
  score_available BOOLEAN NOT NULL DEFAULT TRUE,
  unavailable_reason TEXT,
  order_mutation_performed BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT nicu_picu_scoring_kind_not_blank CHECK (length(trim(score_kind)) > 0),
  CONSTRAINT nicu_picu_scoring_review_status_check
    CHECK (review_status IN ('draft', 'reviewed', 'signed', 'score_unavailable')),
  CONSTRAINT nicu_picu_scoring_no_order_mutation_check
    CHECK (order_mutation_performed = FALSE),
  -- Available scores must carry an approved definition + reference + reviewer.
  CONSTRAINT nicu_picu_scoring_reference_gate_check
    CHECK (
      score_available = FALSE
      OR (
        score_definition_id IS NOT NULL
        AND reference_source IS NOT NULL AND reference_version IS NOT NULL
        AND reviewer_uid IS NOT NULL
      )
    ),
  -- The unavailable lane documents "score unavailable" — never fallback math.
  CONSTRAINT nicu_picu_scoring_unavailable_gate_check
    CHECK (
      score_available = TRUE
      OR (
        review_status = 'score_unavailable'
        AND unavailable_reason IS NOT NULL
        AND score_value IS NULL
      )
    ),
  CONSTRAINT fk_nicu_picu_scoring_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nicu_picu_scoring_admission
  ON nicu_picu_scoring_outputs (tenant_id, icu_admission_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_nicu_picu_scoring_kind
  ON nicu_picu_scoring_outputs (tenant_id, icu_admission_id, score_kind, recorded_at DESC);

ALTER TABLE nicu_picu_scoring_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_picu_scoring_outputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_picu_scoring_outputs;
CREATE POLICY tenant_isolation ON nicu_picu_scoring_outputs
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
