-- Clinical trial catalog sync history. Lets ops see when the registry
-- was last pulled, how many trials were upserted, and any errors.

CREATE TABLE IF NOT EXISTS clinical_ai_trial_sync_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source VARCHAR(60) NOT NULL DEFAULT 'clinicaltrials_gov_v2',
  query_conditions TEXT[] NOT NULL DEFAULT '{}',
  query_location VARCHAR(60),
  requested_by UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  fetched_count INTEGER NOT NULL DEFAULT 0,
  upserted_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_trial_sync_runs_tenant_time
  ON clinical_ai_trial_sync_runs (tenant_id, started_at DESC);
