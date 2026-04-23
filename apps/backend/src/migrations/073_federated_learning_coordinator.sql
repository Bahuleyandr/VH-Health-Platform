-- Federated Learning / Privacy-Preserving Training Layer.
--
-- Governance + coordination layer for federated / privacy-preserving
-- clinical ML training. Registers participating sites (with contact,
-- status, last_seen, differential-privacy epsilon budget, min cohort
-- size, accepted aggregation methods), tracks rounds (round_key,
-- model_key, start/end, participating sites, aggregation method,
-- privacy_budget_spent, round-level anomaly flags like data drift or
-- cohort shortfall), and classifies per-round readiness
-- (ready / hold / abort / review_privacy / no_action). Review-only —
-- AI governance + data engineering approve rounds; this module never
-- triggers training or transmits weights. Coordination + audit only.

CREATE TABLE IF NOT EXISTS clinical_ai_federation_sites (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_key VARCHAR(160) NOT NULL,
  display_name VARCHAR(200),
  region VARCHAR(80),
  contact VARCHAR(200),
  status VARCHAR(30) NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding', 'active', 'paused', 'withdrawn', 'quarantined', 'unknown')),
  dp_epsilon_budget NUMERIC(8,4) NOT NULL DEFAULT 10.0000,
  dp_epsilon_spent NUMERIC(8,4) NOT NULL DEFAULT 0.0000,
  min_cohort_size INTEGER NOT NULL DEFAULT 100,
  accepted_aggregation_methods JSONB NOT NULL DEFAULT '["fed_avg"]'::jsonb,
  last_seen_at TIMESTAMPTZ,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'revoked', 'rejected')),
  approval_note TEXT,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_federation_sites_tenant_key
  ON clinical_ai_federation_sites (tenant_id, site_key);
CREATE INDEX IF NOT EXISTS idx_federation_sites_tenant_status_created
  ON clinical_ai_federation_sites (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_federation_sites_tenant_approval_created
  ON clinical_ai_federation_sites (tenant_id, approval_status, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_federation_rounds (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  round_key VARCHAR(160) NOT NULL,
  model_key VARCHAR(160) NOT NULL,
  aggregation_method VARCHAR(40) NOT NULL DEFAULT 'fed_avg'
    CHECK (aggregation_method IN ('fed_avg', 'fed_prox', 'fed_sgd', 'secure_avg', 'differential_fed_avg', 'unknown')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  participant_site_count INTEGER NOT NULL DEFAULT 0,
  min_participants INTEGER NOT NULL DEFAULT 3,
  total_dp_epsilon_spent NUMERIC(8,4) NOT NULL DEFAULT 0.0000,
  cohort_total_size INTEGER NOT NULL DEFAULT 0,
  cohort_min_site_size INTEGER,
  data_drift_score NUMERIC(6,4),
  site_participation JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  recommendation VARCHAR(30) NOT NULL DEFAULT 'no_action'
    CHECK (recommendation IN ('ready', 'hold', 'abort', 'review_privacy', 'no_action', 'unknown')),
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

CREATE UNIQUE INDEX IF NOT EXISTS uniq_federation_rounds_tenant_round_model
  ON clinical_ai_federation_rounds (tenant_id, round_key, model_key);
CREATE INDEX IF NOT EXISTS idx_federation_rounds_tenant_rec_sev_created
  ON clinical_ai_federation_rounds (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_federation_rounds_tenant_model_created
  ON clinical_ai_federation_rounds (tenant_id, model_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_federation_rounds_tenant_decision_created
  ON clinical_ai_federation_rounds (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('federated_learning_coordinator',
   'Federated Learning / Privacy-Preserving Training Layer',
   'Governance + coordination layer for federated / privacy-preserving clinical ML training. Registers participating sites (contact, status, last_seen, differential-privacy epsilon budget, min cohort size, accepted aggregation methods) and tracks rounds (participant count, aggregation method, DP ε spent, cohort sizes, data-drift score). Classifies round readiness as `ready` / `hold` / `abort` / `review_privacy` / `no_action` based on participant count vs min, DP budget headroom, min site cohort vs floor, and drift score. Rules are authoritative; review-only — AI governance + data engineering approve rounds; the module never triggers training or transmits weights. Coordination + audit only.',
   false,
   '{"surface":"governance","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","AI_EVAL_LEAD","AI_GOVERNANCE","DATA_ENGINEER"],"approvalPolicy":"ai_governance_review","outputSchema":{"type":"object","required":["recommendation","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true,"noTrainingExecution":true}'::jsonb)
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
    'federated_learning_coordinator',
    'v1',
    'Federated Learning Coordinator v1',
    'You support the federated learning / privacy-preserving training coordinator. Rules are authoritative: the round recommendation (ready / hold / abort / review_privacy / no_action) and severity are produced by a deterministic rule-based evaluator over the supplied round metrics (participant count vs min, aggregation method, differential-privacy epsilon spent vs budget, cohort totals and per-site minimums vs floor, data-drift score). Return JSON only. This module is governance + audit only — it never triggers training, transmits weights, or promotes a round; AI governance plus data engineering approve every round.',
    'Given the round (round_key, model_key, aggregation method, participant count, started_at / ended_at, site participation) and the rule-based recommendation, severity, and matched signals, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation or severity, and do not invent new metrics beyond what was supplied.',
    '{"type":"object","required":["recommendation","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
