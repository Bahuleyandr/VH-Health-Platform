-- Model Registry and Evaluation Workbench.
--
-- Central registry of every AI model variant the platform uses (name,
-- version, provider, lineage, purpose, owner, lifecycle stage) plus an
-- eval-run log capturing accuracy, F1, average latency, fallback rate,
-- safety-flag rate, and drift score per canary or regression suite.
-- Rules are authoritative for recommending a lifecycle action (promote /
-- hold / rollback / retire / quarantine / no_action) based on deltas
-- against the last accepted eval for the same model. Review-only — the
-- AI eval lead approves promotions and retirements; the module never
-- automatically changes a model's stage.

CREATE TABLE IF NOT EXISTS clinical_ai_model_registry (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_key VARCHAR(160) NOT NULL,
  version VARCHAR(60) NOT NULL,
  provider VARCHAR(80),
  purpose VARCHAR(120),
  owner VARCHAR(160),
  stage VARCHAR(30) NOT NULL DEFAULT 'sandbox'
    CHECK (stage IN ('sandbox', 'staging', 'production', 'deprecated', 'quarantined', 'unknown')),
  parent_version VARCHAR(60),
  lineage JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'revoked', 'rejected', 'pending_retirement')),
  approval_note TEXT,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_model_registry_tenant_key_version
  ON clinical_ai_model_registry (tenant_id, model_key, version);
CREATE INDEX IF NOT EXISTS idx_model_registry_tenant_stage_created
  ON clinical_ai_model_registry (tenant_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_registry_tenant_approval_created
  ON clinical_ai_model_registry (tenant_id, approval_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_registry_tenant_owner_created
  ON clinical_ai_model_registry (tenant_id, owner, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_model_eval_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_registry_id INTEGER REFERENCES clinical_ai_model_registry(id) ON DELETE CASCADE,
  model_key VARCHAR(160) NOT NULL,
  version VARCHAR(60) NOT NULL,
  suite VARCHAR(120) NOT NULL,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  accuracy NUMERIC(6,4),
  f1_score NUMERIC(6,4),
  avg_latency_ms NUMERIC(10,2),
  fallback_rate_pct NUMERIC(6,2),
  safety_flag_rate_pct NUMERIC(6,2),
  drift_score NUMERIC(6,4),
  recommendation VARCHAR(30) NOT NULL DEFAULT 'no_action'
    CHECK (recommendation IN ('promote', 'hold', 'rollback', 'retire', 'no_action', 'quarantine', 'unknown')),
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_model_eval_tenant_created
  ON clinical_ai_model_eval_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_eval_tenant_model_version_created
  ON clinical_ai_model_eval_runs (tenant_id, model_key, version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_eval_tenant_recommendation_severity_created
  ON clinical_ai_model_eval_runs (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_eval_tenant_decision_created
  ON clinical_ai_model_eval_runs (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('model_registry_workbench',
   'Model Registry and Evaluation Workbench',
   'Central registry of every AI model variant the platform uses (name, version, provider, lineage, purpose, owner, lifecycle stage) plus an eval-run log capturing accuracy, F1, average latency, fallback rate, safety-flag rate, and drift score per suite. Rules are authoritative for recommending a lifecycle action (promote / hold / rollback / retire / quarantine / no_action) based on deltas against the last accepted eval for the same model. Review-only — AI eval lead approves promotions and retirements; the module never automatically changes a model''s stage.',
   false,
   '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","AI_EVAL_LEAD","AI_GOVERNANCE"],"approvalPolicy":"ai_eval_lead_review","outputSchema":{"type":"object","required":["recommendation","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'model_registry_workbench',
    'v1',
    'Model Registry and Evaluation Workbench v1',
    'You support the AI model registry and evaluation workbench. Rules are authoritative: the lifecycle recommendation (promote / hold / rollback / retire / quarantine / no_action) and severity are produced by a deterministic rule-based evaluator over the supplied eval-run metrics (accuracy, F1, average latency, fallback rate, safety-flag rate, drift score) and the previous accepted baseline for the same model. Return JSON only. This module is governance review only — it never automatically promotes, retires, or changes a model''s stage; the AI eval lead approves every lifecycle change.',
    'Given the model (model_key, version, provider, purpose, owner, current stage) and the latest eval-run metrics (suite, sample_count, accuracy, f1_score, avg_latency_ms, fallback_rate_pct, safety_flag_rate_pct, drift_score) plus the rule-based recommendation, severity, and matched signals, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation or severity, and do not invent new metrics beyond what was supplied.',
    '{"type":"object","required":["recommendation","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
