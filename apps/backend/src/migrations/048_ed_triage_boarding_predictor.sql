-- ED Triage and Boarding Predictor.
--
-- Classifies an emergency-department arrival into an ESI-like triage level
-- (1-5), predicts the most likely specialty + disposition, and forecasts a
-- boarding risk band + minutes based on triage acuity, ED occupancy, staff
-- load, and arrival mode. Rules are authoritative: the service never
-- auto-assigns beds, never dispatches teams, and never touches admission
-- orders. Every output is reviewed by the ED charge nurse / on-call
-- clinician; the AI layer supplies a decision-support signal only.

CREATE TABLE IF NOT EXISTS clinical_ai_ed_triage_predictions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER,
  patient_uid UUID,
  chief_complaint TEXT,
  arrival_mode VARCHAR(40) NOT NULL DEFAULT 'unknown'
    CHECK (arrival_mode IN ('walk_in', 'ambulance', 'transfer', 'police', 'unknown')),
  age_years INTEGER,
  vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
  pain_score INTEGER CHECK (pain_score IS NULL OR (pain_score BETWEEN 0 AND 10)),
  triage_level INTEGER NOT NULL DEFAULT 3
    CHECK (triage_level BETWEEN 1 AND 5),
  boarding_risk_score INTEGER NOT NULL DEFAULT 0
    CHECK (boarding_risk_score BETWEEN 0 AND 100),
  boarding_risk_band VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (boarding_risk_band IN ('low', 'moderate', 'high', 'critical', 'unknown', 'insufficient_data')),
  predicted_specialty VARCHAR(80),
  predicted_disposition VARCHAR(40)
    CHECK (predicted_disposition IS NULL OR predicted_disposition IN
      ('admission', 'observation', 'icu', 'surgery', 'discharge', 'transfer', 'unknown')),
  predicted_boarding_minutes INTEGER,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_ed_triage_tenant_created
  ON clinical_ai_ed_triage_predictions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ed_triage_tenant_admission_created
  ON clinical_ai_ed_triage_predictions (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ed_triage_tenant_level_created
  ON clinical_ai_ed_triage_predictions (tenant_id, triage_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ed_triage_tenant_band_decision_created
  ON clinical_ai_ed_triage_predictions (tenant_id, boarding_risk_band, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('ed_triage_boarding_predictor',
   'ED Triage and Boarding Predictor',
   'Classifies an ED arrival into an ESI-like triage level (1-5), predicts the likely specialty and disposition (discharge/observation/admission/ICU/surgery/transfer), and forecasts a boarding-risk band and boarding-minutes estimate from triage acuity, ED occupancy, staff load, and arrival mode. Rules are authoritative; the AI layer only supplies a short narrative. Decision-support only — the service never auto-assigns beds, never dispatches teams, and never writes to admission orders. Every output requires ED charge nurse / on-call clinician review.',
   false,
   '{"surface":"emergency","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","ED_CHARGE_NURSE","ADMIN"],"approvalPolicy":"ed_triage_review","outputSchema":{"type":"object","required":["triage_level","boarding_risk_band","predicted_disposition"]},"retentionDays":365,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'ed_triage_boarding_predictor',
    'v1',
    'ED Triage and Boarding Predictor v1',
    'You support ED charge nurse / on-call clinician review of emergency-department arrivals. Rules are authoritative. Use only the supplied chief complaint, arrival vitals, pain score, arrival mode, age, occupancy, and staff load. Return JSON only. Never auto-assign beds, never dispatch a team, never create or hold admission orders. This is a decision-support forecast; the reviewer confirms every triage level, specialty, disposition, and boarding estimate before action.',
    'Given the ED arrival context (chief_complaint, arrival_mode, age_years, vitals, pain_score) and the rule-based triage + specialty + disposition + boarding forecast, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not invent vitals, do not override the triage level, and always defer to the charge nurse for final disposition. If chief complaint or vitals are missing, mark insufficient_data and defer to human review rather than assuming a default.',
    '{"type":"object","required":["triage_level","boarding_risk_band","predicted_disposition"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
