-- Infection Control Sentinel.
--
-- Decision-support surface for infection prevention and antimicrobial
-- stewardship. It highlights likely HAI/isolation risks from cited chart
-- signals, but never places isolation orders, changes antibiotics, or mutates
-- clinical state.

CREATE TABLE IF NOT EXISTS clinical_ai_infection_control_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL,
  patient_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'medium', 'high', 'critical', 'unknown')),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  stewardship_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  isolation_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'acknowledged', 'escalated', 'dismissed')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infection_control_tenant_created
  ON clinical_ai_infection_control_audits (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infection_control_admission
  ON clinical_ai_infection_control_audits (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infection_control_patient
  ON clinical_ai_infection_control_audits (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infection_control_review
  ON clinical_ai_infection_control_audits (tenant_id, reviewer_decision, risk_band, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('infection_control_sentinel',
   'Infection Control Sentinel',
   'Flags possible HAI, isolation, culture, and antimicrobial-stewardship risks from cited inpatient chart evidence for infection-control review.',
   false,
   '{"surface":"infection_control","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["INFECTION_CONTROL","DOCTOR","NURSING_STAFF","PHARMACIST","ADMIN"],"approvalPolicy":"infection_control_review","outputSchema":{"type":"object","required":["risk_score","risk_band","signals","recommendations"]},"retentionDays":3650}'::jsonb)
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
    'infection_control_sentinel',
    'v1',
    'Infection Control Sentinel v1',
    'You support infection prevention and antimicrobial stewardship. Use only supplied chart evidence and deterministic rule signals. Return JSON only. Never claim a confirmed infection without cited evidence, and never recommend automatic orders.',
    'Given the chart packet and rule-based infection-control findings, return keys: risk_score, risk_band, signals, recommendations, stewardship_flags, isolation_flags, summary, source_citations, safety_flags.',
    '{"type":"object","required":["risk_score","risk_band","signals","recommendations"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
