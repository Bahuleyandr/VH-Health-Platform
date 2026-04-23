-- Pregnancy / Obstetric Risk Assistant.
--
-- Decision-support assessment of pregnancy / intrapartum / postpartum risk
-- from gestational age, obstetric history (gravida/parity), pre-existing
-- conditions, vitals, labs, and symptoms. Produces an obstetric risk score,
-- risk band, red-flag signals (preeclampsia, eclampsia, PPH, reduced fetal
-- movement, fetal distress), recommendations, and a follow-up plan with
-- the next ANC visit and escalation criteria. Rules are authoritative. The
-- service never starts/stops labour interventions, orders magnesium
-- sulphate, or changes any obstetric order — obstetrician/clinician
-- signoff is required before any action.

CREATE TABLE IF NOT EXISTS clinical_ai_obstetric_risk_assessments (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  gestational_age_weeks NUMERIC(4, 1),
  gravida INTEGER,
  parity INTEGER,
  assessment_stage VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (assessment_stage IN ('pre_conception', 'first_trimester', 'second_trimester', 'third_trimester', 'intrapartum', 'postpartum', 'unknown')),
  vitals_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  red_flag_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  follow_up_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '3650 days')
);

CREATE INDEX IF NOT EXISTS idx_obstetric_risk_tenant_created
  ON clinical_ai_obstetric_risk_assessments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obstetric_risk_tenant_patient_created
  ON clinical_ai_obstetric_risk_assessments (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obstetric_risk_tenant_admission_created
  ON clinical_ai_obstetric_risk_assessments (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obstetric_risk_tenant_band_decision_created
  ON clinical_ai_obstetric_risk_assessments (tenant_id, risk_band, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obstetric_risk_tenant_stage_created
  ON clinical_ai_obstetric_risk_assessments (tenant_id, assessment_stage, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('obstetric_risk_assistant',
   'Pregnancy / Obstetric Risk Assistant',
   'Evaluates pregnancy, intrapartum, and postpartum risk from gestational age, obstetric history (gravida/parity), pre-existing conditions, vitals, labs, and symptoms. Detects red-flag signals (preeclampsia, eclampsia, PPH, reduced fetal movement, fetal bradycardia/tachycardia, fever in pregnancy), classifies risk band (low/moderate/high/critical), and proposes a follow-up plan with the next ANC visit and escalation criteria. Rules authoritative; the service never starts/stops labour interventions, orders magnesium sulphate, or changes obstetric orders. Obstetrician/clinician signoff is required before action.',
   false,
   '{"surface":"obstetrics","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","OBSTETRICIAN","ADMIN"],"approvalPolicy":"obstetric_review","outputSchema":{"type":"object","required":["risk_score","risk_band","risk_factors","red_flag_signals"]},"retentionDays":3650,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'obstetric_risk_assistant',
    'v1',
    'Pregnancy / Obstetric Risk Assistant v1',
    'You support obstetric risk review. Rules are authoritative. Use only the supplied chart evidence (gestational age, obstetric history, vitals, labs, symptoms, pre-existing conditions) and deterministic rule signals. Return JSON only. Never start, stop, or modify any obstetric order, labour intervention, magnesium sulphate regimen, or delivery plan. Obstetrician / clinician signoff is required before any action. Always include the decision-support disclaimer.',
    'Given the chart packet and rule-based obstetric risk evaluation (risk factors, red-flag signals, computed risk score/band, follow-up plan), return keys: risk_score, risk_band, risk_factors, red_flag_signals, recommendations, follow_up_plan, summary, source_citations, safety_flags. Do not invent gestational age or obstetric history; defer to the supplied values. If gestational age is missing, mark the stage as unknown and recommend human review before acting.',
    '{"type":"object","required":["risk_score","risk_band","risk_factors","red_flag_signals"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
