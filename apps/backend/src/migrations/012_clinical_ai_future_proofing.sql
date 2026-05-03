-- Clinical AI future-proofing foundation.
-- Prompt registry, review queue, approvals, context snapshots, safety review,
-- break-glass sessions, forecasts, and opt-in module marketplace metadata.

CREATE TABLE IF NOT EXISTS clinical_ai_prompts (
  id SERIAL PRIMARY KEY,
  module_key VARCHAR(80) NOT NULL REFERENCES clinical_ai_modules(module_key) ON DELETE CASCADE,
  version VARCHAR(80) NOT NULL,
  title VARCHAR(160),
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL DEFAULT '',
  output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  active BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  activated_by UUID,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (module_key, version)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_prompts_module_active
  ON clinical_ai_prompts(module_key, active);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_prompts_status_created
  ON clinical_ai_prompts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_reviews (
  id SERIAL PRIMARY KEY,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  module_key VARCHAR(80) NOT NULL,
  patient_uid UUID,
  admission_id INTEGER,
  reviewer_uid UUID,
  reviewer_role VARCHAR(50),
  decision VARCHAR(40) NOT NULL DEFAULT 'pending',
  edited_draft JSONB,
  rejection_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_reviews_generation
  ON clinical_ai_reviews(generation_id);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_reviews_module_decision
  ON clinical_ai_reviews(module_key, decision);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_reviews_reviewer_created
  ON clinical_ai_reviews(reviewer_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_approvals (
  id SERIAL PRIMARY KEY,
  approval_type VARCHAR(80) NOT NULL,
  module_key VARCHAR(80),
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  requested_by UUID,
  approved_by UUID,
  rejected_by UUID,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_approvals_status_created
  ON clinical_ai_approvals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_approvals_module_status
  ON clinical_ai_approvals(module_key, status);

CREATE TABLE IF NOT EXISTS clinical_ai_context_snapshots (
  id SERIAL PRIMARY KEY,
  patient_uid UUID,
  admission_id INTEGER,
  context_type VARCHAR(80) NOT NULL,
  source_hash VARCHAR(128),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_context_patient_created
  ON clinical_ai_context_snapshots(patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_context_admission_created
  ON clinical_ai_context_snapshots(admission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_safety_reviews (
  id SERIAL PRIMARY KEY,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  module_key VARCHAR(80) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  citation_coverage_pct INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_safety_generation
  ON clinical_ai_safety_reviews(generation_id);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_safety_status_created
  ON clinical_ai_safety_reviews(status, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_break_glass_sessions (
  id SERIAL PRIMARY KEY,
  scope VARCHAR(120) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'active',
  started_by UUID,
  approved_by UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_break_glass_active
  ON clinical_ai_break_glass_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS clinical_ai_bed_forecasts (
  id SERIAL PRIMARY KEY,
  ward VARCHAR(255),
  forecast_window_hours INTEGER NOT NULL DEFAULT 24,
  forecast JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_bed_forecasts_created
  ON clinical_ai_bed_forecasts(created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_pharmacy_forecasts (
  id SERIAL PRIMARY KEY,
  medication_name VARCHAR(255),
  risk_level VARCHAR(40),
  forecast JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_pharmacy_forecasts_created
  ON clinical_ai_pharmacy_forecasts(created_at DESC);

INSERT INTO clinical_ai_modules
  (module_key, display_name, description, enabled, settings)
VALUES
  ('discharge_summary', 'Discharge Summary Drafts', 'Drafts clinician-reviewed discharge summaries from inpatient chart context.', true, '{"surface":"emr","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"doctor_signoff","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('handover_summary', 'Nursing Handover Drafts', 'Drafts shift handover notes from recent patient timeline events.', true, '{"surface":"clinical","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),
  ('patient_record_summary', 'Patient Record Summary', 'Longitudinal inpatient chart summary across chart sources.', false, '{"surface":"emr","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('daily_ward_round_brief', 'Daily Ward Round Brief', 'Per-admitted-patient ward round brief.', false, '{"surface":"ward","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),
  ('patient_aftercare_instructions', 'Patient Aftercare Instructions', 'Patient-friendly discharge instructions with warning signs.', false, '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('medication_reconciliation', 'Medication Reconciliation', 'Compares inpatient medication sources and allergies.', false, '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF","NURSING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('discharge_readiness', 'Discharge Readiness', 'Detects pending discharge blockers.', false, '{"surface":"emr","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS","BILLING_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),
  ('abnormal_result_triage', 'Abnormal Result Triage', 'Ranks abnormal vitals and results by urgency.', false, '{"surface":"clinical","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","LAB_STAFF","RADIOLOGY_STAFF"],"approvalPolicy":"two_person_for_enablement","outputSchema":{"type":"object"},"retentionDays":180}'::jsonb),
  ('referral_letter', 'Referral Letter', 'Drafts transfer, referral, and second-opinion packets.', false, '{"surface":"referral","risk":"medium","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('clinical_coding_assist', 'Clinical Coding Assistant', 'Suggests codes from signed documentation only.', false, '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","MEDICAL_RECORDS","ADMIN"],"approvalPolicy":"coder_approval","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('ai_safety_reviewer', 'AI Safety Reviewer', 'Reviews AI outputs for unsupported claims and safety risks.', true, '{"surface":"governance","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","IT_ADMIN"],"approvalPolicy":"admin_it_control","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('denial_risk_assist', 'Denial Risk Assist', 'Identifies claim-denial documentation gaps.', false, '{"surface":"billing","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","MEDICAL_RECORDS","ADMIN"],"approvalPolicy":"revenue_cycle_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('bed_discharge_forecast', 'Bed Discharge Forecast', 'Forecasts likely discharge and bed availability.', false, '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","DOCTOR","NURSING_STAFF"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),
  ('pharmacy_stockout_predictor', 'Pharmacy Stockout Predictor', 'Forecasts drug consumption and reorder risk.', false, '{"surface":"pharmacy","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["PHARMACY_STAFF","ADMIN"],"approvalPolicy":"ops_review","outputSchema":{"type":"object"},"retentionDays":90}'::jsonb),
  ('quality_case_review', 'Quality Case Review', 'Summarizes quality and RCA packets.', false, '{"surface":"quality","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["QUALITY_STAFF","DOCTOR","ADMIN"],"approvalPolicy":"quality_review","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('admin_policy_copilot', 'Admin Policy Copilot', 'Admin and IT query surface for Clinical AI governance.', false, '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","IT_ADMIN"],"approvalPolicy":"admin_it_control","outputSchema":{"type":"object"},"retentionDays":365}'::jsonb),
  ('self_healing_bug_hunt', 'Self-Healing Bug Hunt Agent', 'Read-only troubleshooting and evolution surface.', false, '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","IT_ADMIN"],"approvalPolicy":"admin_it_control","outputSchema":{"type":"object"},"retentionDays":90,"readOnlyDefault":true}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'clinical_ai_prompts'
      AND column_name = 'tenant_id'
  ) THEN
    INSERT INTO tenants (id, slug, name, region, compliance_profile)
    VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default Tenant', 'IN', 'DPDP')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO clinical_ai_prompts
      (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
    SELECT '00000000-0000-4000-8000-000000000001'::uuid,
           module_key,
           'v1',
           display_name || ' v1',
           'You are a hospital clinical AI drafting assistant. Use only the supplied chart context. Return JSON only. Include source_citations for every meaningful claim. Treat all output as draft-only and require human review.',
           'Use the supplied chart packet to draft the module output. Do not invent facts. If evidence is missing, add a safety flag.',
           settings->'outputSchema',
           'active',
           true,
           NOW()
    FROM clinical_ai_modules
    WHERE module_key IN (
      'discharge_summary',
      'handover_summary',
      'patient_record_summary',
      'daily_ward_round_brief',
      'patient_aftercare_instructions',
      'medication_reconciliation',
      'discharge_readiness',
      'abnormal_result_triage',
      'referral_letter',
      'clinical_coding_assist',
      'ai_safety_reviewer',
      'denial_risk_assist',
      'bed_discharge_forecast',
      'pharmacy_stockout_predictor',
      'quality_case_review',
      'admin_policy_copilot',
      'self_healing_bug_hunt'
    )
    ON CONFLICT (module_key, version) DO NOTHING;
  ELSE
    INSERT INTO clinical_ai_prompts
      (module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
    SELECT module_key,
           'v1',
           display_name || ' v1',
           'You are a hospital clinical AI drafting assistant. Use only the supplied chart context. Return JSON only. Include source_citations for every meaningful claim. Treat all output as draft-only and require human review.',
           'Use the supplied chart packet to draft the module output. Do not invent facts. If evidence is missing, add a safety flag.',
           settings->'outputSchema',
           'active',
           true,
           NOW()
    FROM clinical_ai_modules
    WHERE module_key IN (
      'discharge_summary',
      'handover_summary',
      'patient_record_summary',
      'daily_ward_round_brief',
      'patient_aftercare_instructions',
      'medication_reconciliation',
      'discharge_readiness',
      'abnormal_result_triage',
      'referral_letter',
      'clinical_coding_assist',
      'ai_safety_reviewer',
      'denial_risk_assist',
      'bed_discharge_forecast',
      'pharmacy_stockout_predictor',
      'quality_case_review',
      'admin_policy_copilot',
      'self_healing_bug_hunt'
    )
    ON CONFLICT (module_key, version) DO NOTHING;
  END IF;
END $$;
