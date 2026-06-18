-- 316_revenue_cycle_runs.sql
-- Unified revenue-cycle standing-queue tracker (Forward #3 core).
-- READ MODEL only — never auto-submits, never generates AI drafts.
-- A sweep service UPSERTs one row per case keyed by prior_auth_id.
-- Per-stage auto-generation triggers (coding→denial→PA threshold logic)
-- are DEFERRED — they require human-in-loop design decisions.

CREATE TABLE IF NOT EXISTS revenue_cycle_runs (
  id                   SERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_key             VARCHAR(120) NOT NULL,
  patient_uid          UUID,
  current_stage        VARCHAR(30)  NOT NULL DEFAULT 'prior_auth'
                         CHECK (current_stage IN ('coding','denial_risk','prior_auth','appeal','resolved','closed')),
  status               VARCHAR(20)  NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','resolved','closed')),
  payer_name           VARCHAR(200),
  claim_id             INTEGER,
  coding_generation_id INTEGER,
  denial_risk_generation_id INTEGER,
  prior_auth_id        INTEGER,
  appeal_id            INTEGER,
  stage_history        JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_revenue_cycle_runs_case
  ON revenue_cycle_runs (tenant_id, case_key);
CREATE INDEX IF NOT EXISTS idx_revenue_cycle_runs_tenant_stage
  ON revenue_cycle_runs (tenant_id, status, current_stage, last_evaluated_at DESC);

-- RLS: mirrors the canonical convention from migration 315 (USING + WITH CHECK,
-- FORCE RLS, GUC-reading tenant_id default). The bypass sentinel 'bypass' is
-- permissive so untenanted system queries and seeds continue to work.
ALTER TABLE revenue_cycle_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_cycle_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE revenue_cycle_runs
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DROP POLICY IF EXISTS tenant_isolation ON revenue_cycle_runs;
CREATE POLICY tenant_isolation ON revenue_cycle_runs
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  );
