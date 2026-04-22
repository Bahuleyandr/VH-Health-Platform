-- Self-healing bug-hunt runner history. Read-only agent writes one row per
-- invocation with structured findings; it never mutates anything else. Rows
-- are tenant-scoped so the default tenant's audit trail can't be read by
-- other hospitals once onboarded.

CREATE TABLE IF NOT EXISTS clinical_ai_self_healing_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_by UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  scope VARCHAR(40) NOT NULL DEFAULT 'routine',
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_self_healing_runs_tenant_time
  ON clinical_ai_self_healing_runs(tenant_id, started_at DESC);
