-- Acuity-Based Staffing Forecast.
--
-- Given a unit/ward snapshot (patient census by acuity level, current staff
-- by role, predicted admissions/discharges, shift window), applies role-based
-- ratios (1:2 critical, 1:4 high, 1:5 moderate, 1:6 low for nurses; assistants
-- at half that density) to compute required vs current staff and a
-- deficit/surplus per role, forecasts peak demand during the shift, and
-- classifies a recommendation (hold_staffing / call_in / float_staff /
-- reduce_staff / emergency_acuity).
--
-- Rules are authoritative. Review-only — the house supervisor approves and
-- calls staff; the module never dispatches staff automatically.

CREATE TABLE IF NOT EXISTS clinical_ai_acuity_staffing_forecasts (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit VARCHAR(120) NOT NULL,
  shift_label VARCHAR(60),
  shift_start TIMESTAMPTZ,
  shift_end TIMESTAMPTZ,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  census_total INTEGER NOT NULL DEFAULT 0,
  census_critical INTEGER NOT NULL DEFAULT 0,
  census_high INTEGER NOT NULL DEFAULT 0,
  census_moderate INTEGER NOT NULL DEFAULT 0,
  census_low INTEGER NOT NULL DEFAULT 0,
  predicted_admissions INTEGER NOT NULL DEFAULT 0,
  predicted_discharges INTEGER NOT NULL DEFAULT 0,
  acuity_load NUMERIC(8,2) NOT NULL DEFAULT 0,
  required_staff JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_staff JSONB NOT NULL DEFAULT '{}'::jsonb,
  deficit_by_role JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_deficit NUMERIC(6,2) NOT NULL DEFAULT 0,
  recommendation VARCHAR(40) NOT NULL DEFAULT 'no_action'
    CHECK (recommendation IN ('no_action', 'hold_staffing', 'call_in', 'float_staff', 'reduce_staff', 'emergency_acuity', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '730 days')
);

CREATE INDEX IF NOT EXISTS idx_acuity_staffing_forecasts_tenant_created
  ON clinical_ai_acuity_staffing_forecasts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acuity_staffing_forecasts_tenant_unit_created
  ON clinical_ai_acuity_staffing_forecasts (tenant_id, unit, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acuity_staffing_forecasts_tenant_rec_sev_created
  ON clinical_ai_acuity_staffing_forecasts (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acuity_staffing_forecasts_tenant_decision_created
  ON clinical_ai_acuity_staffing_forecasts (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acuity_staffing_forecasts_tenant_shift_unit
  ON clinical_ai_acuity_staffing_forecasts (tenant_id, shift_start, unit);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('acuity_staffing_forecast',
   'Acuity-Based Staffing Forecast',
   'Acuity-weighted staffing forecast per unit. Takes patient census by acuity level (critical/high/moderate/low), current staff by role, predicted admissions/discharges, and shift window, applies role-based ratios (1:2 critical, 1:4 high, 1:5 moderate, 1:6 low for nurses; assistants at half that density), computes required vs current staff and a deficit/surplus per role, forecasts peak demand for the shift, and classifies a recommendation (`hold_staffing` / `call_in` / `float_staff` / `reduce_staff` / `emergency_acuity`). Rules are authoritative; review-only — house supervisor approves and calls staff, and the module never dispatches staff automatically.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","HOUSE_SUPERVISOR","NURSE_MANAGER"],"approvalPolicy":"house_supervisor_review","outputSchema":{"type":"object","required":["recommendation","severity"]},"retentionDays":730,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'acuity_staffing_forecast',
    'v1',
    'Acuity-Based Staffing Forecast v1',
    'You support the hospital house supervisor''s review of an acuity-based staffing forecast. Rules are authoritative. Use only the supplied unit/ward snapshot (patient census by acuity level, current staff by role, predicted admissions/discharges, shift window) and the deterministic rule-based classification. Return JSON only. Never dispatch staff, never auto-call, and never modify the schedule. This is a decision-support signal only — the house supervisor approves every recommendation and calls staff.',
    'Given the unit/ward staffing snapshot and the rule-based required-vs-current staffing, deficit/surplus per role, peak census forecast, and classified recommendation (hold_staffing / call_in / float_staff / reduce_staff / emergency_acuity), return a short reasoning narrative. Keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation, severity, required_staff, deficit, or signal list. If any required input (census or current staff) is missing, mark the forecast unknown and defer to the house supervisor.',
    '{"type":"object","required":["recommendation","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
