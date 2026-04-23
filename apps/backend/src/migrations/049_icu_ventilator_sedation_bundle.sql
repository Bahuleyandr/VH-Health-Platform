-- ICU Ventilator / Sedation Bundle Reviewer.
--
-- Decision-support audit of VAP bundle compliance, sedation assessment
-- (RASS/CAM-ICU), and SBT readiness for mechanically-ventilated ICU
-- admissions. Rules are authoritative. This module never changes
-- ventilator settings, stops sedation, orders extubation, or mutates
-- any clinical order. ICU team / pulmonologist signoff is required
-- before any action is taken on its recommendations.

CREATE TABLE IF NOT EXISTS clinical_ai_ventilator_bundle_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL,
  patient_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  ventilator_status VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (ventilator_status IN ('not_ventilated', 'ventilated', 'weaning', 'extubated', 'unknown')),
  ventilator_days INTEGER NOT NULL DEFAULT 0,
  compliance_score INTEGER NOT NULL DEFAULT 0
    CHECK (compliance_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  vap_bundle JSONB NOT NULL DEFAULT '{}'::jsonb,
  sedation_assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
  sbt_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  bundle_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
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

CREATE INDEX IF NOT EXISTS idx_vent_bundle_tenant_created
  ON clinical_ai_ventilator_bundle_audits (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vent_bundle_tenant_admission_created
  ON clinical_ai_ventilator_bundle_audits (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vent_bundle_tenant_status_created
  ON clinical_ai_ventilator_bundle_audits (tenant_id, ventilator_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vent_bundle_tenant_band_decision_created
  ON clinical_ai_ventilator_bundle_audits (tenant_id, risk_band, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('icu_ventilator_sedation_bundle',
   'ICU Ventilator / Sedation Bundle Reviewer',
   'Audits VAP bundle compliance (HOB elevation, oral care, sedation interruption, DVT/PUD prophylaxis, subglottic suction), sedation assessment (RASS, CAM-ICU delirium screen), and SBT readiness (FiO2, PEEP, hemodynamic stability, oxygenation) for mechanically-ventilated ICU admissions. Rules are authoritative; this module never changes ventilator settings, stops sedation, orders extubation, or writes clinical orders. ICU team / pulmonologist signoff required before action.',
   false,
   '{"surface":"icu","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","ICU_TEAM","PULMONOLOGIST","ADMIN"],"approvalPolicy":"icu_bundle_review","outputSchema":{"type":"object","required":["compliance_score","risk_band","vap_bundle","bundle_gaps"]},"retentionDays":3650,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'icu_ventilator_sedation_bundle',
    'v1',
    'ICU Ventilator / Sedation Bundle Reviewer v1',
    'You support ICU ventilator/sedation bundle review. Rules are authoritative. Use only the supplied chart evidence (vitals, ventilator settings, sedation scores, notes, orders) and deterministic rule signals. Return JSON only. Never order extubation, stop sedation, change ventilator settings, or modify any clinical order. ICU team / pulmonologist signoff is required before any action.',
    'Given the chart packet and rule-based ventilator/sedation bundle audit, return keys: compliance_score, risk_band, vap_bundle, sedation_assessment, sbt_readiness, bundle_gaps, recommendations, summary, source_citations, safety_flags. Do not invent bundle components that are not in the supplied data. If ventilator status is unknown, defer to the rule-based evaluation.',
    '{"type":"object","required":["compliance_score","risk_band","vap_bundle","bundle_gaps"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
