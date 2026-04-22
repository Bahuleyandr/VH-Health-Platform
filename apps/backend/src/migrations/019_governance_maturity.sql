-- Governance maturity: prompt A/B experiments + drift canary runs.
-- Both tables are tenant-scoped so multi-tenant SaaS never leaks experiment
-- telemetry across hospitals.

CREATE TABLE IF NOT EXISTS clinical_ai_prompt_experiments (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key VARCHAR(80) NOT NULL,
  name VARCHAR(200) NOT NULL,
  variant_a_prompt_id INTEGER NOT NULL REFERENCES clinical_ai_prompts(id) ON DELETE CASCADE,
  variant_b_prompt_id INTEGER NOT NULL REFERENCES clinical_ai_prompts(id) ON DELETE CASCADE,
  traffic_split_a NUMERIC(3, 2) NOT NULL DEFAULT 0.5 CHECK (traffic_split_a >= 0.0 AND traffic_split_a <= 1.0),
  status VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('draft', 'running', 'paused', 'concluded')),
  started_by UUID,
  started_at TIMESTAMPTZ,
  concluded_at TIMESTAMPTZ,
  winning_variant VARCHAR(1),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (variant_a_prompt_id <> variant_b_prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_prompt_experiments_tenant_module
  ON clinical_ai_prompt_experiments (tenant_id, module_key, status);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_prompt_experiments_running
  ON clinical_ai_prompt_experiments (tenant_id, module_key)
  WHERE status = 'running';

-- Assignments link each draft generation to the experiment + variant it
-- was drawn from, so stats can roll up per variant without double-joining.
CREATE TABLE IF NOT EXISTS clinical_ai_prompt_assignments (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experiment_id INTEGER NOT NULL REFERENCES clinical_ai_prompt_experiments(id) ON DELETE CASCADE,
  generation_id INTEGER NOT NULL REFERENCES clinical_ai_generations(id) ON DELETE CASCADE,
  variant VARCHAR(1) NOT NULL CHECK (variant IN ('A', 'B')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (generation_id)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_prompt_assignments_experiment
  ON clinical_ai_prompt_assignments (experiment_id, variant);

-- Drift canary: fixed test set of (module_key, input, expected signatures).
-- Runner scores each case against the current prompt + defenses and emits
-- a drift report when acceptance or citation coverage drifts past a
-- configurable threshold.
CREATE TABLE IF NOT EXISTS clinical_ai_canary_cases (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key VARCHAR(80) NOT NULL,
  label VARCHAR(160) NOT NULL,
  input_packet JSONB NOT NULL,
  expected_keys TEXT[] NOT NULL DEFAULT '{}',
  expected_citations_min INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, module_key, label)
);

CREATE TABLE IF NOT EXISTS clinical_ai_canary_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_scope VARCHAR(40) NOT NULL DEFAULT 'routine',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  total_cases INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  drift_detected BOOLEAN NOT NULL DEFAULT false,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_canary_runs_tenant_time
  ON clinical_ai_canary_runs (tenant_id, started_at DESC);
