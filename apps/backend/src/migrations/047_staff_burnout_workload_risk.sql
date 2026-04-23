-- Staff Burnout / Workload Risk Predictor.
--
-- Analyzes staff workload patterns (shifts, overtime, night streaks, PTO
-- usage, weekend loading) over a rolling window and produces a reviewable
-- burnout risk signal. Privacy-sensitive: this is a workload signal only,
-- never an evaluation/disciplinary tool. HR/leadership reviews every
-- output; the service never auto-actions, changes rosters, or annotates
-- performance records. Rules are authoritative.

CREATE TABLE IF NOT EXISTS clinical_ai_staff_burnout_reviews (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_uid UUID NOT NULL,
  department VARCHAR(120),
  role VARCHAR(80),
  window_days INTEGER NOT NULL DEFAULT 30
    CHECK (window_days BETWEEN 1 AND 365),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  total_hours NUMERIC(10, 2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(10, 2) NOT NULL DEFAULT 0,
  night_shift_count INTEGER NOT NULL DEFAULT 0,
  consecutive_night_shifts INTEGER NOT NULL DEFAULT 0,
  weekend_shift_count INTEGER NOT NULL DEFAULT 0,
  pto_days_taken NUMERIC(6, 2) NOT NULL DEFAULT 0,
  avg_hours_per_week NUMERIC(6, 2) NOT NULL DEFAULT 0,
  risk_score INTEGER NOT NULL DEFAULT 0
    CHECK (risk_score BETWEEN 0 AND 100),
  risk_band VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'moderate', 'high', 'critical', 'unknown', 'insufficient_data')),
  contributing_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'escalated')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '730 days')
);

CREATE INDEX IF NOT EXISTS idx_staff_burnout_tenant_created
  ON clinical_ai_staff_burnout_reviews (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_burnout_tenant_staff_created
  ON clinical_ai_staff_burnout_reviews (tenant_id, staff_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_burnout_tenant_band_decision_created
  ON clinical_ai_staff_burnout_reviews (tenant_id, risk_band, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_burnout_tenant_department_created
  ON clinical_ai_staff_burnout_reviews (tenant_id, department, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('staff_burnout_workload_risk',
   'Staff Burnout / Workload Risk Predictor',
   'Analyzes rolling workload patterns (total + overtime hours, consecutive night shifts, weekend loading, PTO utilization) and produces a reviewable burnout risk signal. Privacy-sensitive: workload risk signal only — never used for performance evaluation or disciplinary action. HR/leadership review every output; the service never auto-actions, never adjusts rosters, and never writes to personnel records.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","SUPER_ADMIN","HR_STAFF","DEPARTMENT_HEAD"],"approvalPolicy":"hr_review","outputSchema":{"type":"object","required":["risk_score","risk_band","contributing_signals"]},"retentionDays":730,"rulesAuthoritative":true,"decisionSupportOnly":true,"privacyNote":"Workload risk signal only — never used for performance evaluation or disciplinary action."}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

INSERT INTO clinical_ai_prompts
  (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'staff_burnout_workload_risk',
    'v1',
    'Staff Burnout / Workload Risk Predictor v1',
    'You support HR/leadership review of staff workload patterns. Rules are authoritative. Use only the supplied workload summary (shifts, hours, PTO). Return JSON only. This is a workload risk signal — never a performance evaluation, never a disciplinary tool. Do not recommend any action that affects compensation, employment status, or the staff member''s record. Always include the privacy reminder and defer to human review.',
    'Given the rolling workload summary (window_days, total_hours, overtime_hours, night_shift_count, consecutive_night_shifts, weekend_shift_count, pto_days_taken, avg_hours_per_week) and the rule-based burnout signals, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Keep recommendations supportive and workload-focused (schedule balancing, PTO encouragement, wellness check-in). Do not invent signals that are not in the supplied data. If shift data is missing, defer to human review rather than assuming a default.',
    '{"type":"object","required":["risk_score","risk_band","contributing_signals"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
