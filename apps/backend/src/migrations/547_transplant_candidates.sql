-- NL-13 P6: transplant candidates.

CREATE TABLE IF NOT EXISTS transplant_candidates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  program_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  diagnosis TEXT NOT NULL,
  required_organs transplant_organ_type[] NOT NULL DEFAULT ARRAY[]::transplant_organ_type[],
  listing_evaluation_status VARCHAR(40) NOT NULL DEFAULT 'evaluation',
  committee_status VARCHAR(40) NOT NULL DEFAULT 'pending',
  contraindications_summary TEXT,
  related_care_plan_id INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_candidates_eval_status_check
    CHECK (listing_evaluation_status IN ('referred', 'evaluation', 'committee_review', 'approved', 'listed', 'not_eligible', 'closed')),
  CONSTRAINT transplant_candidates_committee_status_check
    CHECK (committee_status IN ('not_required', 'pending', 'approved', 'deferred', 'declined')),
  CONSTRAINT transplant_candidates_required_organs_check
    CHECK (array_length(required_organs, 1) IS NOT NULL),
  CONSTRAINT fk_transplant_candidates_program
    FOREIGN KEY (program_id) REFERENCES transplant_programs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_transplant_candidates_care_plan
    FOREIGN KEY (related_care_plan_id) REFERENCES care_plans(id) ON DELETE SET NULL,
  CONSTRAINT fk_transplant_candidates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_candidates_patient
  ON transplant_candidates (tenant_id, patient_uid, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_transplant_candidates_program_status
  ON transplant_candidates (tenant_id, program_id, listing_evaluation_status, committee_status);

ALTER TABLE transplant_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_candidates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_candidates;
CREATE POLICY tenant_isolation ON transplant_candidates
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
