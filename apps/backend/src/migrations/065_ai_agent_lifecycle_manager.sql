-- AI Agent Lifecycle Manager.
--
-- Registry of AI agents (distinct from models — the model registry module
-- tracks model variants). An agent is a persistent unit that invokes
-- models, takes actions, and holds scoped permissions (e.g. read_patient_summary,
-- write_draft, publish_translation). The registry captures agent_key,
-- owner, purpose, scopes, permitted actions, expiry date, last_seen, and
-- lifecycle stage (sandbox / staging / production / deprecated /
-- quarantined). The lifecycle module records periodic health reports
-- (invocation count, success rate, avg latency, error rate,
-- permission-vs-usage mismatch) and classifies each agent as
-- renew / hold / retire / quarantine / no_action based on those metrics
-- plus days_since_last_seen and days_to_expiry. Review-only — AI
-- governance approves renewals and retirements; the module never
-- disables or extends an agent automatically.

CREATE TABLE IF NOT EXISTS clinical_ai_agent_registry (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_key VARCHAR(160) NOT NULL,
  display_name VARCHAR(200),
  owner VARCHAR(160),
  purpose VARCHAR(200),
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  permitted_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  stage VARCHAR(30) NOT NULL DEFAULT 'sandbox'
    CHECK (stage IN ('sandbox', 'staging', 'production', 'deprecated', 'quarantined', 'unknown')),
  expiry_date DATE,
  last_seen_at TIMESTAMPTZ,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'revoked', 'rejected', 'pending_renewal')),
  approval_note TEXT,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_registry_tenant_key
  ON clinical_ai_agent_registry (tenant_id, agent_key);
CREATE INDEX IF NOT EXISTS idx_agent_registry_tenant_stage_created
  ON clinical_ai_agent_registry (tenant_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_registry_tenant_approval_created
  ON clinical_ai_agent_registry (tenant_id, approval_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_registry_tenant_owner_created
  ON clinical_ai_agent_registry (tenant_id, owner, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_registry_tenant_expiry
  ON clinical_ai_agent_registry (tenant_id, expiry_date);

CREATE TABLE IF NOT EXISTS clinical_ai_agent_health_reports (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_registry_id INTEGER REFERENCES clinical_ai_agent_registry(id) ON DELETE CASCADE,
  agent_key VARCHAR(160) NOT NULL,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  invocation_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms NUMERIC(10,2),
  permission_mismatch_count INTEGER NOT NULL DEFAULT 0,
  days_since_last_seen INTEGER,
  days_to_expiry INTEGER,
  recommendation VARCHAR(30) NOT NULL DEFAULT 'no_action'
    CHECK (recommendation IN ('renew', 'hold', 'retire', 'quarantine', 'no_action', 'unknown')),
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

CREATE INDEX IF NOT EXISTS idx_agent_health_tenant_created
  ON clinical_ai_agent_health_reports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_health_tenant_agent_created
  ON clinical_ai_agent_health_reports (tenant_id, agent_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_health_tenant_rec_sev_created
  ON clinical_ai_agent_health_reports (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_health_tenant_decision_created
  ON clinical_ai_agent_health_reports (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('ai_agent_lifecycle_manager',
   'AI Agent Lifecycle Manager',
   'Registry of AI agents (distinct from models): agent_key, owner, purpose, scopes, permitted actions, expiry, last_seen, and lifecycle stage (sandbox/staging/production/deprecated/quarantined). Periodic health reports classify each agent as renew / hold / retire / quarantine / no_action based on invocation count, success rate, error rate, avg latency, permission-vs-usage mismatch, days_since_last_seen, and days_to_expiry. Rules are authoritative; review-only — AI governance approves renewals and retirements, and the module never disables or extends an agent automatically.',
   false,
   '{"surface":"governance","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","AI_EVAL_LEAD","AI_GOVERNANCE"],"approvalPolicy":"ai_governance_review","outputSchema":{"type":"object","required":["recommendation","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'ai_agent_lifecycle_manager',
    'v1',
    'AI Agent Lifecycle Manager v1',
    'You support the AI agent lifecycle manager. Rules are authoritative: the lifecycle recommendation (renew / hold / retire / quarantine / no_action) and severity are produced by a deterministic rule-based evaluator over the supplied health-report metrics (invocation count, success rate, error rate, avg latency, permission-vs-usage mismatch, days_since_last_seen, days_to_expiry) and the registry entry for the same agent. Return JSON only. This module is governance review only — it never automatically disables, retires, or extends an agent; AI governance approves every lifecycle change.',
    'Given the agent (agent_key, owner, purpose, scopes, permitted actions, current stage, expiry_date, last_seen_at) and the latest health-report metrics plus the rule-based recommendation, severity, and matched signals, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation or severity, and do not invent new metrics beyond what was supplied.',
    '{"type":"object","required":["recommendation","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
