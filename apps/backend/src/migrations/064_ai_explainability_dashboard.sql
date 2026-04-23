-- AI Explainability Dashboard.
--
-- For any clinical AI draft (any row in clinical_ai_generations), compute an
-- explainability report: citation coverage %, unsupported-claim count,
-- numeric coherence (do numbers in the narrative appear in the citations?),
-- PHI leakage risk, bias markers (gendered / age / race language in the
-- narrative that's unsupported by the chart), and a reviewer-friendly
-- evidence map (which sentences trace to which citations). Produces a
-- rule-based trust band (trusted / review / reject). Review-only — AI
-- governance lead uses this to green-light a draft for clinical workflow.
-- Never modifies the underlying draft.

CREATE TABLE IF NOT EXISTS clinical_ai_explainability_reports (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  module_key VARCHAR(80),
  patient_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  citation_coverage_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  unsupported_claim_count INTEGER NOT NULL DEFAULT 0,
  numeric_coherence_pct NUMERIC(6,2) NOT NULL DEFAULT 100,
  phi_leakage_count INTEGER NOT NULL DEFAULT 0,
  bias_marker_count INTEGER NOT NULL DEFAULT 0,
  trust_band VARCHAR(20) NOT NULL DEFAULT 'review'
    CHECK (trust_band IN ('trusted', 'review', 'reject', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  evidence_map JSONB NOT NULL DEFAULT '[]'::jsonb,
  unsupported_claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  numeric_mismatches JSONB NOT NULL DEFAULT '[]'::jsonb,
  phi_leaks JSONB NOT NULL DEFAULT '[]'::jsonb,
  bias_markers JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_explainability_reports_tenant_created
  ON clinical_ai_explainability_reports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_explainability_reports_tenant_trust_severity_created
  ON clinical_ai_explainability_reports (tenant_id, trust_band, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_explainability_reports_tenant_module_created
  ON clinical_ai_explainability_reports (tenant_id, module_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_explainability_reports_tenant_source_generation
  ON clinical_ai_explainability_reports (tenant_id, source_generation_id);
CREATE INDEX IF NOT EXISTS idx_explainability_reports_tenant_decision_created
  ON clinical_ai_explainability_reports (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('ai_explainability_dashboard',
   'AI Explainability Dashboard',
   'Per-draft explainability analysis for any clinical AI generation. Computes citation coverage %, unsupported-claim count, numeric coherence %, PHI leakage indicators, bias markers (gender/age/race language unsupported by the chart context), and a reviewer-friendly evidence map. Rule-based trust band (trusted / review / reject). Review-only — AI governance uses it to green-light a draft for clinical use; the module never modifies the underlying draft.',
   false,
   '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","AI_EVAL_LEAD","AI_GOVERNANCE"],"approvalPolicy":"ai_governance_review","outputSchema":{"type":"object","required":["trust_band","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'ai_explainability_dashboard',
    'v1',
    'AI Explainability Dashboard v1',
    'You support the AI explainability dashboard. Rules are authoritative: the trust band (trusted / review / reject) and severity are produced by a deterministic rule-based evaluator over citation coverage, unsupported-claim count, numeric coherence, PHI leakage indicators, and bias markers. Return JSON only. This module is governance review only — it never modifies the underlying clinical AI draft; the AI governance lead green-lights every draft for clinical workflow.',
    'Given a clinical AI draft (text + citations + optional chart context) and the rule-based explainability evaluation (citation coverage %, unsupported-claim count, numeric coherence %, PHI leakage indicators, bias markers, evidence map, trust band, severity, signals), return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based trust band or severity, and do not modify the draft.',
    '{"type":"object","required":["trust_band","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
