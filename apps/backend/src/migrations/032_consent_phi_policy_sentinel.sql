-- Consent & PHI Policy Sentinel.
--
-- Governance surface that reviews AI generation records for consent, external
-- provider, citation, and review-policy risks. Decision-support only: it never
-- edits patient records, providers, prompts, or module settings.

CREATE TABLE IF NOT EXISTS clinical_ai_privacy_sentinel_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE CASCADE,
  patient_uid UUID,
  module_key VARCHAR(80),
  provider VARCHAR(80),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'medium', 'high', 'critical', 'unknown')),
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_decision VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'acknowledged', 'escalated', 'dismissed')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_privacy_sentinel_tenant_created
  ON clinical_ai_privacy_sentinel_audits (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_sentinel_risk
  ON clinical_ai_privacy_sentinel_audits (tenant_id, risk_band, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_sentinel_module
  ON clinical_ai_privacy_sentinel_audits (tenant_id, module_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_sentinel_patient
  ON clinical_ai_privacy_sentinel_audits (tenant_id, patient_uid, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('consent_phi_policy_sentinel',
   'Consent & PHI Policy Sentinel',
   'Audits AI generations for active consent, external-provider boundaries, PHI exposure, missing citations, safety flags, and stale human review.',
   false,
   '{"surface":"governance","risk":"critical","status":"available","requiresClinicianSignoff":false,"requiresCitations":false,"reviewRoles":["ADMIN","SUPER_ADMIN","IT_ADMIN","COMPLIANCE_OFFICER"],"approvalPolicy":"privacy_governance_review","outputSchema":{"type":"object","required":["risk_score","risk_band","findings","consent_snapshot"]},"retentionDays":3650}'::jsonb)
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
    'consent_phi_policy_sentinel',
    'v1',
    'Consent & PHI Policy Sentinel v1',
    'You are a privacy governance reviewer. Treat deterministic consent and PHI policy checks as authoritative. Return structured findings only.',
    'Review AI generation metadata for consent, external-provider, PHI, citation, safety, and stale-review risks. Do not change production settings.',
    '{"type":"object","required":["risk_score","risk_band","findings","consent_snapshot"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
