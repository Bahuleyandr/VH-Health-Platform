-- AI ROI Dashboard.
--
-- Periodic snapshots of realized AI ROI: time saved, documentation hours
-- saved, denial value prevented, and cost per useful draft, aggregated from
-- clinical_ai_generations, clinical_ai_reviews, module-specific review
-- tables (appeal letters, antimicrobial, teach-back, etc.), and
-- clinical_ai_prior_auth_requests. Snapshots are computed on-demand
-- (admin UI) or by a scheduled job; they are read-only records and do not
-- drive any clinical decision.

CREATE TABLE IF NOT EXISTS clinical_ai_roi_snapshots (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  period_days INTEGER NOT NULL DEFAULT 30
    CHECK (period_days BETWEEN 1 AND 365),
  module_key VARCHAR(80) NOT NULL DEFAULT 'ALL',
  generation_count INTEGER NOT NULL DEFAULT 0,
  ai_generation_count INTEGER NOT NULL DEFAULT 0,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  edited_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_minor INTEGER NOT NULL DEFAULT 0,
  acceptance_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  time_saved_minutes INTEGER NOT NULL DEFAULT 0,
  documentation_hours_saved NUMERIC(10,2) NOT NULL DEFAULT 0,
  denial_value_prevented_minor BIGINT NOT NULL DEFAULT 0,
  prior_auth_approved_count INTEGER NOT NULL DEFAULT 0,
  appeal_approved_count INTEGER NOT NULL DEFAULT 0,
  cost_per_useful_draft_minor NUMERIC(12,2) NOT NULL DEFAULT 0,
  by_module JSONB NOT NULL DEFAULT '[]'::jsonb,
  highlights JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_roi_snapshots_tenant_computed
  ON clinical_ai_roi_snapshots (tenant_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_roi_snapshots_tenant_module
  ON clinical_ai_roi_snapshots (tenant_id, module_key, computed_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('ai_roi_dashboard',
   'AI ROI Dashboard',
   'Aggregates realized AI ROI — time saved per accepted draft, documentation hours saved, denial value prevented via appeal/prior-auth approvals, and cost per useful draft — from existing clinical AI tables. Read-only; never alters clinical decisions or billing.',
   true,
   '{"surface":"governance","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":false,"reviewRoles":["ADMIN","SUPER_ADMIN","IT_ADMIN","FINANCE_STAFF"],"approvalPolicy":"admin_readonly","outputSchema":{"type":"object","required":["generation_count","accepted_count","time_saved_minutes","cost_per_useful_draft_minor"]},"retentionDays":1825,"readOnlyDefault":true,"decisionSupportOnly":true,"moduleTimeSavedMinutes":{"discharge_summary":18,"handover_summary":10,"patient_record_summary":12,"clinical_task_extractor":8,"daily_ward_round_brief":15,"patient_aftercare_instructions":15,"medication_reconciliation":12,"antimicrobial_stewardship":10,"discharge_readiness":8,"abnormal_result_triage":6,"referral_letter":15,"clinical_coding_assist":7,"ai_safety_reviewer":2,"denial_risk_assist":6,"bed_discharge_forecast":5,"pharmacy_stockout_predictor":5,"quality_case_review":12,"admin_policy_copilot":3,"self_healing_bug_hunt":4,"soap_from_dictation":15,"patient_communication_translation":8,"abdm_longitudinal_risk":4,"appointment_no_show_predictor":2,"ot_case_time_predictor":3,"charge_capture_audit":5,"deterioration_early_warning":3,"polypharmacy_ai_review":8,"clinical_trial_matcher":10,"patient_record_chatbot":3,"rca_draft_generator":20,"prior_authorization_generator":25,"radiology_ai_interpretation":12,"document_intelligence_ocr":10,"chart_completion_auditor":8,"consent_phi_policy_sentinel":4,"infection_control_sentinel":10,"sepsis_bundle_sentinel":12,"virtual_ward_triage":5,"ambient_visit_documentation":20,"staff_roster_optimizer":25,"appeal_letter_generator":30,"patient_teach_back_comprehension":7}}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  enabled = true,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
